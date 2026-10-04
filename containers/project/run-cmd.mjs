#!/usr/bin/env node
// Trusted helper: runs one command from the project registry in the workspace.
//
// The platform passes the argv after `--`; it comes from the reviewed project
// registry, never from agent input. Output is capped at --max-output bytes with
// a labelled truncation note. On timeout the whole process group is killed.
// Prints one JSON line: {exitCode, signal, timedOut, durationMs, truncated, output}.
//
// Usage: node run-cmd.mjs [--timeout-ms N] [--max-output N] [--workspace /workspace] -- <argv...>
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 900_000;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) fail('pass the command after --');
  const opts = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxOutput = 32 * 1024;
  let workspace = '/workspace';
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i] === '--timeout-ms' && opts[i + 1]) timeoutMs = Number(opts[++i]);
    else if (opts[i] === '--max-output' && opts[i + 1]) maxOutput = Number(opts[++i]);
    else if (opts[i] === '--workspace' && opts[i + 1]) workspace = resolve(opts[++i]);
    else fail(`unknown argument ${opts[i]}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) fail('invalid --timeout-ms');
  if (!Number.isInteger(maxOutput) || maxOutput < 1024 || maxOutput > 4 * 1024 * 1024) fail('invalid --max-output');
  return { command, timeoutMs, maxOutput, workspace };
}

function main() {
  const { command, timeoutMs, maxOutput, workspace } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const chunks = [];
  let kept = 0;
  let omitted = 0;
  let timedOut = false;
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace,
    detached: true, // own process group: a timeout kills every descendant
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      WRANGLER_SEND_METRICS: 'false',
      COREPACK_ENABLE_STRICT: '0',
    },
  });
  const collect = (chunk) => {
    const room = maxOutput - kept;
    if (room <= 0) {
      omitted += chunk.length;
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks.push(slice);
    kept += slice.length;
    omitted += chunk.length - slice.length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, timeoutMs);
  child.on('error', (err) => {
    clearTimeout(timer);
    fail(`cannot start command: ${err.message}`);
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    try {
      process.kill(-child.pid, 'SIGKILL'); // reap anything the command left behind
    } catch {}
    let output = Buffer.concat(chunks).toString('utf8');
    if (omitted > 0) output += `\n[output truncated: ${omitted} more bytes not shown]`;
    process.stdout.write(
      `${JSON.stringify({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, truncated: omitted > 0, output })}\n`,
    );
  });
}

main();

#!/usr/bin/env node
// Trusted helper: runs one allowlisted developer tool in the workspace.
//
// Tools: typecheck, unit, build. No other command can run through this helper.
// Output (stdout+stderr, interleaved) is capped at 32 KiB with a labelled
// truncation note. On timeout the whole process group is killed.
// Prints one JSON line: {tool, exitCode, signal, timedOut, durationMs, truncated, output}.
//
// Usage: node run-tool.mjs <typecheck|unit|build> [--timeout-ms N] [--workspace /workspace]
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const TOOLS = {
  typecheck: ['node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.json']],
  unit: ['node_modules/.bin/vitest', ['run']],
  build: [process.execPath, ['build.mjs']],
};

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const [tool, ...rest] = argv;
  if (!Object.hasOwn(TOOLS, tool ?? '')) fail(`tool must be one of ${Object.keys(TOOLS).join(', ')}`);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let workspace = '/workspace';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--timeout-ms' && rest[i + 1]) {
      timeoutMs = Number(rest[++i]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) fail('invalid --timeout-ms');
    } else if (rest[i] === '--workspace' && rest[i + 1]) {
      workspace = resolve(rest[++i]);
    } else {
      fail(`unknown argument ${rest[i]}`);
    }
  }
  return { tool, timeoutMs, workspace };
}

function main() {
  const { tool, timeoutMs, workspace } = parseArgs(process.argv.slice(2));
  const [command, args] = TOOLS[tool];
  const started = Date.now();
  const chunks = [];
  let kept = 0;
  let omitted = 0;
  let timedOut = false;

  const child = spawn(command, args, {
    cwd: workspace,
    detached: true, // new process group, so a timeout kills every descendant
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      NODE_ENV: 'test',
    },
  });

  const collect = (chunk) => {
    const room = MAX_OUTPUT_BYTES - kept;
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

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGKILL');
  }, timeoutMs);

  child.on('error', (err) => {
    clearTimeout(timer);
    fail(`could not start ${tool}: ${err.message}`);
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    killGroup('SIGKILL'); // reap any background descendants
    let output = Buffer.concat(chunks).toString('utf8');
    if (omitted > 0) output += `\n[output truncated: ${omitted} more bytes omitted]`;
    if (timedOut) output += `\n[killed: exceeded ${timeoutMs} ms]`;
    process.stdout.write(
      `${JSON.stringify({ tool, exitCode: code, signal, timedOut, durationMs: Date.now() - started, truncated: omitted > 0, output })}\n`,
    );
    process.exit(0);
  });
}

main();

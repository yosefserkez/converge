#!/usr/bin/env node
// Trusted helper: replaces the workspace source with a verified SourceBundle.
//
// Reads SourceBundle JSON from stdin, validates every path, and verifies each
// file's sha256 digest. It then deletes every top-level entry of the workspace
// except the kept ones (node_modules by default) and writes the files.
// Prints one JSON line: {ok, files, bytes} or {ok:false, error}.
//
// Usage: node load-source.mjs [--workspace /workspace] [--keep node_modules] < bundle.json
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_PATH_LENGTH = 240;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let workspace = '/workspace';
  const keep = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace' && argv[i + 1]) workspace = argv[++i];
    else if (argv[i] === '--keep' && argv[i + 1]) keep.add(argv[++i]);
    else fail(`unknown argument ${argv[i]}`);
  }
  if (keep.size === 0) keep.add('node_modules');
  return { workspace: resolve(workspace), keep };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BUNDLE_BYTES) fail(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Same rules as RepoPath in @converge/domain; kept top-level names are reserved. */
function validatePath(path, keep) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return 'path length';
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return 'absolute or invalid characters';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) return 'traversal or .git segment';
  if (keep.has(segments[0])) return `reserved top-level ${segments[0]}`;
  return null;
}

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function main() {
  const { workspace, keep } = parseArgs(process.argv.slice(2));
  let bundle;
  try {
    bundle = JSON.parse(await readStdin());
  } catch {
    fail('bundle is not valid JSON');
  }
  if (!bundle || bundle.schemaVersion !== 1 || !Array.isArray(bundle.files)) fail('not a SourceBundle');
  if (bundle.files.length > MAX_FILES) fail(`too many files (${bundle.files.length})`);
  const prepared = [];
  const seen = new Set();
  for (const f of bundle.files) {
    const problem = validatePath(f?.path, keep);
    if (problem) fail(`invalid path ${JSON.stringify(f?.path)}: ${problem}`);
    if (seen.has(f.path)) fail(`duplicate path ${f.path}`);
    seen.add(f.path);
    const bytes = Buffer.from(String(f.utf8 ?? ''), 'utf8');
    if (sha256(bytes) !== f.sha256) fail(`digest mismatch for ${f.path}`);
    const target = resolve(workspace, f.path);
    if (!target.startsWith(workspace + sep)) fail(`path escapes workspace: ${f.path}`);
    prepared.push({ target, bytes });
  }
  await mkdir(workspace, { recursive: true });
  for (const entry of await readdir(workspace)) {
    if (!keep.has(entry)) await rm(join(workspace, entry), { recursive: true, force: true });
  }
  let total = 0;
  for (const { target, bytes } of prepared) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    total += bytes.length;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, files: prepared.length, bytes: total })}\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

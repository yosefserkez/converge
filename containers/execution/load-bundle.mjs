#!/usr/bin/env node
// Trusted helper: materializes a SourceBundle into the workspace.
//
// Reads SourceBundle JSON from stdin, validates every path, verifies each
// file's sha256 digest of its UTF-8 bytes, writes the files into a cleared
// workspace, and links the image's preinstalled node_modules.
// Prints one JSON line: {ok, files, bytes, lockfileMatchesImage} or {ok:false, error}.
//
// Usage: node load-bundle.mjs [--workspace /workspace] < bundle.json
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_PATH_LENGTH = 240;
const STOREFRONT_DIR = process.env.CONVERGE_STOREFRONT_DIR ?? '/opt/storefront';
const RESERVED_TOP_LEVEL = new Set(['node_modules', '.git']);

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let workspace = '/workspace';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace' && argv[i + 1]) workspace = argv[++i];
    else fail(`unknown argument ${argv[i]}`);
  }
  return { workspace: resolve(workspace) };
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

/** Same rules as RepoPath in @converge/domain, plus reserved top-level names. */
function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return 'path length';
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return 'absolute or invalid characters';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) return 'traversal or .git segment';
  if (RESERVED_TOP_LEVEL.has(segments[0])) return `reserved top-level ${segments[0]}`;
  return null;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function clearDirectory(dir) {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
}

async function main() {
  const { workspace } = parseArgs(process.argv.slice(2));
  let bundle;
  try {
    bundle = JSON.parse(await readStdin());
  } catch {
    fail('stdin is not valid JSON');
  }
  if (typeof bundle !== 'object' || bundle === null || bundle.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof bundle.baselineSha !== 'string' || !/^[0-9a-f]{40}$/.test(bundle.baselineSha)) fail('invalid baselineSha');
  if (!Array.isArray(bundle.files) || bundle.files.length === 0 || bundle.files.length > MAX_FILES) fail(`files must hold 1..${MAX_FILES} entries`);

  const seen = new Set();
  const prepared = [];
  for (const file of bundle.files) {
    if (typeof file !== 'object' || file === null) fail('file entry must be an object');
    const problem = validatePath(file.path);
    if (problem) fail(`rejected path ${JSON.stringify(String(file.path).slice(0, 80))}: ${problem}`);
    const key = file.path.toLowerCase();
    if (seen.has(key)) fail(`duplicate path ${file.path}`);
    seen.add(key);
    if (typeof file.utf8 !== 'string') fail(`utf8 missing for ${file.path}`);
    if (file.base64 !== undefined) fail(`binary file not supported: ${file.path}`);
    if (typeof file.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(file.sha256)) fail(`invalid digest for ${file.path}`);
    const bytes = Buffer.from(file.utf8, 'utf8');
    if (sha256(bytes) !== file.sha256) fail(`digest mismatch for ${file.path}`);
    const target = resolve(workspace, file.path);
    if (!target.startsWith(workspace + sep)) fail(`path escapes workspace: ${file.path}`);
    prepared.push({ path: file.path, target, bytes });
  }

  await clearDirectory(workspace);
  let total = 0;
  for (const { target, bytes } of prepared) {
    await mkdir(dirname(target), { recursive: true });
    // 'wx' refuses to follow or overwrite anything already present.
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    total += bytes.length;
  }
  await symlink(join(STOREFRONT_DIR, 'node_modules'), join(workspace, 'node_modules'), 'dir');

  let lockfileMatchesImage;
  try {
    const baked = await readFile(join(STOREFRONT_DIR, 'package-lock.json'));
    const loaded = prepared.find((f) => f.path === 'package-lock.json');
    lockfileMatchesImage = loaded !== undefined && sha256(baked) === sha256(loaded.bytes);
  } catch {
    lockfileMatchesImage = false;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, files: prepared.length, bytes: total, lockfileMatchesImage })}\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

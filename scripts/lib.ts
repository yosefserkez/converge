// Shared helpers for the operator scripts. They never print secret values.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type EnvName = 'dev' | 'prod';

export interface Args {
  env: EnvName;
  apply: boolean;
  dryRun: boolean;
  flags: Set<string>;
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const envIndex = argv.indexOf('--env');
  const env = envIndex >= 0 ? argv[envIndex + 1] : undefined;
  if (env !== 'dev' && env !== 'prod') fail('pass --env dev or --env prod');
  const apply = flags.has('--apply');
  return { env, apply, dryRun: !apply, flags };
}

/** Load KEY=VALUE pairs from the gitignored .env.local into process.env (existing values win). */
export function loadEnvLocal(): void {
  const file = join(ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set (put it in .env.local or the environment)`);
  return v;
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

/** Cloudflare REST API call with the developer token. Throws with the API's error messages. */
export async function cf<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const account = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const url = path.startsWith('/accounts/') || path.startsWith('/user') ? path : `/accounts/${account}${path}`;
  const res = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await res.json()) as { success: boolean; errors?: Array<{ message: string }>; result: T };
  if (!body.success) throw new Error(`${init.method ?? 'GET'} ${path}: ${(body.errors ?? []).map((e) => e.message).join('; ') || res.status}`);
  return body.result;
}

/** Run a command with argv (no shell). Returns stdout; exits on failure unless allowFailure. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string; allowFailure?: boolean; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: 'utf8',
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!opts.quiet && r.stdout) process.stdout.write(r.stdout);
  if (!opts.quiet && r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !opts.allowFailure) fail(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Strip // and /* *\/ comments from JSONC (wrangler configs contain no comment-like strings). */
export function readJsonc<T = Record<string, unknown>>(file: string): T {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(text) as T;
}

export const ENVIRONMENTS: Record<EnvName, { control: string; preview: string; bucket: string; namespace: string; config: string }> = {
  dev: { control: 'converge-dev', preview: 'converge-preview-dev', bucket: 'converge-evidence-dev', namespace: 'converge-dev', config: 'wrangler.dev.jsonc' },
  prod: { control: 'converge', preview: 'converge-preview', bucket: 'converge-evidence', namespace: 'converge', config: 'wrangler.prod.jsonc' },
};

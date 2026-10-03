// Build with the Cloudflare Vite plugin and deploy its generated output config.
//   pnpm deploy:dev | pnpm deploy:prod
// Order: control Worker (and its container images), secrets, then the preview gateway.
// Refuses local auth, missing Access settings, and missing secrets.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENVIRONMENTS, ROOT, fail, loadEnvLocal, parseArgs, readJsonc, requireEnv, run, step } from './lib.ts';

loadEnvLocal();
const args = parseArgs();
const names = ENVIRONMENTS[args.env];
requireEnv('CLOUDFLARE_API_TOKEN');
requireEnv('CLOUDFLARE_ACCOUNT_ID');

step('Validate configuration');
const controlDir = join(ROOT, 'apps/control');
const previewDir = join(ROOT, 'apps/preview');
const cfg = readJsonc<{ name: string; vars: Record<string, string> }>(join(controlDir, names.config));
if (cfg.name !== names.control) fail(`${names.config} names ${cfg.name}, expected ${names.control}`);
const v = cfg.vars;
if (v.ENVIRONMENT !== args.env) fail(`ENVIRONMENT must be ${args.env}`);
if (v.AUTH_MODE !== 'access') fail('deployments require AUTH_MODE=access (local auth is never deployed)');
if (!v.ACCESS_ISSUER || !v.ACCESS_AUD || !v.OPERATOR_SUBJECTS) fail('run pnpm provision --env ' + args.env + ' --apply first');
if (v.REPO_HOST !== 'artifacts') fail('deployments require REPO_HOST=artifacts');
for (const k of Object.keys(v)) if (k.startsWith('VITE_')) fail(`no VITE_* variables may hold configuration (${k})`);
const signingKey = requireEnv(`PREVIEW_SIGNING_KEY_${args.env.toUpperCase()}`);
if (signingKey.length < 32) fail('preview signing key is too short');
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
if (v.LIVE_EXECUTION_ENABLED === 'true' && !anthropicKey) fail('LIVE_EXECUTION_ENABLED=true needs ANTHROPIC_API_KEY');

const sha = run('git', ['rev-parse', '--short=12', 'HEAD'], { quiet: true }).stdout.trim();
const dirty = run('git', ['status', '--porcelain'], { quiet: true }).stdout.trim() ? '-dirty' : '';
const buildId = `${sha}${dirty}`;
console.log(`build id: ${buildId}`);

const buildEnv = { CONVERGE_WRANGLER_CONFIG: names.config };

step('Build control Worker and SPA');
run('pnpm', ['exec', 'vite', 'build'], { cwd: controlDir, env: buildEnv });
// vite build copies local .dev.vars next to the output for `vite preview`; it is never deployed, so remove it.
rmSync(join(controlDir, 'dist', names.control.replace(/-/g, '_'), '.dev.vars'), { force: true });

step('Deploy control Worker with secrets (builds and pushes container images)');
const secrets: Record<string, string> = { PREVIEW_SIGNING_KEY: signingKey, ANTHROPIC_API_KEY: anthropicKey };
// The secrets file lives in a private temp dir (mode 600) and is removed right after the deploy.
const secretDir = mkdtempSync(join(tmpdir(), 'converge-secrets-'));
const secretFile = join(secretDir, 'secrets.json');
try {
  writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
  run('pnpm', ['exec', 'wrangler', 'deploy', '--var', `BUILD_ID:${buildId}`, '--secrets-file', secretFile], { cwd: controlDir });
} finally {
  rmSync(secretDir, { recursive: true, force: true });
}

step('Build and deploy preview gateway');
run('pnpm', ['exec', 'vite', 'build'], { cwd: previewDir, env: buildEnv });
run('pnpm', ['exec', 'wrangler', 'deploy'], { cwd: previewDir });

console.log(`\nDeployed ${args.env}:`);
console.log(`  operator: ${v.CONTROL_ORIGIN}`);
console.log(`  preview:  ${v.PREVIEW_ORIGIN}`);
console.log(`  build id: ${buildId}`);
console.log(`Next: pnpm seed --env ${args.env} && pnpm smoke --env ${args.env}`);

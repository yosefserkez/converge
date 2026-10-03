// Check toolchain, generated types, Docker, the Cloudflare account, and model
// configuration. It makes no paid model calls: the model check lists models only.
//   pnpm preflight
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cf, loadEnvLocal, readJsonc, run, step } from './lib.ts';

loadEnvLocal();
const rows: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${detail}`);
};

step('Toolchain');
const node = process.versions.node;
check('node >= 22.12', Number(node.split('.')[0]) >= 22, node);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
const wranglerVersion = run('pnpm', ['exec', 'wrangler', '--version'], { quiet: true, allowFailure: true }).stdout.trim();
check('wrangler >= 4.145.0 (Artifacts types)', /4\.(14[5-9]|1[5-9]\d|[2-9]\d\d)\./.test(wranglerVersion), wranglerVersion || 'missing');
check('wrangler pinned', pkg.devDependencies.wrangler === '4.147.0', pkg.devDependencies.wrangler ?? 'unpinned');
check('lockfile committed', existsSync(join(ROOT, 'pnpm-lock.yaml')), 'pnpm-lock.yaml');
const docker = run('docker', ['info', '--format', '{{.ServerVersion}} {{.Architecture}}'], { quiet: true, allowFailure: true });
check('docker engine (container image builds)', docker.status === 0, docker.stdout.trim() || 'not running');

step('Generated binding types');
for (const app of ['control', 'preview']) {
  const file = join(ROOT, 'apps', app, 'worker-configuration.d.ts');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check(`${app} worker-configuration.d.ts`, text.length > 0, text ? 'present' : 'run pnpm --filter @converge/' + app + ' types');
}
const controlTypes = readFileSync(join(ROOT, 'apps/control/worker-configuration.d.ts'), 'utf8');
check('Artifacts binding type generated', /ARTIFACTS: Artifacts/.test(controlTypes), 'ARTIFACTS: Artifacts');

step('Cloudflare account');
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  check('Cloudflare credentials', false, 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env.local');
} else {
  const probe = async (name: string, path: string) => {
    try {
      await cf(path);
      check(name, true, 'reachable');
    } catch (e) {
      check(name, false, (e as Error).message.slice(0, 160));
    }
  };
  const acct = await cf<{ name: string }>('').catch(() => null);
  check('account', Boolean(acct), acct?.name ?? 'unreachable');
  await probe('workers.dev subdomain', '/workers/subdomain');
  await probe('Workflows', '/workflows');
  await probe('R2', '/r2/buckets');
  await probe('Artifacts namespaces', '/artifacts/namespaces');
  await probe('Containers (Workers Paid)', '/containers/applications');
  await probe('Zero Trust Access', '/access/organizations');
}

step('Model configuration (no paid calls)');
const vars = readJsonc<{ vars: Record<string, string> }>(join(ROOT, 'apps/control/wrangler.dev.jsonc')).vars;
const modelId = vars.MODEL_ID ?? '';
check('live execution flag', true, `LIVE_EXECUTION_ENABLED=${vars.LIVE_EXECUTION_ENABLED}, budget ${Number(vars.DEFAULT_MODEL_BUDGET_MICROUSD) / 1e6} USD per session`);
if (process.env.ANTHROPIC_API_KEY) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  });
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  // The models list shows dated IDs; an undated alias such as claude-haiku-4-5 matches its dated form.
  check(`model ${modelId} available to this key`, Boolean(body.data?.some((m) => m.id === modelId || m.id.startsWith(`${modelId}-`))), res.ok ? 'listed' : `HTTP ${res.status}`);
} else {
  check('ANTHROPIC_API_KEY', false, 'not set; live sessions stay disabled');
}

const failed = rows.filter(([, ok]) => !ok);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed`);
process.exit(failed.length ? 1 : 0);

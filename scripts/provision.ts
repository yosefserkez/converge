// Create or reuse only the resources this project owns, for one environment.
//   pnpm provision --env dev --dry-run   (default: print the plan)
//   pnpm provision --env dev --apply
// Artifacts namespaces are created on first repository create, so this script
// does not need a namespace-create command. It does not touch other resources.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENVIRONMENTS, ROOT, cf, fail, loadEnvLocal, parseArgs, readJsonc, requireEnv, step } from './lib.ts';

loadEnvLocal();
const args = parseArgs();
const names = ENVIRONMENTS[args.env];
const operatorEmail = process.env.CONVERGE_OPERATOR_EMAIL ?? fail('set CONVERGE_OPERATOR_EMAIL (the operator allowed through Access)');

step(`Account check (${args.dryRun ? 'dry run' : 'apply'})`);
const account = await cf<{ id: string; name: string }>('');
console.log(`account: ${account.name} (${account.id})`);
const sub = await cf<{ subdomain: string }>('/workers/subdomain');
const controlHost = `${names.control}.${sub.subdomain}.workers.dev`;
const previewHost = `${names.preview}.${sub.subdomain}.workers.dev`;
console.log(`control origin: https://${controlHost}\npreview origin: https://${previewHost}`);

step(`R2 bucket ${names.bucket}`);
const buckets = await cf<{ buckets: Array<{ name: string }> }>('/r2/buckets');
if (buckets.buckets.some((b) => b.name === names.bucket)) {
  console.log('exists: reuse');
} else if (args.apply) {
  await cf('/r2/buckets', { method: 'POST', body: JSON.stringify({ name: names.bucket }) });
  console.log('created (private; no public access)');
} else {
  console.log('would create (private)');
}

step(`Access application for ${controlHost}`);
const org = await cf<{ auth_domain: string }>('/access/organizations');
const issuer = `https://${org.auth_domain}`;
const apps = await cf<Array<{ id: string; domain: string; aud: string; name: string }>>('/access/apps');
let app = apps.find((a) => a.domain === controlHost);
if (app) {
  console.log(`exists: ${app.name} (reuse)`);
} else if (args.apply) {
  app = await cf('/access/apps', {
    method: 'POST',
    body: JSON.stringify({
      type: 'self_hosted',
      name: `Converge operator (${args.env})`,
      domain: controlHost,
      session_duration: '8h',
      app_launcher_visible: false,
      policies: [{ name: 'Converge operators', decision: 'allow', include: [{ email: { email: operatorEmail } }] }],
    }),
  });
  console.log(`created: ${app!.name}`);
} else {
  console.log(`would create an Access app allowing ${operatorEmail}`);
}

step('Wrangler configuration');
const configPath = join(ROOT, 'apps/control', names.config);
const vars = (readJsonc<{ vars: Record<string, string> }>(configPath)).vars;
const wanted: Record<string, string> = {
  ENVIRONMENT: args.env,
  AUTH_MODE: 'access',
  ACCESS_ISSUER: issuer,
  ACCESS_AUD: app?.aud ?? '<created on apply>',
  OPERATOR_SUBJECTS: operatorEmail,
  CONTROL_ORIGIN: `https://${controlHost}`,
  PREVIEW_ORIGIN: `https://${previewHost}`,
};
const changes = Object.entries(wanted).filter(([k, v]) => vars[k] !== v);
for (const [k, v] of changes) console.log(`${k}: ${vars[k] ?? '(unset)'} -> ${v}`);
if (changes.length === 0) console.log('up to date');
if (args.apply && changes.length && app) {
  let text = readFileSync(configPath, 'utf8');
  for (const [k, v] of changes) {
    const re = new RegExp(`("${k}":\\s*)"[^"]*"`);
    if (!re.test(text)) fail(`${k} is missing from ${names.config}; add it once by hand`);
    text = text.replace(re, `$1${JSON.stringify(v)}`);
  }
  writeFileSync(configPath, text);
  console.log(`updated ${names.config}`);
}

step('Secrets');
requireEnv('CLOUDFLARE_API_TOKEN');
const signingVar = `PREVIEW_SIGNING_KEY_${args.env.toUpperCase()}`;
console.log(`${signingVar}: ${process.env[signingVar] ? 'present in .env.local' : 'missing: run `openssl rand -base64 48` and add it to .env.local'}`);
console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'present in .env.local' : 'missing (live agents stay disabled)'}`);
console.log('pnpm deploy:' + args.env + ' uploads both as Worker secrets.');
if (args.dryRun) console.log('\nDry run only. Re-run with --apply to make these changes.');

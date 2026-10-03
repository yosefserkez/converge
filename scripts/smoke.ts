// Real smoke test against a deployed environment.
//   pnpm smoke --env dev                 health, auth, project, preview gateway
//   pnpm smoke --env dev --fixture-run   plus a full fixture session (no model calls)
//   pnpm smoke --env dev --fixture-run --promote   plus approval and guarded promotion
// It reports what it observed. It does not mark a step as passed unless the API confirms it.
import { apiFor, sleep } from './api.ts';
import { ENVIRONMENTS, ROOT, fail, loadEnvLocal, parseArgs, readJsonc, step } from './lib.ts';
import { join } from 'node:path';

loadEnvLocal();
const args = parseArgs();
const api = apiFor(args.env);
const vars = readJsonc<{ vars: Record<string, string> }>(join(ROOT, 'apps/control', ENVIRONMENTS[args.env].config)).vars;
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail = '') => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` - ${detail}` : ''}`);
};

step('Unauthenticated access is refused');
const anon = await fetch(`${api.origin}/api/project`, { redirect: 'manual' });
record('operator API requires Access', anon.status === 302 || anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);

step('Health, config, project');
const health = await api.get('/healthz');
record('health', health.ok === true, `build ${health.buildId}`);
const config = await api.get('/api/config');
record('config', config.authMode === 'access', `auth ${config.authMode}, live ${config.liveExecutionEnabled}`);
const project = await api.get('/api/project');
record('project seeded', project.seeded === true, `${project.canonicalRepo} @ ${project.observedMainSha}`);
const unknown = await api.post('/api/does-not-exist', {});
record('unknown API route returns JSON 404', unknown.status === 404 && typeof unknown.body === 'object', `HTTP ${unknown.status}`);
const noKey = await fetch(`${api.origin}/api/admin/seed`, {
  method: 'POST',
  headers: {
    'CF-Access-Client-Id': process.env[`CF_ACCESS_CLIENT_ID_${args.env.toUpperCase()}`]!,
    'CF-Access-Client-Secret': process.env[`CF_ACCESS_CLIENT_SECRET_${args.env.toUpperCase()}`]!,
    'Content-Type': 'application/json',
    Origin: api.origin,
  },
  body: '{}',
});
record('mutation without Idempotency-Key is refused', noKey.status === 422, `HTTP ${noKey.status}`);
const crossOrigin = await fetch(`${api.origin}/api/admin/seed`, {
  method: 'POST',
  headers: {
    'CF-Access-Client-Id': process.env[`CF_ACCESS_CLIENT_ID_${args.env.toUpperCase()}`]!,
    'CF-Access-Client-Secret': process.env[`CF_ACCESS_CLIENT_SECRET_${args.env.toUpperCase()}`]!,
    'Content-Type': 'application/json',
    Origin: 'https://evil.example',
    'Idempotency-Key': `smoke-${crypto.randomUUID()}`,
  },
  body: '{}',
});
record('cross-origin mutation is refused (CSRF)', crossOrigin.status === 403, `HTTP ${crossOrigin.status}`);

step('Preview gateway');
const gw = await fetch(`${vars.PREVIEW_ORIGIN}/healthz`);
record('preview gateway health', gw.ok, `HTTP ${gw.status}`);
const forged = await fetch(`${vars.PREVIEW_ORIGIN}/p/forged.capability/`);
record('forged preview capability is refused', forged.status === 403, `HTTP ${forged.status}`);
const replayMissing = await fetch(`${vars.PREVIEW_ORIGIN}/api/replays/rpl_aaaaaaaaaaaaaaaaaaaaaaaaaa`);
record('unknown replay returns 404', replayMissing.status === 404, `HTTP ${replayMissing.status}`);

if (args.flags.has('--fixture-run')) await fixtureRun();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

async function fixtureRun() {
  step('Fixture session (checked-in agents, no model calls)');
  const created = await api.post('/api/sessions', { mode: 'fixture' });
  if (created.status !== 201) fail(`create session: ${created.status} ${JSON.stringify(created.body)}`);
  const sessionId = created.body.sessionId as string;
  console.log(`session ${sessionId}`);
  const started = await api.post(`/api/sessions/${sessionId}/start`, {});
  record('session started', started.status === 202, `HTTP ${started.status}`);

  let last = '';
  let snap: any;
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    snap = await api.get(`/api/sessions/${sessionId}`);
    const line = `${snap.session.status} | ${snap.candidates.map((c: any) => `${c.label}:${c.state}`).join(', ')}`;
    if (line !== last) {
      console.log(`  ${new Date().toISOString().slice(11, 19)} ${line}`);
      last = line;
    }
    if (['ready', 'needs_attention', 'failed', 'cancelled', 'promoted'].includes(snap.session.status)) break;
    if (Date.now() > deadline) fail('fixture session did not settle in 40 minutes');
    await sleep(5000);
  }
  record('fixture session reached ready', snap.session.status === 'ready', snap.session.reason ?? snap.session.status);
  const byLabel = (re: RegExp) => snap.candidates.filter((c: any) => re.test(c.label));
  for (const c of snap.candidates) {
    const cells = c.checks.map((k: any) => `${k.checkId}=${k.status}`).join(' ');
    console.log(`  ${c.label.padEnd(36)} ${c.state.padEnd(8)} ${c.headSha?.slice(0, 10) ?? '-'}  ${cells}`);
  }
  const pair = byLabel(/^Member pricing \+ Unit-price cache$/)[0];
  record('pricing + caching pair fails customer isolation', pair?.state === 'failed' && pair.checks.some((k: any) => k.checkId === 'pricing.isolation' && k.status === 'failed'));
  for (const name of ['Member pricing', 'Unit-price cache', 'Checkout summary']) {
    const c = snap.candidates.find((x: any) => x.label === name);
    record(`${name} passes alone`, c?.state === 'passed', c?.state ?? 'missing');
  }
  const confirmed = snap.interactions.filter((i: any) => i.state === 'resolved' || i.state === 'confirmed');
  record('interaction confirmed by evidence and resolved by repair', confirmed.some((i: any) => i.state === 'resolved'), confirmed.map((i: any) => `${i.kind}:${i.state}`).join(', '));
  const final = snap.candidates.find((c: any) => c.promotable);
  record('final anchored candidate is promotable', Boolean(final), final ? `${final.label} @ ${final.headSha}` : 'none');
  if (!final || !args.flags.has('--promote')) return;

  step('Approve and promote the exact tested commit');
  const approval = await api.post(`/api/candidates/${final.id}/approve`, {
    headSha: final.headSha,
    expectedMainSha: snap.session.expectedMainSha,
    validationDigest: final.validationDigest,
    decision: 'approve',
  });
  record('approval recorded', approval.status === 201, JSON.stringify(approval.body).slice(0, 200));
  if (approval.status !== 201) return;
  const prom = await api.post(`/api/approvals/${approval.body.approvalId}/promote`, {});
  record('promotion queued', prom.status === 202, JSON.stringify(prom.body).slice(0, 200));
  for (let i = 0; i < 60; i++) {
    const s = await api.get(`/api/sessions/${sessionId}`);
    if (s.session.status === 'promoted' || s.promotions.some((p: any) => ['stale', 'failed'].includes(p.state))) {
      const p = s.promotions[s.promotions.length - 1];
      record('canonical main equals the approved commit', p?.observed_remote_sha === final.headSha, `main ${p?.observed_remote_sha}`);
      return;
    }
    await sleep(5000);
  }
  record('promotion finished', false, 'timed out');
}

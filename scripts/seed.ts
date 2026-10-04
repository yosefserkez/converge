// Authenticated, idempotent synthetic project setup.
//   pnpm seed --env dev
import { apiFor, sleep } from './api.ts';
import { fail, loadEnvLocal, parseArgs, step } from './lib.ts';

loadEnvLocal();
const args = parseArgs();
const api = apiFor(args.env);

step(`Seed ${api.origin}`);
const r = await api.post('/api/admin/seed', {}, `seed-${args.env}-${Date.now()}`);
if (r.status >= 400) fail(`seed failed: ${r.status} ${JSON.stringify(r.body)}`);
console.log(`accepted: ${JSON.stringify(r.body)}`);

const deadline = Date.now() + 10 * 60_000;
for (;;) {
  const p = await api.get('/api/project');
  if (p.seeded) {
    console.log(`seeded: canonical repo ${p.canonicalRepo}, main ${p.observedMainSha}`);
    break;
  }
  if (p.seedJobStatus === 'failed') fail('seed job failed; check the events and Worker logs');
  if (Date.now() > deadline) fail('seed did not finish in 10 minutes');
  process.stdout.write(`  waiting (job ${p.seedJobStatus ?? 'pending'})\n`);
  await sleep(5000);
}

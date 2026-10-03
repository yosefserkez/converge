// Approve a session's promotable candidate and promote that exact commit.
//   node --experimental-strip-types scripts/dev/promote.ts <sessionId>
import { apiFor, sleep } from '../api.ts';
import { fail, loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const sessionId = process.argv[2] ?? fail('pass a session id');
const s = await api.get(`/api/sessions/${sessionId}`);
const c = s.candidates.find((x: any) => x.promotable) ?? fail('no promotable candidate');
console.log(`reviewing ${c.label} head ${c.headSha} validation ${c.validationDigest} expected main ${s.session.expectedMainSha}`);
const a = await api.post(`/api/candidates/${c.id}/approve`, { headSha: c.headSha, expectedMainSha: s.session.expectedMainSha, validationDigest: c.validationDigest, decision: 'approve' }, `approve-${c.id}`);
console.log('approve', a.status, JSON.stringify(a.body));
if (a.status !== 201) process.exit(1);
const p = await api.post(`/api/approvals/${a.body.approvalId}/promote`, {}, `promote-${a.body.approvalId}`);
console.log('promote', p.status, JSON.stringify(p.body));
for (let i = 0; i < 60; i++) {
  const now = await api.get(`/api/sessions/${sessionId}`);
  const last = now.promotions.at(-1);
  if (last && ['succeeded', 'stale', 'failed'].includes(last.state)) {
    console.log(JSON.stringify({ session: now.session.status, promotion: last.state, target: last.target_sha, observedMain: last.observed_remote_sha, equal: last.observed_remote_sha === c.headSha }));
    break;
  }
  await sleep(5000);
}

// Fault test: cancel a live session while agents are mid-turn, then confirm that
// no attempt keeps authority: jobs cancelled, workflows stopped, no new activity.
import { apiFor, sleep } from '../api.ts';
import { fail, loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const c = await api.post('/api/sessions', { mode: 'live', modelBudgetMicroUsd: 1_000_000 });
if (c.status !== 201) fail(JSON.stringify(c.body));
const id = c.body.sessionId;
await api.post(`/api/sessions/${id}/start`, {});
let snap: any;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  snap = await api.get(`/api/sessions/${id}`);
  if (snap.activity.filter((a: any) => a.kind === 'model').length >= 3) break;
}
const before = snap.activity.length;
const inFlight = snap.activity.filter((a: any) => !a.finishedAt).length;
console.log(`session ${id}: ${before} activity spans, ${inFlight} in flight; cancelling`);
const cancelledAt = Date.now();
const r = await api.post(`/api/sessions/${id}/cancel`, {});
console.log('cancel', r.status, JSON.stringify(r.body));
await sleep(45_000);
const after = await api.get(`/api/sessions/${id}`);
const started = after.activity.filter((a: any) => a.startedAt > cancelledAt + 2000);
console.log(JSON.stringify({
  status: after.session.status,
  jobs: after.jobs.map((j: any) => `${j.kind}:${j.status}`),
  proposals: after.proposals.map((p: any) => `${p.title}:${p.status}`),
  activityStartedAfterCancel: started.length,
  budget: after.session.budget,
}));
const ev = await api.get(`/api/sessions/${id}/events?after=0&limit=500`);
const late = ev.events.filter((e: any) => e.createdAt > cancelledAt + 2000 && !['session.cancelled', 'job.cancelled'].includes(e.type));
console.log(`events after cancel: ${late.map((e: any) => e.type).join(', ') || 'none'}`);

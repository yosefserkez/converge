// Retry failed jobs of a session (new attempt, larger fence).
//   node --experimental-strip-types scripts/dev/retry.ts <sessionId>
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const s = await api.get(`/api/sessions/${process.argv[2]}`);
for (const j of s.jobs.filter((j: { status: string }) => j.status === 'failed' || j.status === 'expired')) {
  const r = await api.post(`/api/jobs/${j.id}/retry`, {});
  console.log(j.kind, j.id, r.status, JSON.stringify(r.body));
}

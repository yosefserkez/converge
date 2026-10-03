// Print the failed observations of each failed check in a session.
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const s = await api.get(`/api/sessions/${process.argv[2]}`);
for (const c of s.candidates.filter((c: any) => c.state === 'failed')) {
  for (const k of c.checks.filter((k: any) => k.status === 'failed')) {
    const ev = await api.get(`/api/evidence/${k.evidenceId}`);
    console.log(`${c.label} @ ${c.headSha?.slice(0, 10)} ${k.checkId} (verified ${ev.verified}, ${ev.sha256.slice(0, 20)}…)`);
    for (const o of ev.content.observations.filter((o: any) => !o.passed)) console.log(`   ${o.label}: expected ${JSON.stringify(o.expected)}, observed ${JSON.stringify(o.observed)}`);
  }
}

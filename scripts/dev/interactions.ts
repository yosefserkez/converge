// Print a session's interactions and each proposal's declared contract changes.
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const s = await api.get(`/api/sessions/${process.argv[2]}`);
for (const p of s.proposals) console.log(p.title, JSON.stringify(p.intent?.contractChanges ?? null), JSON.stringify((p.intent?.assumptions ?? []).map((a: any) => `${a.key} ${a.operator} ${JSON.stringify(a.expected)}`)));
for (const i of s.interactions) console.log('interaction', i.kind, i.state, i.contractKey, '-', i.explanation);

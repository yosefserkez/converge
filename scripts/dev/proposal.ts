// Print a proposal's latest intent and sealed revisions.
//   node --experimental-strip-types scripts/dev/proposal.ts <sessionId> <title substring>
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const [sessionId, title] = process.argv.slice(2);
const s = await api.get(`/api/sessions/${sessionId}`);
const p = s.proposals.find((x: { title: string }) => x.title.includes(title ?? ''));
console.log(JSON.stringify({ title: p.title, status: p.status, intent: p.intent, revisions: p.revisions.map((r: { headSha: string }) => r.headSha) }, null, 1));
const diffId = p.revisions.at(-1)?.diffEvidenceId;
if (diffId) console.log((await api.get(`/api/evidence/${diffId}`)).content);

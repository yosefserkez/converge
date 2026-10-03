// Print the latest session's status, proposals, unfinished jobs, and failure events.
//   node --experimental-strip-types scripts/dev/peek.ts [--env dev]
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor(process.argv.includes('prod') ? 'prod' : 'dev');
const { sessions } = await api.get('/api/sessions');
const id = sessions[0].id;
const s = await api.get(`/api/sessions/${id}`);
console.log(id, s.session.status, s.session.reason);
for (const p of s.proposals) console.log(' ', p.title, p.status, p.job?.status, p.job?.errorCode ?? '', (p.summary ?? '').slice(0, 160));
for (const c of s.candidates) console.log(' ', c.label, c.state, c.headSha?.slice(0, 10) ?? '-', c.checks.map((k: any) => `${k.checkId}=${k.status}`).join(' '));
for (const j of s.jobs) if (j.status !== 'succeeded') console.log('  job', j.kind, j.status, j.errorCode ?? '');
const ev = await api.get(`/api/sessions/${id}/events?after=0&limit=500`);
for (const e of ev.events.filter((e: any) => /failed|blocked|error/.test(e.type))) console.log('  event', e.type, JSON.stringify(e.payload).slice(0, 300));

// Operator helper: create/start/cancel sessions from the terminal.
//   node --experimental-strip-types scripts/dev/session.ts cancel <sessionId>
//   node --experimental-strip-types scripts/dev/session.ts live [budgetUsd]
//   node --experimental-strip-types scripts/dev/session.ts fixture
import { apiFor } from '../api.ts';
import { fail, loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'cancel') {
  const r = await api.post(`/api/sessions/${arg}/cancel`, {});
  console.log(r.status, JSON.stringify(r.body));
} else if (cmd === 'live' || cmd === 'fixture') {
  const body = cmd === 'live' ? { mode: 'live', modelBudgetMicroUsd: Math.round(Number(arg ?? 3) * 1e6) } : { mode: 'fixture' };
  const c = await api.post('/api/sessions', body);
  if (c.status !== 201) fail(`${c.status} ${JSON.stringify(c.body)}`);
  const s = await api.post(`/api/sessions/${c.body.sessionId}/start`, {});
  console.log(JSON.stringify({ sessionId: c.body.sessionId, start: s.status }));
} else fail('usage: cancel <id> | live [usd] | fixture');

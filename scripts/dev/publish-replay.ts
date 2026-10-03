// Publish a redacted replay of a settled session and print its public URL.
//   node --experimental-strip-types scripts/dev/publish-replay.ts <sessionId> [dev|prod]
import { apiFor } from '../api.ts';
import { ENVIRONMENTS, ROOT, fail, loadEnvLocal, readJsonc } from '../lib.ts';
import { join } from 'node:path';

loadEnvLocal();
const [sessionId, envArg] = process.argv.slice(2);
if (!sessionId) fail('pass a session id');
const env = envArg === 'prod' ? 'prod' : 'dev';
const api = apiFor(env);
const r = await api.post(`/api/sessions/${sessionId}/publish-replay`, {}, `publish-${sessionId}`);
if (r.status >= 300) fail(`${r.status} ${JSON.stringify(r.body)}`);
const vars = readJsonc<{ vars: Record<string, string> }>(join(ROOT, 'apps/control', ENVIRONMENTS[env].config)).vars;
console.log(JSON.stringify({ ...r.body, url: `${vars.PREVIEW_ORIGIN}/replay/${r.body.replayId}`, api: `${vars.PREVIEW_ORIGIN}/api/replays/${r.body.replayId}` }));

// Allocate a preview for a session's promotable or final candidate and probe it through the gateway.
//   node --experimental-strip-types scripts/dev/preview.ts <sessionId>
import { apiFor } from '../api.ts';
import { fail, loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const s = await api.get(`/api/sessions/${process.argv[2] ?? fail('pass a session id')}`);
const c = s.candidates.find((x: any) => x.promotable) ?? s.candidates.at(-1);
const r = await api.post(`/api/candidates/${c.id}/preview`, {});
if (r.status !== 201) fail(`${r.status} ${JSON.stringify(r.body)}`);
const url: string = r.body.url;
console.log(`preview for ${c.label} @ ${c.headSha.slice(0, 10)}, expires in ${Math.round((r.body.expiresAt - Date.now()) / 1000)}s`);
const page = await fetch(url);
console.log('GET page', page.status, page.headers.get('content-security-policy')?.slice(0, 40), page.headers.get('referrer-policy'), (await page.text()).slice(0, 80).replace(/\s+/g, ' '));
for (const customer of ['member-1', 'regular-1']) {
  const q = await fetch(`${url}api/quote`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-customer': customer, cookie: 'CF_Authorization=stolen' }, body: JSON.stringify({ productId: 'backpack', quantity: 2 }) });
  console.log('POST quote', customer, q.status, await q.text());
}
console.log('GET diagnostics', (await fetch(`${url}__diagnostics/compute-count`)).status);
console.log('PUT refused', (await fetch(`${url}api/quote`, { method: 'PUT', body: '{}' })).status);
console.log('extra field refused', (await fetch(`${url}api/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: 'backpack', quantity: 1, unitPriceCents: 1 }) })).status);
console.log('tampered capability', (await fetch(url.replace(/\/p\/([^.]+)\./, '/p/$1x.'))).status);

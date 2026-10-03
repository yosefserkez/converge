import { Hono } from 'hono';

// Separate-origin gateway for candidate previews and public replays.
// It reaches the control plane only through the restricted PreviewEntrypoint
// service binding. It cannot create sessions, call models, approve, or promote.

interface PreviewEntrypointRpc {
  getReplay(replayId: string): Promise<{ ok: true; json: string; mode: string } | { ok: false }>;
  previewRequest(
    token: string,
    method: string,
    path: string,
    query: string,
    body: string | null,
    customer: string | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

type Bindings = { CONTROL: Fetcher & PreviewEntrypointRpc; ASSETS: Fetcher; ENVIRONMENT: string };

const app = new Hono<{ Bindings: Bindings }>();

const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors *",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join('; ');

// content-length is recomputed by the runtime; never pass a candidate's value through.
const ALLOWED_RESPONSE_HEADERS = new Set(['content-type']);
const MAX_PREVIEW_BODY = 4 * 1024;

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('/api/replays/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^rpl_[a-z0-9]{26}$/.test(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'replay not found' } }, 404);
  const r = await c.env.CONTROL.getReplay(id);
  if (!r.ok) return c.json({ error: { code: 'NOT_FOUND', message: 'replay not found' } }, 404);
  return c.body(r.json, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
});

// /p/<capability>/<path>: only GET for pages/assets and POST /api/quote reach the candidate app.
app.all('/p/:cap/*', async (c) => {
  const cap = c.req.param('cap');
  const url = new URL(c.req.url);
  const prefix = `/p/${cap}`;
  const path = url.pathname.slice(prefix.length) || '/';
  const method = c.req.method;
  const isQuote = method === 'POST' && path === '/api/quote';
  if (!(method === 'GET' || isQuote)) return blocked('method not allowed', 405);
  if (path.startsWith('/__') || path.includes('/../') || path.includes('%2e%2e')) return blocked('not found', 404);
  let body: string | null = null;
  if (isQuote) {
    body = await c.req.text();
    if (body.length > MAX_PREVIEW_BODY) return blocked('request body too large', 413);
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort().join(',');
      if (keys !== 'productId,quantity' || typeof parsed.productId !== 'string' || typeof parsed.quantity !== 'number') {
        return blocked('invalid quote request', 422);
      }
    } catch {
      return blocked('invalid JSON', 400);
    }
  }
  // Only the synthetic demo customer header passes; cookies, Access, and auth headers never do.
  const customer = c.req.header('x-demo-customer');
  const r = await c.env.CONTROL.previewRequest(cap, method, path, url.search.slice(0, 200), body, customer === 'member-1' ? 'member-1' : 'regular-1');
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (ALLOWED_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  applyPreviewHeaders(headers);
  // Redirects, Set-Cookie, and service-worker scope headers from candidate code never pass.
  const status = r.status >= 300 && r.status < 400 ? 502 : r.status;
  return new Response(r.body, { status, headers });
});

function applyPreviewHeaders(h: Headers) {
  h.set('Content-Security-Policy', PREVIEW_CSP);
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

function blocked(message: string, status: number) {
  const h = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  applyPreviewHeaders(h);
  return new Response(message, { status, headers: h });
}

app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'no such route' } }, 404));

export default app;

// Authenticated operator API client for scripts. Uses the Access service token
// from .env.local; credentials go only into request headers, never to stdout.
import { ENVIRONMENTS, ROOT, fail, readJsonc, requireEnv, type EnvName } from './lib.ts';
import { join } from 'node:path';

export interface Api {
  origin: string;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; body: T }>;
}

export function apiFor(env: EnvName): Api {
  const vars = readJsonc<{ vars: Record<string, string> }>(join(ROOT, 'apps/control', ENVIRONMENTS[env].config)).vars;
  const origin = vars.CONTROL_ORIGIN ?? fail('CONTROL_ORIGIN missing');
  const id = requireEnv(`CF_ACCESS_CLIENT_ID_${env.toUpperCase()}`);
  const secret = requireEnv(`CF_ACCESS_CLIENT_SECRET_${env.toUpperCase()}`);
  const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
  async function call(method: string, path: string, body?: unknown, key?: string) {
    const res = await fetch(`${origin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...headers,
        ...(method === 'POST'
          ? { 'Content-Type': 'application/json', Origin: origin, 'Idempotency-Key': key ?? `script-${crypto.randomUUID()}` }
          : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    if (res.status === 302 || res.status === 403 && !res.headers.get('content-type')?.includes('json')) {
      fail(`${method} ${path}: Access rejected the service token (HTTP ${res.status})`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
  return {
    origin,
    async get(path) {
      const r = await call('GET', path);
      if (r.status >= 400) fail(`GET ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
      return r.body as never;
    },
    async post(path, body, key) {
      return (await call('POST', path, body, key)) as never;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

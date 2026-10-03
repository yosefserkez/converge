import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerServer } from '../../../containers/git-broker/server.ts';
import { FAKE_TOKEN, createFixture, seed, type Fixture } from './git-helpers.ts';

let fx: Fixture;
let server: Server;
let base: string;

async function start(opts: { sharedSecret?: string; maxBodyBytes?: number } = {}): Promise<void> {
  server = createBrokerServer(fx.broker, opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  fx = createFixture();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fx.cleanup();
});

describe('git-broker server', () => {
  it('serves healthz and named ops', async () => {
    await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const repo = await seed(fx);
    const res = await post('/op/readHead', { remote: repo.url, token: FAKE_TOKEN, branch: 'main' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { sha: repo.sha } });
  });

  it('rejects unknown routes, wrong methods, bad JSON and oversize bodies', async () => {
    await start({ maxBodyBytes: 1024 });
    expect((await post('/op/shell', {})).status).toBe(404);
    expect((await post('/exec', {})).status).toBe(404);
    expect((await fetch(`${base}/op/readHead`)).status).toBe(405);
    expect((await post('/op/readHead', '{nope')).status).toBe(400);
    expect((await post('/op/readHead', { pad: 'x'.repeat(5000) })).status).toBe(413);
    expect((await post('/op/readHead', 'x', { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('returns structured, redacted errors with the domain status', async () => {
    await start();
    const res = await post('/op/readHead', { remote: 'https://evil.example/git/a/b.git', token: FAKE_TOKEN, branch: 'main' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) } });
    expect(text).not.toContain(FAKE_TOKEN);
  });

  it('enforces the optional shared secret', async () => {
    await start({ sharedSecret: 'broker-shared-secret-value' });
    const body = { remote: 'https://evil.example/x.git', token: FAKE_TOKEN, branch: 'main' };
    expect((await post('/op/readHead', body)).status).toBe(401);
    expect((await post('/op/readHead', body, { 'x-converge-broker-auth': 'wrong' })).status).toBe(401);
    expect((await post('/op/readHead', body, { 'x-converge-broker-auth': 'broker-shared-secret-value' })).status).toBe(403);
  });
});

import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { assertMutationOrigin, authenticate } from '../../apps/control/worker/auth.ts';
import { signCapability, verifyCapability } from '../../apps/control/worker/capability.ts';
import { AppConfig } from '../../apps/control/worker/config.ts';
import { redactReplay } from '../../apps/control/worker/replay.ts';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-1234';

const baseVars = {
  ENVIRONMENT: 'dev',
  PROJECT_SLUG: 'storefront',
  AUTH_MODE: 'access',
  ACCESS_ISSUER: ISSUER,
  ACCESS_AUD: AUD,
  OPERATOR_SUBJECTS: 'operator@example.com,client123.access',
  MODEL_PROVIDER: 'anthropic',
  MODEL_ID: 'claude-haiku-4-5',
  MODEL_PRICE_SNAPSHOT: JSON.stringify({ provider: 'anthropic', modelId: 'claude-haiku-4-5', inputMicroUsdPerMTok: 1_000_000, outputMicroUsdPerMTok: 5_000_000, capturedAt: 1 }),
  LIVE_EXECUTION_ENABLED: 'false',
  DEFAULT_MODEL_BUDGET_MICROUSD: '5000000',
  MAX_CONCURRENT_AGENTS: '3',
  MAX_ACTIVE_CONTAINERS: '6',
  MAX_CANDIDATES_PER_SESSION: '8',
  MAX_REPAIR_ATTEMPTS: '2',
  MAX_AGENT_TURNS: '30',
  AGENT_DEADLINE_SECONDS: '720',
  TOOL_TIMEOUT_SECONDS: '120',
  LEASE_SECONDS: '180',
  PREVIEW_TTL_SECONDS: '300',
  CONTROL_ORIGIN: 'https://control.example.workers.dev',
  PREVIEW_ORIGIN: 'https://preview.example.workers.dev',
  BUILD_ID: 'test',
  REPO_HOST: 'artifacts',
};
const config = AppConfig.parse(baseVars);

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

async function token(privateKey: CryptoKey, claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

const req = (headers: Record<string, string> = {}, url = 'https://control.example.workers.dev/api/project', method = 'GET') =>
  new Request(url, { method, headers });

describe('Access JWT verification', () => {
  it('accepts a valid, allowlisted operator and takes the actor from the token', async () => {
    const { privateKey, jwks } = await keys();
    const jwt = await token(privateKey, { sub: 'user-1', email: 'Operator@Example.com' });
    const actor = await authenticate(req({ 'Cf-Access-Jwt-Assertion': jwt }), config, jwks);
    expect(actor).toEqual({ subject: 'operator@example.com', email: 'operator@example.com', mode: 'access' });
  });

  it('accepts an allowlisted service token by its common_name', async () => {
    const { privateKey, jwks } = await keys();
    const jwt = await token(privateKey, { sub: '', common_name: 'client123.access' });
    const actor = await authenticate(req({ 'Cf-Access-Jwt-Assertion': jwt }), config, jwks);
    expect(actor.subject).toBe('service:client123.access');
  });

  it('rejects an absent assertion, even with an email header', async () => {
    const { jwks } = await keys();
    await expect(authenticate(req({ 'Cf-Access-Authenticated-User-Email': 'operator@example.com' }), config, jwks)).rejects.toThrow(/^UNAUTHENTICATED/);
  });

  it('rejects a token signed by another key', async () => {
    const { jwks } = await keys();
    const other = await keys();
    const jwt = await token(other.privateKey, { sub: 'user-1', email: 'operator@example.com' });
    await expect(authenticate(req({ 'Cf-Access-Jwt-Assertion': jwt }), config, jwks)).rejects.toThrow(/^UNAUTHENTICATED/);
  });

  it('rejects an expired token, a wrong audience, and a wrong issuer', async () => {
    const { privateKey, jwks } = await keys();
    const claims = { sub: 'user-1', email: 'operator@example.com' };
    for (const jwt of [
      await token(privateKey, claims, { exp: '-10m' }),
      await token(privateKey, claims, { aud: 'other-aud' }),
      await token(privateKey, claims, { iss: 'https://evil.cloudflareaccess.com' }),
    ]) {
      await expect(authenticate(req({ 'Cf-Access-Jwt-Assertion': jwt }), config, jwks)).rejects.toThrow(/^UNAUTHENTICATED/);
    }
  });

  it('rejects a valid identity that is not on the allowlist', async () => {
    const { privateKey, jwks } = await keys();
    const jwt = await token(privateKey, { sub: 'user-2', email: 'someone@example.com' });
    await expect(authenticate(req({ 'Cf-Access-Jwt-Assertion': jwt }), config, jwks)).rejects.toThrow(/^FORBIDDEN/);
  });

  it('local auth is refused outside ENVIRONMENT=local, at config time and at runtime', async () => {
    expect(() => AppConfig.parse({ ...baseVars, AUTH_MODE: 'local' })).toThrow(/AUTH_MODE=access/);
    const forced = { ...config, AUTH_MODE: 'local' as const };
    await expect(authenticate(req(), forced)).rejects.toThrow(/^FORBIDDEN/);
    const local = AppConfig.parse({ ...baseVars, ENVIRONMENT: 'local', AUTH_MODE: 'local' });
    // A caller-controlled Host header does not matter in local mode either.
    await expect(authenticate(req({ Host: 'evil.example' }), local)).resolves.toMatchObject({ mode: 'local' });
  });
});

describe('CSRF', () => {
  const post = (headers: Record<string, string>) => req(headers, 'https://control.example.workers.dev/api/sessions', 'POST');

  it('accepts a same-origin JSON mutation', () => {
    expect(() => assertMutationOrigin(post({ Origin: config.CONTROL_ORIGIN, 'Content-Type': 'application/json' }), config)).not.toThrow();
  });

  it('rejects a missing or foreign Origin and non-JSON bodies', () => {
    expect(() => assertMutationOrigin(post({ 'Content-Type': 'application/json' }), config)).toThrow(/^CSRF_REJECTED/);
    expect(() => assertMutationOrigin(post({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }), config)).toThrow(/^CSRF_REJECTED/);
    expect(() => assertMutationOrigin(post({ Origin: config.CONTROL_ORIGIN, 'Content-Type': 'text/plain' }), config)).toThrow(/^CSRF_REJECTED/);
  });
});

describe('preview capabilities', () => {
  const key = 'k'.repeat(48);
  const cap = {
    version: 1 as const,
    scope: 'candidate-preview' as const,
    projectId: 'storefront',
    candidateId: 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    headSha: 'a'.repeat(40),
    resourceId: 'preview-prev_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    expiresAt: Date.now() + 60_000,
    nonce: 'n0123456789abcdef',
  };

  it('round-trips a signed capability', async () => {
    const t = await signCapability(key, cap);
    expect(await verifyCapability(key, t)).toEqual(cap);
  });

  it('rejects a tampered payload, a wrong key, and malformed tokens', async () => {
    const t = await signCapability(key, cap);
    const [payload, sig] = t.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...cap, candidateId: 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbb' })).toString('base64url');
    await expect(verifyCapability(key, `${forged}.${sig}`)).rejects.toThrow(/^FORBIDDEN/);
    await expect(verifyCapability('x'.repeat(48), t)).rejects.toThrow(/^FORBIDDEN/);
    await expect(verifyCapability(key, 'not-a-token')).rejects.toThrow(/^FORBIDDEN/);
    await expect(verifyCapability(key, `${payload}`)).rejects.toThrow(/^FORBIDDEN/);
  });

  it('accepts the previous key during rotation and signs with the new one', async () => {
    const oldKey = 'o'.repeat(48);
    const t = await signCapability(oldKey, cap);
    expect(await verifyCapability(`${key},${oldKey}`, t)).toEqual(cap);
    const fresh = await signCapability(`${key},${oldKey}`, cap);
    await expect(verifyCapability(oldKey, fresh)).rejects.toThrow(/^FORBIDDEN/);
  });

  it('carries the expiry so the gateway can refuse it (expiry checked by the caller)', async () => {
    const t = await signCapability(key, { ...cap, expiresAt: Date.now() - 1 });
    const v = await verifyCapability(key, t);
    expect(v.expiresAt).toBeLessThan(Date.now());
  });
});

describe('replay redaction', () => {
  it('copies only whitelisted fields and scrubs token-shaped strings', () => {
    const snapshot = {
      session: {
        id: 'ses_x', objective: 'goal', mode: 'fixture', status: 'ready', baselineSha: 'b'.repeat(40), expectedMainSha: 'b'.repeat(40),
        taskSetDigest: 'sha256:x', policyDigest: 'sha256:y', harnessDigest: 'sha256:z', modelId: null, createdBy: 'operator@example.com',
        createdAt: 1, finishedAt: null, budget: { ceilingMicroUsd: 0, reserved: 0, spent: 0, uncertain: 0, total: 0 }, reason: null,
      },
      project: { slug: 'storefront', canonicalRepo: 'cv-storefront-b-main', observedMainSha: 'b'.repeat(40) },
      limits: { maxRepairAttempts: 2, maxCandidates: 8, liveEnabled: false },
      proposals: [{
        id: 'prop_1', title: 'Pricing', kind: 'feature', role: 'pricing', status: 'sealed', objective: 'o', editablePaths: [], capabilityIds: [],
        baseCandidateId: null, repoName: 'cv-ses-x-p-pricing', intent: null, intentVersion: 1,
        summary: 'used token art_v1_0123456789abcdef0123456789abcdef01234567?expires=1 and sk-ant-secretkey', progress: null, job: null, revisions: [],
      }],
      candidates: [], interactions: [],
      approvals: [{ id: 'appr_1', candidate_id: 'c', decision: 'approve', head_sha: 'h', expected_main_sha: 'e', validation_digest: 'v', actor_subject: 'operator@example.com', expires_at: 1, created_at: 1 }],
      promotions: [], activity: [], jobs: [], watermark: 3,
    };
    const out = redactReplay({
      replayId: 'rpl_1',
      snapshot: snapshot as never,
      events: [
        { seq: 1, type: 'session.created', entityType: 'session', entityId: 'ses_x', payload: { mode: 'fixture', secretField: 'x' }, visibility: 'public', createdAt: 1 },
        { seq: 2, type: 'project.seed_requested', entityType: 'project', entityId: 'p', payload: {}, visibility: 'private', createdAt: 1 },
        { seq: 3, type: 'preview.created', entityType: 'preview', entityId: 'p', payload: {}, visibility: 'public', createdAt: 1 },
      ],
      publishedAt: 2,
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('operator@example.com');
    expect(text).not.toContain('art_v1_0123');
    expect(text).not.toContain('sk-ant-secret');
    expect(text).not.toContain('secretField');
    expect(text).not.toContain('cv-ses-x-p-pricing');
    expect(out.events.map((e) => e.type)).toEqual(['session.created']);
    expect(out.approvals[0]).toEqual({ decision: 'approve', headSha: 'h', validationDigest: 'v', createdAt: 1 });
  });
});

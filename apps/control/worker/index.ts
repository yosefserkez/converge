import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DomainError, asDomainError, requestDigest, toEnvelope } from '@converge/domain';
import { ApproveBody, CreateSessionBody, EmptyBody, EventsQuery, IdParam, openApiDocument } from './api-schemas.ts';
import { type Actor, assertMutationOrigin, authenticate } from './auth.ts';
import { signCapability } from './capability.ts';
import { loadConfig } from './config.ts';
import type { CommandType } from './coordinator/index.ts';
import { readVerifiedText } from './evidence.ts';

export { ProjectCoordinator } from './coordinator/index.ts';
export { ExecutionContainer } from './execution-container.ts';
export { GitBrokerContainer } from './git-broker-container.ts';
export { JobWorkflow } from './workflow.ts';
export { PreviewEntrypoint } from './preview-entrypoint.ts';

type Vars = { actor: Actor; requestId: string };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVIDENCE_RESPONSE = 1024 * 1024;

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('X-Request-Id', c.get('requestId'));
  if (c.req.path.startsWith('/api/') || c.req.path === '/healthz') {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  }
});

app.onError((err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  const domain = toDomainError(err);
  if (domain.status >= 500) console.error(JSON.stringify({ level: 'error', requestId, code: domain.code, message: domain.message }));
  return c.json(toEnvelope(domain, requestId), domain.status as 400);
});

app.get('/healthz', (c) => {
  const cfg = loadConfig(c.env);
  return c.json({ ok: true, buildId: cfg.BUILD_ID, environment: cfg.ENVIRONMENT });
});

// Every /api route needs a verified operator; mutations also pass CSRF checks.
app.use('/api/*', async (c, next) => {
  const cfg = loadConfig(c.env);
  c.set('actor', await authenticate(c.req.raw, cfg));
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') assertMutationOrigin(c.req.raw, cfg);
  await next();
});

app.get('/api/openapi.json', (c) => c.json(openApiDocument(loadConfig(c.env).BUILD_ID)));

app.get('/api/config', (c) => {
  const cfg = loadConfig(c.env);
  return c.json({
    environment: cfg.ENVIRONMENT,
    projectSlug: cfg.PROJECT_SLUG,
    buildId: cfg.BUILD_ID,
    authMode: cfg.AUTH_MODE,
    operator: c.get('actor').subject,
    liveExecutionEnabled: cfg.LIVE_EXECUTION_ENABLED && Boolean(c.env.ANTHROPIC_API_KEY),
    modelId: cfg.MODEL_ID,
    priceSnapshot: cfg.MODEL_PRICE_SNAPSHOT,
    defaultBudgetMicroUsd: cfg.DEFAULT_MODEL_BUDGET_MICROUSD,
    limits: {
      maxConcurrentAgents: cfg.MAX_CONCURRENT_AGENTS,
      maxCandidatesPerSession: cfg.MAX_CANDIDATES_PER_SESSION,
      maxRepairAttempts: cfg.MAX_REPAIR_ATTEMPTS,
      maxAgentTurns: cfg.MAX_AGENT_TURNS,
      previewTtlSeconds: cfg.PREVIEW_TTL_SECONDS,
    },
    previewOrigin: cfg.PREVIEW_ORIGIN,
  });
});

const coordinator = (c: Ctx) => c.env.PROJECTS.getByName(loadConfig(c.env).PROJECT_SLUG);
const id = (c: Ctx) => IdParam.parse(c.req.param('id'));

app.get('/api/project', async (c) => c.json(await coordinator(c).getProjectSummary()));
app.get('/api/sessions', async (c) => c.json({ sessions: await coordinator(c).listSessions(20) }));
const jsonText = (c: Ctx, text: string) => c.body(text, 200, { 'Content-Type': 'application/json; charset=utf-8' });

app.get('/api/sessions/:id', async (c) => jsonText(c, await coordinator(c).getSessionSnapshotJson(id(c))));
app.get('/api/sessions/:id/events', async (c) => {
  const q = EventsQuery.parse(c.req.query());
  return jsonText(c, await coordinator(c).getEventsJson(id(c), q.after, q.limit));
});
app.get('/api/proposals/:id', async (c) => c.json(await coordinator(c).getProposal(id(c))));
app.get('/api/candidates/:id', async (c) => jsonText(c, await coordinator(c).getCandidateJson(id(c))));

app.get('/api/evidence/:id', async (c) => {
  const meta = await coordinator(c).getEvidenceMeta(id(c));
  if (meta.bytes > MAX_EVIDENCE_RESPONSE) throw new DomainError('LIMIT_EXCEEDED', 'evidence is too large to show here', { bytes: meta.bytes });
  const text = await readVerifiedText(c.env.EVIDENCE, meta.r2_key, meta.sha256);
  // Always JSON-wrapped: evidence is shown as text and never rendered as HTML.
  return c.json({
    id: meta.id,
    kind: meta.kind,
    sha256: meta.sha256,
    bytes: meta.bytes,
    contentType: meta.content_type,
    verified: true,
    content: meta.content_type.startsWith('application/json') ? JSON.parse(text) : text,
  });
});

/** Run an idempotent domain command through the coordinator. */
async function command<T extends z.ZodType>(c: Ctx, type: CommandType, schema: T, params: (body: z.infer<T>) => Record<string, unknown>) {
  const key = c.req.header('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'send an Idempotency-Key header (8-128 safe characters)');
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new DomainError('INVALID_INPUT', 'request body is too large');
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new DomainError('INVALID_INPUT', 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', 'request body does not match the schema', { issues: parsed.error.issues.slice(0, 10) });
  const p = params(parsed.data);
  const result = await coordinator(c).command({
    type,
    actor: c.get('actor').subject,
    idempotencyKey: key,
    requestDigest: await requestDigest({ type, path: c.req.path, params: p }),
    params: p,
  });
  return { status: result.status, body: JSON.parse(result.bodyJson) as unknown };
}

const respond = (c: Ctx, r: { status: number; body: unknown }) => {
  const body = r.body as { error?: { requestId?: string } };
  if (body?.error) body.error.requestId = c.get('requestId');
  return c.json(body as object, r.status as 200);
};

app.post('/api/admin/seed', async (c) => respond(c, await command(c, 'seed', EmptyBody, () => ({}))));
app.post('/api/sessions', async (c) => respond(c, await command(c, 'createSession', CreateSessionBody, (b) => ({ ...b }))));
app.post('/api/sessions/:id/start', async (c) => respond(c, await command(c, 'startSession', EmptyBody, () => ({ sessionId: id(c) }))));
app.post('/api/sessions/:id/cancel', async (c) => respond(c, await command(c, 'cancelSession', EmptyBody, () => ({ sessionId: id(c) }))));
app.post('/api/jobs/:id/retry', async (c) => respond(c, await command(c, 'retryJob', EmptyBody, () => ({ jobId: id(c) }))));
app.post('/api/candidates/:id/repair', async (c) => respond(c, await command(c, 'requestRepair', EmptyBody, () => ({ candidateId: id(c) }))));
app.post('/api/candidates/:id/approve', async (c) =>
  respond(c, await command(c, 'approve', ApproveBody, (b) => ({ ...b, candidateId: id(c) }))),
);
app.post('/api/approvals/:id/promote', async (c) => respond(c, await command(c, 'promote', EmptyBody, () => ({ approvalId: id(c) }))));
app.post('/api/sessions/:id/publish-replay', async (c) => respond(c, await command(c, 'publishReplay', EmptyBody, () => ({ sessionId: id(c) }))));
app.post('/api/candidates/:id/preview', async (c) => {
  const cfg = loadConfig(c.env);
  const r = await command(c, 'createPreview', EmptyBody, () => ({ candidateId: id(c) }));
  if (r.status >= 300) return respond(c, r);
  const body = r.body as { previewId: string; capability: Parameters<typeof signCapability>[1] };
  const token = await signCapability(c.env.PREVIEW_SIGNING_KEY, body.capability);
  return c.json({ previewId: body.previewId, url: `${cfg.PREVIEW_ORIGIN}/p/${token}/`, expiresAt: body.capability.expiresAt }, 201);
});

// Unknown API routes return JSON, never the SPA fallback.
app.all('/api/*', () => {
  throw new DomainError('NOT_FOUND', 'no such API route');
});

function toDomainError(err: unknown): DomainError {
  if (err instanceof z.ZodError) return new DomainError('INVALID_INPUT', 'invalid input', { issues: err.issues.slice(0, 10) });
  return asDomainError(err) ?? new DomainError('INTERNAL', 'internal error');
}

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    const cfg = loadConfig(env);
    ctx.waitUntil(env.PROJECTS.getByName(cfg.PROJECT_SLUG).recover().then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

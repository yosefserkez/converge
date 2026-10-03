import { z } from 'zod';
import { Digest, GitOid, Id } from '@converge/domain';

// Request DTOs for every mutating route. Shared with the SPA.

export const CreateSessionBody = z.object({
  mode: z.enum(['live', 'fixture']),
  modelBudgetMicroUsd: z.number().int().positive().max(100_000_000).optional(),
});
export const EmptyBody = z.object({}).strict();
export const ApproveBody = z.object({
  headSha: GitOid,
  expectedMainSha: GitOid,
  validationDigest: Digest,
  decision: z.enum(['approve', 'reject']),
});
export const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const IdParam = Id;

export const ROUTES = [
  { method: 'GET', path: '/healthz', summary: 'Health and build identity', auth: false },
  { method: 'GET', path: '/api/config', summary: 'Operator settings, capabilities, and limits', auth: true },
  { method: 'GET', path: '/api/project', summary: 'Project summary and observed canonical head', auth: true },
  { method: 'GET', path: '/api/sessions', summary: 'Bounded session history', auth: true },
  { method: 'POST', path: '/api/sessions', summary: 'Freeze the preset task set, baseline, mode, and budget', auth: true, body: CreateSessionBody },
  { method: 'GET', path: '/api/sessions/{id}', summary: 'Consistent session snapshot with event watermark', auth: true },
  { method: 'POST', path: '/api/sessions/{id}/start', summary: 'Start the agents asynchronously', auth: true, body: EmptyBody },
  { method: 'POST', path: '/api/sessions/{id}/cancel', summary: 'Record durable cancellation intent', auth: true, body: EmptyBody },
  { method: 'GET', path: '/api/sessions/{id}/events', summary: 'Ordered events after a cursor', auth: true, query: EventsQuery },
  { method: 'POST', path: '/api/jobs/{id}/retry', summary: 'Start a new attempt of a failed job', auth: true, body: EmptyBody },
  { method: 'GET', path: '/api/proposals/{id}', summary: 'Assignment, intent history, sealed revisions', auth: true },
  { method: 'GET', path: '/api/candidates/{id}', summary: 'Manifest, membership, checks, review eligibility', auth: true },
  { method: 'POST', path: '/api/candidates/{id}/repair', summary: 'Request a bounded repair of a failed candidate', auth: true, body: EmptyBody },
  { method: 'POST', path: '/api/candidates/{id}/approve', summary: 'Approve or reject the exact reviewed commit', auth: true, body: ApproveBody },
  { method: 'POST', path: '/api/approvals/{id}/promote', summary: 'Queue the guarded promotion', auth: true, body: EmptyBody },
  { method: 'GET', path: '/api/evidence/{id}', summary: 'Bounded, digest-verified evidence', auth: true },
  { method: 'POST', path: '/api/candidates/{id}/preview', summary: 'Allocate a time-limited isolated preview', auth: true, body: EmptyBody },
  { method: 'POST', path: '/api/sessions/{id}/publish-replay', summary: 'Publish a redacted read-only replay', auth: true, body: EmptyBody },
  { method: 'POST', path: '/api/admin/seed', summary: 'Idempotent synthetic project setup', auth: true, body: EmptyBody },
] as const;

/** Generated API reference (OpenAPI 3.1 subset) from the route table and request schemas. */
export function openApiDocument(buildId: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const op: Record<string, unknown> = {
      summary: r.summary,
      security: r.auth ? [{ access: [] }] : [],
      responses: { default: { description: 'JSON body, or an error envelope { error: { code, message, retryable, requestId, details } }' } },
    };
    if ('body' in r && r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(r.body) } } };
      op.parameters = [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }];
    }
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Converge control API', version: buildId },
    components: { securitySchemes: { access: { type: 'apiKey', in: 'header', name: 'Cf-Access-Jwt-Assertion' } } },
    paths,
  };
}

import { DomainError, newId, type JobKind } from '@converge/domain';
import { type Db, json } from './db.ts';

export type Visibility = 'private' | 'public';

export interface EventInput {
  sessionId: string | null;
  key: string;
  type: string;
  actor: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  causationId?: string | null;
  payload: Record<string, unknown>;
  visibility?: Visibility;
}

/** Append-only audit/progress event; a duplicate key is a harmless no-op. */
export function appendEvent(db: Db, e: EventInput, now = Date.now()): void {
  db.run(
    `INSERT OR IGNORE INTO event (session_id, event_key, type, actor, entity_type, entity_id, causation_id,
       correlation_id, payload_json, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.sessionId,
    e.key,
    e.type,
    e.actor,
    e.entityType,
    e.entityId,
    e.causationId ?? null,
    e.correlationId,
    json(e.payload),
    e.visibility ?? 'public',
    now,
  );
}

export interface OutboxInput {
  effectKey: string;
  jobId?: string | null;
  kind: 'dispatch' | 'terminate' | 'cleanup';
  payload: Record<string, unknown>;
  notBefore?: number;
}

export function enqueueOutbox(db: Db, o: OutboxInput, now = Date.now()): void {
  db.run(
    `INSERT OR IGNORE INTO outbox (id, effect_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    newId('ob'),
    o.effectKey,
    o.jobId ?? null,
    o.kind,
    json(o.payload),
    o.notBefore ?? now,
    now,
    now,
  );
}

export interface JobRow extends Record<string, SqlStorageValue> {
  id: string;
  session_id: string | null;
  kind: JobKind;
  entity_id: string;
  input_json: string;
  input_digest: string;
  dedupe_key: string;
  status: string;
  attempt_no: number;
  current_fence: number;
  lease_expires_at: number | null;
  workflow_id: string | null;
  deadline_at: number;
  created_at: number;
  cancel_requested_at: number | null;
  error_code: string | null;
}

export function getJob(db: Db, jobId: string): JobRow {
  const job = db.one<JobRow>('SELECT * FROM job WHERE id = ?', jobId);
  if (!job) throw new DomainError('NOT_FOUND', `job ${jobId} not found`);
  return job;
}

export const workflowIdFor = (jobId: string, attemptNo: number) => `${jobId}-a${attemptNo}`;

/**
 * Create a job (idempotent by dedupe key) and queue its first attempt.
 * Returns the existing job when the dedupe key was already used.
 */
export function createJob(
  db: Db,
  args: {
    sessionId: string | null;
    kind: JobKind;
    entityId: string;
    input: Record<string, unknown>;
    inputDigest: string;
    dedupeKey: string;
    deadlineAt: number;
  },
  now = Date.now(),
): JobRow {
  const existing = db.one<JobRow>('SELECT * FROM job WHERE dedupe_key = ?', args.dedupeKey);
  if (existing) return existing;
  const id = newId('job');
  db.run(
    `INSERT INTO job (id, session_id, kind, entity_id, input_json, input_digest, dedupe_key, status, attempt_no,
       current_fence, deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?)`,
    id,
    args.sessionId,
    args.kind,
    args.entityId,
    json(args.input),
    args.inputDigest,
    args.dedupeKey,
    args.deadlineAt,
    now,
    now,
  );
  return queueAttempt(db, id, now);
}

/** Allocate a new attempt with a strictly larger fence and dispatch it through the outbox. */
export function queueAttempt(db: Db, jobId: string, now = Date.now()): JobRow {
  const job = getJob(db, jobId);
  const attemptNo = job.attempt_no + 1;
  const fence = job.current_fence + 1;
  const workflowId = workflowIdFor(jobId, attemptNo);
  // Each attempt gets the job's original time allowance from now; a retry after the first deadline must not expire at lease.
  const deadlineAt = now + Math.max(0, job.deadline_at - job.created_at);
  db.run(
    `UPDATE job SET status = 'queued', attempt_no = ?, current_fence = ?, workflow_id = ?, lease_expires_at = NULL,
       error_code = NULL, deadline_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    attemptNo,
    fence,
    workflowId,
    deadlineAt,
    now,
    jobId,
  );
  enqueueOutbox(db, {
    effectKey: `dispatch:${jobId}:${attemptNo}`,
    jobId,
    kind: 'dispatch',
    payload: { workflowId, jobId, attemptNo, fence, kind: job.kind },
  }, now);
  return getJob(db, jobId);
}

export interface Lease {
  jobId: string;
  kind: JobKind;
  sessionId: string | null;
  entityId: string;
  attemptNo: number;
  fence: number;
  /** Job input as canonical JSON text (kept as a string so RPC types stay shallow). */
  inputJson: string;
  deadlineAt: number;
}

/**
 * Lease the job for the attempt its workflow instance was created for.
 * Idempotent for the same attempt; returns null when the attempt lost authority
 * (cancelled, superseded, or already finished).
 */
export function leaseJob(
  db: Db,
  args: { jobId: string; attemptNo: number; fence: number; leaseMs: number },
  now = Date.now(),
): Lease | null {
  const job = getJob(db, args.jobId);
  if (job.attempt_no !== args.attemptNo || job.current_fence !== args.fence) return null;
  if (job.cancel_requested_at !== null) return null;
  if (!['queued', 'leased', 'running'].includes(job.status)) return null;
  if (job.deadline_at < now) {
    finishAttempt(db, job, 'expired', 'DEADLINE_EXCEEDED', now);
    return null;
  }
  db.run(
    `UPDATE job SET status = 'running', lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    now + args.leaseMs,
    now,
    job.id,
  );
  db.run(
    `INSERT OR IGNORE INTO job_attempt (job_id, attempt_no, fence, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
    job.id,
    args.attemptNo,
    args.fence,
    now,
  );
  return {
    jobId: job.id,
    kind: job.kind,
    sessionId: job.session_id,
    entityId: job.entity_id,
    attemptNo: args.attemptNo,
    fence: args.fence,
    inputJson: job.input_json,
    deadlineAt: job.deadline_at,
  };
}

/** Reject any callback from an attempt that no longer holds authority; renew its lease otherwise. */
export function assertFence(
  db: Db,
  args: { jobId: string; fence: number; leaseMs?: number },
  now = Date.now(),
): JobRow {
  const job = getJob(db, args.jobId);
  if (job.current_fence !== args.fence || job.cancel_requested_at !== null || job.status !== 'running') {
    throw new DomainError('STALE_FENCE', 'this job attempt no longer holds authority', {
      jobId: job.id,
      fence: args.fence,
      currentFence: job.current_fence,
      status: job.status,
    });
  }
  if (args.leaseMs) {
    db.run('UPDATE job SET lease_expires_at = ?, updated_at = ? WHERE id = ?', now + args.leaseMs, now, job.id);
  }
  return job;
}

export function finishAttempt(
  db: Db,
  job: JobRow,
  status: 'succeeded' | 'failed' | 'cancelled' | 'expired',
  errorCode: string | null,
  now = Date.now(),
): void {
  db.run(
    `UPDATE job SET status = ?, error_code = ?, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
    status,
    errorCode,
    now,
    job.id,
  );
  db.run(
    `UPDATE job_attempt SET status = ?, finished_at = ? WHERE job_id = ? AND attempt_no = ? AND finished_at IS NULL`,
    status,
    now,
    job.id,
    job.attempt_no,
  );
}

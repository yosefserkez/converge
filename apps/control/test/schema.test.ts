import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { sha256Hex } from '@converge/domain';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../worker/coordinator/db.ts';
import type { ProjectCoordinator } from '../worker/coordinator/index.ts';
import { ACTOR, type Coordinator, freshCoordinator, integrate, jobs, runAgent, sql, startedSession } from './helpers.ts';

const TABLES = [
  'schema_migration', 'project', 'session', 'proposal', 'proposal_revision', 'revision_dependency', 'candidate',
  'candidate_member', 'job', 'job_attempt', 'check_run', 'interaction', 'approval', 'promotion', 'event', 'outbox',
  'request_receipt', 'budget_entry', 'managed_resource', 'evidence', 'intent_version', 'inbox_message',
  'agent_activity', 'preview', 'published_replay',
];

/** Run one statement inside the DO and return the error message, or null when it succeeds. */
function sqlError(stub: Coordinator, query: string, ...params: Array<string | number | null>): Promise<string | null> {
  return runInDurableObject(stub, (_i: ProjectCoordinator, state) => {
    try {
      state.storage.sql.exec(query, ...params);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });
}

describe('migrations in the Durable Object runtime', () => {
  it('creates every table and records each checksum once', async () => {
    const stub = freshCoordinator('migrate');
    await stub.getProjectSummary();
    const names = (await sql<{ name: string }>(stub, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);

    const applied = await sql<{ version: number; checksum: string; applied_at: number }>(
      stub,
      'SELECT version, checksum, applied_at FROM schema_migration ORDER BY version',
    );
    const expected = await Promise.all(MIGRATIONS.map(async (m) => ({ version: m.version, checksum: await sha256Hex(m.sql) })));
    expect(applied.map(({ version, checksum }) => ({ version, checksum }))).toEqual(expected);

    // A new instance over the same storage must not apply the scripts again.
    await evictDurableObject(stub);
    await stub.getProjectSummary();
    const again = await sql<{ version: number; checksum: string; applied_at: number }>(
      stub,
      'SELECT version, checksum, applied_at FROM schema_migration ORDER BY version',
    );
    expect(again).toEqual(applied);
  });

  it('immutability triggers abort updates to sealed and audit rows', async () => {
    const stub = freshCoordinator('triggers');
    const { sessionId } = await startedSession(stub);
    const sealed = await runAgent(stub, 'pricing');
    const [baselineIntegrate] = await jobs(stub, "kind = 'integrate'");
    await integrate(stub, baselineIntegrate!.id);
    const [cand] = await sql<{ id: string; head_sha: string; expected_main_sha: string }>(
      stub,
      'SELECT id, head_sha, expected_main_sha FROM candidate WHERE session_id = ? AND head_sha IS NOT NULL',
      sessionId,
    );
    expect(cand).toBeDefined();
    const now = Date.now();
    await sql(
      stub,
      `INSERT INTO approval (id, candidate_id, head_sha, expected_main_sha, validation_digest, policy_digest, harness_digest,
         actor_subject, decision, expires_at, created_at) VALUES ('appr_test', ?, ?, ?, 'sha256:x', 'sha256:p', 'sha256:h', ?, 'reject', ?, ?)`,
      cand!.id, cand!.head_sha, cand!.expected_main_sha, ACTOR, now + 60_000, now,
    );

    expect(await sqlError(stub, "UPDATE proposal_revision SET head_sha = 'x' WHERE id = ?", sealed.revisionId)).toMatch(
      /sealed proposal revisions are immutable/,
    );
    expect(await sqlError(stub, "UPDATE approval SET decision = 'approve' WHERE id = 'appr_test'")).toMatch(/approval records are immutable/);
    expect(await sqlError(stub, "UPDATE event SET type = 'tampered' WHERE session_id = ?", sessionId)).toMatch(/audit events are append-only/);
    expect(await sqlError(stub, "UPDATE candidate SET head_sha = 'x' WHERE id = ?", cand!.id)).toMatch(
      /materialized candidate source and manifest are immutable/,
    );
    // Other candidate columns stay writable, for example the lifecycle state.
    expect(await sqlError(stub, "UPDATE candidate SET error_json = '{}' WHERE id = ?", cand!.id)).toBeNull();
    // The rows are unchanged.
    const [rev] = await sql<{ head_sha: string }>(stub, 'SELECT head_sha FROM proposal_revision WHERE id = ?', sealed.revisionId);
    expect(rev!.head_sha).toBe(sealed.headSha);
  });

  it('check_run constraints reject a passed run with zero assertions', async () => {
    const stub = freshCoordinator('checks');
    const { sessionId } = await startedSession(stub);
    const [baselineIntegrate] = await jobs(stub, "kind = 'integrate'");
    await integrate(stub, baselineIntegrate!.id);
    const [verifyJob] = await jobs(stub, "kind = 'verify'");
    const [cand] = await sql<{ id: string }>(stub, 'SELECT id FROM candidate WHERE session_id = ?', sessionId);
    const insert = (status: string, applicable: number, assertions: number, failed: number) =>
      sqlError(
        stub,
        `INSERT INTO check_run (id, candidate_id, job_id, check_key, attempt_no, harness_digest, required, applicable,
           applicability_reason, status, assertion_count, failed_count, result_json, evidence_key, evidence_digest, started_at, finished_at)
         VALUES (?, ?, ?, 'quote.contract', ?, 'sha256:h', 1, ?, 'test', ?, ?, ?, '{}', 'private/k', 'sha256:e', 1, 2)`,
        `chk_${status}_${assertions}_${applicable}`, cand!.id, verifyJob!.id, assertions * 10 + applicable, applicable, status, assertions, failed,
      );
    expect(await insert('passed', 1, 0, 0)).toMatch(/CHECK constraint failed/);
    expect(await insert('skipped', 1, 0, 0)).toMatch(/CHECK constraint failed/);
    expect(await insert('failed', 1, 3, 0)).toMatch(/CHECK constraint failed/);
    expect(await insert('passed', 0, 3, 0)).toMatch(/CHECK constraint failed/);
    expect(await insert('passed', 1, 3, 0)).toBeNull();
  });
});

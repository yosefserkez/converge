import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  type ErrorBody,
  MANIFESTS,
  agentJobFor,
  command,
  errorOf,
  fakeSha,
  freshCoordinator,
  jobById,
  jobs,
  lease,
  ok,
  seedProject,
  snapshot,
  sql,
  startAgent,
  startedSession,
  writeDiff,
} from './helpers.ts';

describe('idempotent commands', () => {
  it('replays the same key and body, and rejects the same key with another body', async () => {
    const stub = freshCoordinator('idem');
    await seedProject(stub);
    const params = { mode: 'fixture' };
    const first = await command<{ sessionId: string }>(stub, 'createSession', params, { key: 'idem-key-1' });
    expect(first.status).toBe(201);

    const replay = await command<{ sessionId: string }>(stub, 'createSession', params, { key: 'idem-key-1' });
    expect(replay).toEqual(first);
    expect(await stub.listSessions()).toHaveLength(1);

    const mismatch = await command<ErrorBody>(stub, 'createSession', { mode: 'fixture', modelBudgetMicroUsd: 1 }, { key: 'idem-key-1' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('returns errors as envelopes and does not store them as receipts', async () => {
    const stub = freshCoordinator('idem-error');
    const failed = await command<ErrorBody>(stub, 'createSession', { mode: 'fixture' }, { key: 'idem-key-2' });
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('INVALID_STATE');
    expect(await sql(stub, 'SELECT * FROM request_receipt')).toHaveLength(0);

    // After the cause is fixed, the same key runs the command for real.
    await seedProject(stub);
    const retried = await command<{ sessionId: string }>(stub, 'createSession', { mode: 'fixture' }, { key: 'idem-key-2' });
    expect(retried.status).toBe(201);
    expect(await sql(stub, 'SELECT * FROM request_receipt')).toHaveLength(2);
  });
});

describe('crash between commit and receipt', () => {
  it('a re-run of createSession with the same key returns the same session, not a conflict', async () => {
    const stub = freshCoordinator('idem-crash');
    await seedProject(stub);
    const first = await command<{ sessionId: string }>(stub, 'createSession', { mode: 'fixture' }, { key: 'idem-crash-1' });
    expect(first.status).toBe(201);
    // Simulate a crash after the state commit and before the receipt write.
    await sql(stub, 'DELETE FROM request_receipt');
    const rerun = await command<{ sessionId: string }>(stub, 'createSession', { mode: 'fixture' }, { key: 'idem-crash-1' });
    expect(rerun).toEqual(first);
    expect(await stub.listSessions()).toHaveLength(1);
  });
});

describe('seed', () => {
  it('creates the project, a seed job and an outbox row, then records the seeded head', async () => {
    const stub = freshCoordinator('seed');
    expect(await stub.getProjectSummary()).toMatchObject({ seeded: false });

    const body = await ok<{ jobId: string; projectId: string }>(stub, 'seed');
    const projects = await sql<{ slug: string; observed_main_sha: string | null }>(stub, 'SELECT slug, observed_main_sha FROM project');
    expect(projects).toEqual([{ slug: 'storefront', observed_main_sha: null }]);
    const seedJob = await jobById(stub, body.jobId);
    expect(seedJob).toMatchObject({ kind: 'seed', status: 'queued', attempt_no: 1, current_fence: 1 });
    const outbox = await sql<{ effect_key: string; kind: string; job_id: string }>(stub, 'SELECT effect_key, kind, job_id FROM outbox');
    expect(outbox).toEqual([{ effect_key: `dispatch:${body.jobId}:1`, kind: 'dispatch', job_id: body.jobId }]);

    // The alarm dispatches the outbox row to the (stub) workflow binding.
    await runDurableObjectAlarm(stub);
    const [delivered] = await sql<{ status: string }>(stub, 'SELECT status FROM outbox');
    expect(delivered!.status).toBe('delivered');

    const l = await stub.wfLease(body.jobId, 1, 1);
    expect(l).toMatchObject({ jobId: body.jobId, kind: 'seed', attemptNo: 1, fence: 1 });
    const head = await fakeSha('seeded-head');
    await stub.wfSeeded(body.jobId, 1, { headSha: head, lockfileDigest: `sha256:${'a'.repeat(64)}` });

    const summary = await stub.getProjectSummary();
    expect(summary).toMatchObject({ seeded: true, observedMainSha: head, presetBaselineSha: head, presetCompatible: true, seedJobStatus: 'succeeded' });

    // A second seed is a no-op that reports the seeded head.
    const again = await command<{ mainSha: string }>(stub, 'seed');
    expect(again.status).toBe(200);
    expect(again.body.mainSha).toBe(head);
    expect(await jobs(stub, "kind = 'seed'")).toHaveLength(1);
  });
});

describe('fencing and leases', () => {
  it('refuses a wrong fence and rejects every callback after cancel', async () => {
    const stub = freshCoordinator('fence');
    const { sessionId } = await startedSession(stub);
    const { job } = await agentJobFor(stub, 'pricing');
    expect(await stub.wfLease(job.id, job.attempt_no, job.current_fence + 5)).toBeNull();
    expect(await stub.wfLease(job.id, job.attempt_no + 1, job.current_fence)).toBeNull();

    const { lease: l, input } = await startAgent(stub, 'pricing');
    const [integrateJob] = await jobs(stub, "kind = 'integrate'");
    const integrateLease = await lease(stub, integrateJob!.id);
    const diff = await writeDiff(sessionId, 'pricing', ['src/pricing/compute-unit-price.ts']);
    const lateHead = await fakeSha('late-head');
    const lateTree = await fakeSha('late-tree');

    expect((await ok<{ status: string }>(stub, 'cancelSession', { sessionId })).status).toBe('cancelled');
    expect((await jobById(stub, l.jobId)).current_fence).toBeGreaterThan(l.fence);

    const staleCalls: Array<[string, () => Promise<unknown>]> = [
      ['wfHeartbeat', () => stub.wfHeartbeat(l.jobId, l.fence)],
      ['wfProgress', () => stub.wfProgress(l.jobId, l.fence, 'late progress')],
      ['wfMarkWorking', () => stub.wfMarkWorking(l.jobId, l.fence)],
      ['wfDeclareIntent', () => stub.wfDeclareIntent(l.jobId, l.fence, 1, MANIFESTS.pricing.intent)],
      ['wfReadInbox', () => stub.wfReadInbox(l.jobId, l.fence, 0)],
      ['wfRequestContext', () => stub.wfRequestContext(l.jobId, l.fence)],
      ['wfRegisterEvidence', () => stub.wfRegisterEvidence(l.jobId, l.fence, 'diff', diff)],
      ['wfActivity', () => stub.wfActivity(l.jobId, l.fence, { id: 'act-1', kind: 'fixture', label: 'late', startedAt: Date.now() })],
      ['wfBudgetReserve', () => stub.wfBudgetReserve(l.jobId, l.fence, 'op-late', 1)],
      ['wfAgentBlocked', () => stub.wfAgentBlocked(l.jobId, l.fence, 'late block')],
      [
        'wfSeal',
        () => stub.wfSeal(l.jobId, l.fence, {
          headSha: lateHead,
          treeSha: lateTree,
          baseSha: input.baseSha,
          repoName: input.proposalRepo,
          changedPaths: ['src/pricing/compute-unit-price.ts'],
          diff,
          summary: 'late seal',
        }),
      ],
      ['wfAssembly', () => stub.wfAssembly(integrateLease.jobId, integrateLease.fence)],
      [
        'wfAssembled',
        () => stub.wfAssembled(integrateLease.jobId, integrateLease.fence, {
          status: 'merged',
          headSha: lateHead,
          treeSha: lateTree,
          executionImageDigest: 'img',
        }),
      ],
    ];
    for (const [name, call] of staleCalls) {
      expect(await errorOf(call()), name).toMatch(/^STALE_FENCE:/);
    }
    // A stale failure report is ignored and a stale lease is refused.
    await stub.wfFail(l.jobId, l.fence, 'LATE', 'late failure');
    expect((await jobById(stub, l.jobId)).status).toBe('cancelled');
    expect(await stub.wfLease(l.jobId, l.attemptNo, l.fence)).toBeNull();

    const snap = await snapshot(stub, sessionId);
    expect(snap.session.status).toBe('cancelled');
    expect(snap.proposals.every((p) => p.status === 'cancelled' && p.revisions.length === 0)).toBe(true);
    expect(snap.candidates.every((c) => c.state === 'cancelled' && c.headSha === null)).toBe(true);
    const effects = await sql<{ kind: string }>(stub, "SELECT kind FROM outbox WHERE kind IN ('terminate', 'cleanup')");
    expect(effects.length).toBeGreaterThan(0);
  });

  it('retryJob creates a new attempt with a larger fence', async () => {
    const stub = freshCoordinator('retry');
    const { sessionId } = await startedSession(stub);
    const { lease: l } = await startAgent(stub, 'caching');
    await stub.wfFail(l.jobId, l.fence, 'CONTAINER_LOST', 'simulated infrastructure failure');
    expect((await jobById(stub, l.jobId)).status).toBe('failed');
    expect((await snapshot(stub, sessionId)).session.status).toBe('needs_attention');

    const retried = await command<{ jobId: string; attemptNo: number }>(stub, 'retryJob', { jobId: l.jobId });
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(retried.body.attemptNo).toBe(2);
    const job = await jobById(stub, l.jobId);
    expect(job).toMatchObject({ status: 'queued', attempt_no: 2 });
    expect(job.current_fence).toBeGreaterThan(l.fence);
    expect((await snapshot(stub, sessionId)).session.status).toBe('running');
    const dispatch = await sql(stub, 'SELECT * FROM outbox WHERE effect_key = ?', `dispatch:${l.jobId}:2`);
    expect(dispatch).toHaveLength(1);

    // The old attempt has lost authority; the new attempt can lease and work.
    expect(await stub.wfLease(l.jobId, 1, l.fence)).toBeNull();
    expect(await errorOf(stub.wfHeartbeat(l.jobId, l.fence))).toMatch(/^STALE_FENCE:/);
    const next = await stub.wfLease(l.jobId, 2, job.current_fence);
    expect(next).toMatchObject({ attemptNo: 2, fence: job.current_fence });
    await stub.wfHeartbeat(l.jobId, job.current_fence);
    const attempts = await sql<{ attempt_no: number; fence: number; status: string }>(
      stub,
      'SELECT attempt_no, fence, status FROM job_attempt WHERE job_id = ? ORDER BY attempt_no',
      l.jobId,
    );
    expect(attempts).toEqual([
      { attempt_no: 1, fence: l.fence, status: 'failed' },
      { attempt_no: 2, fence: job.current_fence, status: 'running' },
    ]);
  });
});

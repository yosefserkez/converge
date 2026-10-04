import { balances, type ChangeIntent, type Json, type LedgerEntry, type TaskSpec } from '@converge/domain';
import type { AppConfig } from '../config.ts';
import { type Db, parse } from './db.ts';
import type { CandidateRow, CheckRunRow, ProjectRow, ProposalRow, RevisionRow, SessionPolicy, SessionRow } from './model.ts';
import { candidateCapabilities, candidateMembers, isFullGoal } from './orchestrate.ts';

export type SessionSnapshot = ReturnType<typeof buildSnapshot>;

/** One consistent read of everything the operator UI shows, plus an event watermark. */
export function buildSnapshot(db: Db, sessionId: string, config: AppConfig) {
  const s = db.one<SessionRow>('SELECT * FROM session WHERE id = ?', sessionId)!;
  const project = db.one<ProjectRow>('SELECT * FROM project LIMIT 1');
  const policy = parse<SessionPolicy>(s.policy_json);
  const ledger = db
    .all<{ kind: LedgerEntry['kind']; operation_key: string; reserved_delta_microusd: number; spent_delta_microusd: number; uncertain_delta_microusd: number }>(
      'SELECT kind, operation_key, reserved_delta_microusd, spent_delta_microusd, uncertain_delta_microusd FROM budget_entry WHERE session_id = ? ORDER BY created_at, rowid',
      sessionId,
    )
    .map((e) => ({
      kind: e.kind,
      reservationId: e.operation_key.replace(/^[a-z]+:/, ''),
      reservedDelta: e.reserved_delta_microusd,
      spentDelta: e.spent_delta_microusd,
      uncertainDelta: e.uncertain_delta_microusd,
    }));
  const budget = balances(ledger);
  const jobs = db.all<{ id: string; kind: string; entity_id: string; status: string; attempt_no: number; error_code: string | null; updated_at: number }>(
    'SELECT id, kind, entity_id, status, attempt_no, error_code, updated_at FROM job WHERE session_id = ? ORDER BY created_at',
    sessionId,
  );
  const lastProgress = new Map<string, { message: string; at: number }>();
  for (const e of db.all<{ entity_id: string; payload_json: string; created_at: number }>(
    "SELECT entity_id, payload_json, created_at FROM event WHERE session_id = ? AND type = 'agent.progress' ORDER BY seq",
    sessionId,
  )) {
    lastProgress.set(e.entity_id, { message: parse<{ message: string }>(e.payload_json).message, at: e.created_at });
  }

  const proposals = db.all<ProposalRow>('SELECT * FROM proposal WHERE session_id = ? ORDER BY created_at, id', sessionId).map((p) => {
    const task = parse<TaskSpec>(p.task_spec_json);
    const job = [...jobs].reverse().find((j) => j.kind === 'agent' && j.entity_id === p.id);
    return {
      id: p.id,
      title: p.title,
      kind: p.kind,
      role: task.role,
      status: p.status,
      objective: task.objective,
      editablePaths: task.editablePaths,
      capabilityIds: task.capabilityIds,
      baseCandidateId: p.base_candidate_id,
      repoName: p.repo_name,
      intent: p.draft_intent_json ? parse<ChangeIntent>(p.draft_intent_json) : null,
      intentVersion: p.intent_version,
      summary: p.summary,
      progress: lastProgress.get(p.id) ?? null,
      job: job ? { id: job.id, status: job.status, attemptNo: job.attempt_no, errorCode: job.error_code } : null,
      revisions: db.all<RevisionRow>('SELECT * FROM proposal_revision WHERE proposal_id = ? ORDER BY revision_no', p.id).map((r) => ({
        id: r.id,
        revisionNo: r.revision_no,
        repoName: r.repo_name,
        baseSha: r.base_sha,
        headSha: r.head_sha,
        treeSha: r.tree_sha,
        intentDigest: r.intent_digest,
        diffEvidenceId: db.value<string>('SELECT id FROM evidence WHERE r2_key = ?', r.diff_evidence_key) ?? null,
        dependencies: db.all<{ d: string }>('SELECT dependency_revision_id AS d FROM revision_dependency WHERE revision_id = ?', r.id).map((x) => x.d),
        createdAt: r.created_at,
      })),
    };
  });

  const candidates = db.all<CandidateRow>('SELECT * FROM candidate WHERE session_id = ? ORDER BY created_at, id', sessionId).map((c) => {
    const caps = candidateCapabilities(db, c.id);
    const runs = db.all<CheckRunRow>('SELECT * FROM check_run WHERE candidate_id = ? ORDER BY check_key, attempt_no', c.id);
    const latest = new Map<string, CheckRunRow>();
    for (const r of runs) latest.set(r.check_key, r);
    return {
      id: c.id,
      label: c.label,
      state: c.state,
      headSha: c.head_sha,
      treeSha: c.tree_sha,
      repoName: c.repo_name,
      members: candidateMembers(db, c.id),
      anchorCandidateId: c.anchor_candidate_id,
      capabilities: [...caps],
      fullGoal: isFullGoal(caps, policy.fullGoalCapabilities),
      promotable: c.promotable === 1,
      validationDigest: c.validation_digest,
      manifestDigest: c.manifest_digest,
      error: c.error_json ? parse<{ [key: string]: Json }>(c.error_json) : null,
      createdAt: c.created_at,
      checks: [...latest.values()].map((r) => ({
        id: r.id,
        checkId: r.check_key,
        status: r.status,
        applicable: r.applicable === 1,
        applicabilityReason: r.applicability_reason,
        assertionCount: r.assertion_count,
        failedCount: r.failed_count,
        attemptNo: r.attempt_no,
        evidenceId: r.evidence_key ? db.value<string>('SELECT id FROM evidence WHERE r2_key = ?', r.evidence_key) ?? null : null,
      })),
    };
  });

  const interactions = db
    .all<Record<string, SqlStorageValue>>('SELECT * FROM interaction WHERE session_id = ? ORDER BY created_at, id', sessionId)
    .map((i) => ({
      id: String(i.id),
      kind: String(i.kind),
      state: String(i.state),
      contractKey: (i.contract_key as string | null) ?? null,
      leftProposalId: String(i.left_proposal_id),
      rightProposalId: String(i.right_proposal_id),
      leftIntentDigest: String(i.left_intent_digest),
      rightIntentDigest: String(i.right_intent_digest),
      explanation: String(i.explanation),
      failedCandidateId: (i.failed_candidate_id as string | null) ?? null,
      failedCheckRunId: (i.failed_check_id as string | null) ?? null,
      failedCheck: i.failed_check_id
        ? (() => {
            const run = db.one<CheckRunRow>('SELECT * FROM check_run WHERE id = ?', String(i.failed_check_id));
            return run?.result_json ? { checkId: run.check_key, result: parse<Json>(run.result_json) } : null;
          })()
        : null,
      resolvedCandidateId: (i.resolved_candidate_id as string | null) ?? null,
      resolutionCheckRunId: (i.resolution_check_id as string | null) ?? null,
    }));

  const approvals = db.all<Record<string, SqlStorageValue>>(
    `SELECT a.id, a.candidate_id, a.decision, a.head_sha, a.expected_main_sha, a.validation_digest, a.actor_subject, a.expires_at, a.created_at
     FROM approval a JOIN candidate c ON c.id = a.candidate_id WHERE c.session_id = ? ORDER BY a.created_at`,
    sessionId,
  );
  const promotions = db.all<Record<string, SqlStorageValue>>(
    `SELECT p.id, p.approval_id, p.state, p.before_sha, p.target_sha, p.observed_remote_sha, p.created_at, p.updated_at
     FROM promotion p JOIN approval a ON a.id = p.approval_id JOIN candidate c ON c.id = a.candidate_id
     WHERE c.session_id = ? ORDER BY p.created_at`,
    sessionId,
  );
  const activity = db.all<{ id: string; job_id: string; attempt_no: number; kind: string; label: string; started_at: number; finished_at: number | null }>(
    'SELECT id, job_id, attempt_no, kind, label, started_at, finished_at FROM agent_activity WHERE session_id = ? ORDER BY started_at LIMIT 2000',
    sessionId,
  );
  const jobToProposal = new Map(jobs.filter((j) => j.kind === 'agent').map((j) => [j.id, j.entity_id]));

  return {
    session: {
      id: s.id,
      objective: s.objective,
      mode: s.mode,
      status: s.status,
      baselineSha: s.baseline_sha,
      expectedMainSha: policy.expectedMainSha,
      taskSetDigest: s.task_set_digest,
      policyDigest: s.policy_digest,
      harnessDigest: s.harness_digest,
      modelId: policy.modelId,
      createdBy: s.created_by,
      createdAt: s.created_at,
      finishedAt: s.finished_at,
      budget: { ceilingMicroUsd: s.model_budget_microusd, ...budget },
      reason: db.value<string>(
        "SELECT json_extract(payload_json, '$.reason') FROM event WHERE session_id = ? AND entity_type = 'session' AND type LIKE 'session.%' ORDER BY seq DESC LIMIT 1",
        sessionId,
      ) ?? null,
    },
    project: project
      ? { slug: project.slug, canonicalRepo: project.canonical_repo, observedMainSha: project.observed_main_sha }
      : null,
    limits: { maxRepairAttempts: policy.maxRepairAttempts, maxCandidates: policy.maxCandidates, liveEnabled: config.LIVE_EXECUTION_ENABLED },
    proposals,
    candidates,
    interactions,
    approvals,
    promotions,
    activity: activity.map((a) => ({
      id: a.id,
      proposalId: jobToProposal.get(a.job_id) ?? null,
      attemptNo: a.attempt_no,
      kind: a.kind,
      label: a.label,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
    })),
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, entityId: j.entity_id, status: j.status, attemptNo: j.attempt_no, errorCode: j.error_code })),
    watermark: db.value<number>('SELECT coalesce(max(seq), 0) FROM event') ?? 0,
  };
}

export function listEvents(db: Db, sessionId: string, after: number, limit: number) {
  const bounded = Math.min(Math.max(limit, 1), 500);
  const events = db
    .all<{ seq: number; type: string; actor: string; entity_type: string; entity_id: string; payload_json: string; visibility: string; created_at: number }>(
      'SELECT seq, type, actor, entity_type, entity_id, payload_json, visibility, created_at FROM event WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      sessionId,
      Math.max(after, 0),
      bounded,
    )
    .map((e) => ({
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      entityType: e.entity_type,
      entityId: e.entity_id,
      payload: parse<{ [key: string]: Json }>(e.payload_json),
      visibility: e.visibility as 'private' | 'public',
      createdAt: e.created_at,
    }));
  const cursor = events.length ? events[events.length - 1]!.seq : Math.max(after, 0);
  return { events, cursor, hasMore: events.length === bounded };
}

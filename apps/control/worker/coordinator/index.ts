import { DurableObject } from 'cloudflare:workers';
import {
  type CandidateManifest,
  ChangeIntent,
  type CheckResult,
  DomainError,
  type EvidenceRef,
  REPAIR_OBJECTIVE,
  type TaskSpec,
  type ValidationManifest,
  approvalEligibility,
  asDomainError,
  toEnvelope,
  assertTransition,
  balances,
  buildValidationManifest,
  canReserve,
  classifyEdits,
  decideReceipt,
  digestOf,
  newId,
  planKey,
  releaseEntry,
  repoNameFor,
  reserveEntry,
  settleEntry,
  uncertainEntry,
  type LedgerEntry,
  type Json,
  type BaselineFacts,
  type CheckStatus,
  type Capability,
  type CheckDefinition,
} from '@converge/domain';
import { resultInvariantViolations } from '@converge/verification';
import { loadConfig } from '../config.ts';
import { harnessDigestFor, projectDefinition } from '../projects.ts';
import { Db, json, migrate, parse } from './db.ts';
import type { CandidateRow, CheckRunRow, ProjectPolicy, ProjectRow, ProposalRow, RevisionRow, SessionPolicy, SessionRow } from './model.ts';
import { ACTIVE_SESSION_STATES } from './model.ts';
import {
  SYSTEM_ACTOR,
  applicableChecks,
  candidateCapabilities,
  candidateMembers,
  decideNext,
  draftPlan,
  getSession,
  initialPlanInputs,
  insertCandidate,
  isFullGoal,
  sessionFullGoal,
  sessionProject,
  latestRevision,
  latestRuns,
  proposalsOf,
  refreshInteractions,
  setCandidateState,
  setSessionStatus,
  taskOf,
  updateInteractionsFromEvidence,
  type PlanInput,
} from './orchestrate.ts';
import { type Lease, appendEvent, assertFence, createJob, enqueueOutbox, finishAttempt, getJob, leaseJob, queueAttempt } from './store.ts';
import { buildSnapshot, listEvents, type SessionSnapshot } from './queries.ts';
import { verifyEvidence, writeEvidence } from '../evidence.ts';
import { redactReplay } from '../replay.ts';

export type CommandType =
  | 'seed'
  | 'createSession'
  | 'startSession'
  | 'cancelSession'
  | 'retryJob'
  | 'requestRepair'
  | 'approve'
  | 'promote'
  | 'createPreview'
  | 'publishReplay';

export interface CommandEnvelope {
  type: CommandType;
  actor: string;
  idempotencyKey: string;
  requestDigest: string;
  params: Record<string, unknown>;
}

export interface CommandResult {
  status: number;
  body: Json;
}

const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const APPROVAL_TTL_MS = 30 * 60_000;

export class ProjectCoordinator extends DurableObject<Env> {
  private readonly db: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage);
    void ctx.blockConcurrencyWhile(() => migrate(this.db));
  }

  private get config() {
    return loadConfig(this.env);
  }

  private get leaseMs() {
    return this.config.LEASE_SECONDS * 1000;
  }

  /** Arm the alarm before a state transaction so a committed outbox item is never lost. */
  private armAlarm(at = Date.now()): void {
    void this.ctx.storage.setAlarm(at);
  }

  // =====================================================================
  // Operator commands (idempotent, actor from verified auth)
  // =====================================================================

  /** RPC entry: returns the response body as JSON text so the RPC type stays shallow. */
  async command(cmd: CommandEnvelope): Promise<{ status: number; bodyJson: string }> {
    const r = await this.runCommand(cmd);
    return { status: r.status, bodyJson: JSON.stringify(r.body) };
  }

  private async runCommand(cmd: CommandEnvelope): Promise<CommandResult> {
    const scope = `${cmd.actor}|${this.config.PROJECT_SLUG}|${cmd.type}`;
    const prior = this.db.one<{ request_digest: string; status_code: number; response_json: string; expires_at: number }>(
      'SELECT request_digest, status_code, response_json, expires_at FROM request_receipt WHERE scope = ? AND idempotency_key = ?',
      scope,
      cmd.idempotencyKey,
    );
    const decision = decideReceipt(prior ? { requestDigest: prior.request_digest } : null, cmd.requestDigest);
    if (decision === 'replay' && prior) return { status: prior.status_code, body: parse<Json>(prior.response_json) };
    if (decision === 'mismatch') {
      const err = new DomainError('IDEMPOTENCY_MISMATCH', 'this Idempotency-Key was already used with a different request body');
      return { status: err.status, body: toEnvelope(err, '') as unknown as Json };
    }
    let result: CommandResult;
    try {
      result = await this.dispatchCommand(cmd);
    } catch (err) {
      const domain = asDomainError(err);
      if (!domain) throw err;
      // Errors are returned (not thrown) so the code and details survive RPC. They are not stored as receipts.
      return { status: domain.status, body: toEnvelope(domain, '') as unknown as Json };
    }
    const now = Date.now();
    this.db.run(
      `INSERT OR REPLACE INTO request_receipt (scope, idempotency_key, request_digest, status_code, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      scope,
      cmd.idempotencyKey,
      cmd.requestDigest,
      result.status,
      json(result.body),
      now,
      now + RECEIPT_TTL_MS,
    );
    return result;
  }

  private async dispatchCommand(cmd: CommandEnvelope): Promise<CommandResult> {
    const p = cmd.params;
    switch (cmd.type) {
      case 'seed':
        return this.seed(cmd.actor);
      case 'createSession':
        return this.createSession(cmd.actor, p as { mode: 'live' | 'fixture'; modelBudgetMicroUsd?: number }, await commandId('ses', cmd));
      case 'startSession':
        return this.startSession(cmd.actor, String(p.sessionId));
      case 'cancelSession':
        return this.cancelSession(cmd.actor, String(p.sessionId));
      case 'retryJob':
        return this.retryJob(cmd.actor, String(p.jobId));
      case 'requestRepair':
        return this.requestRepair(cmd.actor, String(p.candidateId));
      case 'approve':
        return this.approve(cmd.actor, p as never, await commandId('appr', cmd));
      case 'promote':
        return this.promote(cmd.actor, String(p.approvalId));
      case 'createPreview':
        return this.createPreview(cmd.actor, String(p.candidateId));
      case 'publishReplay':
        return this.publishReplay(cmd.actor, String(p.sessionId));
    }
  }

  private project(): ProjectRow | undefined {
    return this.db.one<ProjectRow>('SELECT * FROM project LIMIT 1');
  }

  private requireProject(): ProjectRow {
    const p = this.project();
    if (!p) throw new DomainError('INVALID_STATE', 'project is not seeded; run the authenticated seed command first');
    return p;
  }

  private async seed(actor: string): Promise<CommandResult> {
    const now = Date.now();
    const slug = this.config.PROJECT_SLUG;
    const existing = this.project();
    if (existing?.observed_main_sha) {
      return { status: 200, body: { projectId: existing.id, canonicalRepo: existing.canonical_repo, mainSha: existing.observed_main_sha } };
    }
    const canonicalRepo = repoNameFor('baseline', slug, 'main');
    const inputDigest = await digestOf({ canonicalRepo, fixture: 'storefront' });
    this.armAlarm();
    const job = this.db.tx(() => {
      if (!existing) {
        const policy: ProjectPolicy = { seededBaselineSha: null, lockfileDigest: null, seedJobId: null };
        this.db.run(
          `INSERT INTO project (id, slug, canonical_repo, default_branch, policy_json, created_at, updated_at)
           VALUES (?, ?, ?, 'main', ?, ?, ?)`,
          slug,
          slug,
          canonicalRepo,
          json(policy),
          now,
          now,
        );
        this.db.run(
          `INSERT OR IGNORE INTO managed_resource (id, kind, external_name, state, retain, created_at, updated_at)
           VALUES (?, 'artifact_repo', ?, 'reserved', 1, ?, ?)`,
          newId('res'),
          canonicalRepo,
          now,
          now,
        );
      }
      const j = createJob(this.db, {
        sessionId: null,
        kind: 'seed',
        entityId: slug,
        input: { canonicalRepo },
        inputDigest,
        dedupeKey: `seed:${slug}`,
        deadlineAt: now + 15 * 60_000,
      }, now);
      appendEvent(this.db, {
        sessionId: null,
        key: `project:${slug}:seed-requested`,
        type: 'project.seed_requested',
        actor,
        entityType: 'project',
        entityId: slug,
        correlationId: slug,
        payload: { canonicalRepo },
        visibility: 'private',
      }, now);
      return j;
    });
    return { status: 202, body: { projectId: slug, canonicalRepo, jobId: job.id } };
  }

  private async createSession(actor: string, params: { mode: 'live' | 'fixture'; modelBudgetMicroUsd?: number }, sessionId: string): Promise<CommandResult> {
    // A re-run after a crash between the state commit and the receipt finds the same session.
    if (this.db.value<string>('SELECT id FROM session WHERE id = ?', sessionId)) return { status: 201, body: { sessionId } };
    const cfg = this.config;
    const project = this.requireProject();
    const projectPolicy = parse<ProjectPolicy>(project.policy_json);
    const mainSha = project.observed_main_sha;
    if (!mainSha || !projectPolicy.seededBaselineSha || !projectPolicy.lockfileDigest) {
      throw new DomainError('INVALID_STATE', 'project seed has not completed');
    }
    if (mainSha !== projectPolicy.seededBaselineSha) {
      throw new DomainError('INVALID_STATE', 'canonical main no longer equals the preset baseline; provision a fresh demo project', {
        observedMainSha: mainSha,
        presetBaselineSha: projectPolicy.seededBaselineSha,
      });
    }
    const active = this.db.value<number>(
      `SELECT count(*) FROM session WHERE status IN (${ACTIVE_SESSION_STATES.map(() => '?').join(',')})`,
      ...ACTIVE_SESSION_STATES,
    );
    if (active) throw new DomainError('ACTIVE_SESSION_EXISTS', 'another mutating session is active for this project');
    const mode = params.mode === 'live' ? 'live' : 'fixture';
    const budget = mode === 'live' ? (params.modelBudgetMicroUsd ?? cfg.DEFAULT_MODEL_BUDGET_MICROUSD) : 0;
    if (mode === 'live') {
      if (!cfg.LIVE_EXECUTION_ENABLED) throw new DomainError('LIVE_DISABLED', 'live execution is disabled in this environment');
      if (!this.env.ANTHROPIC_API_KEY) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'model provider secret is not configured');
      if (budget <= 0 || budget > cfg.DEFAULT_MODEL_BUDGET_MICROUSD) {
        throw new DomainError('INVALID_INPUT', 'live sessions need a positive budget no larger than the operator-approved default', {
          maxMicroUsd: cfg.DEFAULT_MODEL_BUDGET_MICROUSD,
        });
      }
    }
    const now = Date.now();
    const def = projectDefinition(cfg.PROJECT_KIND);
    const tasks: TaskSpec[] = def.tasks.map((t) => ({ ...t, baselineSha: mainSha }));
    const environmentDigest = await digestOf({ lockfileDigest: projectPolicy.lockfileDigest, verifierBuildId: cfg.BUILD_ID, image: 'workspace' });
    const policy: SessionPolicy = {
      projectKind: def.kind,
      maxCandidates: cfg.MAX_CANDIDATES_PER_SESSION,
      maxRepairAttempts: cfg.MAX_REPAIR_ATTEMPTS,
      maxAgentTurns: cfg.MAX_AGENT_TURNS,
      fullGoalCapabilities: [...def.fullGoalCapabilities],
      protectedPaths: [...def.protectedPaths],
      lockfileDigest: projectPolicy.lockfileDigest,
      environmentDigest,
      expectedMainSha: mainSha,
      modelId: mode === 'live' ? cfg.MODEL_ID : null,
      priceSnapshot: mode === 'live' ? cfg.MODEL_PRICE_SNAPSHOT : null,
    };
    const [taskSetDigest, policyDigest, harness, taskDigests] = await Promise.all([
      digestOf(tasks),
      digestOf(policy),
      harnessDigestFor(def.suite),
      Promise.all(tasks.map((t) => digestOf(t))),
    ]);
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO session (id, project_id, objective, mode, baseline_sha, task_set_json, task_set_digest, baseline_facts_json,
           policy_json, policy_digest, harness_digest, model_budget_microusd, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
        sessionId,
        project.id,
        def.goal,
        mode,
        mainSha,
        json(tasks),
        taskSetDigest,
        json(def.baselineFacts),
        json(policy),
        policyDigest,
        harness,
        budget,
        actor,
        now,
      );
      tasks.forEach((t, i) => {
        const id = newId('prop');
        this.db.run(
          `INSERT INTO proposal (id, session_id, title, kind, task_spec_json, task_spec_digest, status, repo_name, created_at, updated_at)
           VALUES (?, ?, ?, 'feature', ?, ?, 'pending', ?, ?, ?)`,
          id,
          sessionId,
          t.title,
          json(t),
          taskDigests[i]!,
          repoNameFor('proposal', sessionId, t.role),
          now + i,
          now + i,
        );
      });
      appendEvent(this.db, {
        sessionId,
        key: `session:${sessionId}:created`,
        type: 'session.created',
        actor,
        entityType: 'session',
        entityId: sessionId,
        correlationId: sessionId,
        payload: { mode, baselineSha: mainSha, taskSetDigest, budgetMicroUsd: budget },
      }, now);
    });
    return { status: 201, body: { sessionId } };
  }

  private async startSession(actor: string, sessionId: string): Promise<CommandResult> {
    const session = getSession(this.db, sessionId);
    if (session.status !== 'created') throw new DomainError('INVALID_STATE', `session is ${session.status}`);
    const project = this.requireProject();
    const baselinePlan = draftPlan(this.db, session, { label: 'Baseline', memberRevisionIds: [] });
    const key = await planKey(baselinePlan);
    const now = Date.now();
    const integrationRepo = repoNameFor('candidate', sessionId, 'int');
    const inputs = await Promise.all(
      proposalsOf(this.db, sessionId).map(async (p) => {
        const input = {
          sessionId,
          proposalId: p.id,
          mode: session.mode,
          role: taskOf(p).role,
          baseRepo: project.canonical_repo,
          baseSha: session.baseline_sha,
          proposalRepo: p.repo_name!,
        };
        return { p, input, digest: await digestOf(input) };
      }),
    );
    this.armAlarm();
    this.db.tx(() => {
      setSessionStatus(this.db, session, 'preflight', 'start requested', now);
      setSessionStatus(this.db, session, 'running', 'agents dispatched', now);
      for (const { p, input, digest } of inputs) {
        createJob(this.db, {
          sessionId,
          kind: 'agent',
          entityId: p.id,
          input,
          inputDigest: digest,
          dedupeKey: `agent:${p.id}:1`,
          deadlineAt: now + this.config.AGENT_DEADLINE_SECONDS * 1000,
        }, now);
      }
      insertCandidate(this.db, session, baselinePlan, key, integrationRepo, now);
      appendEvent(this.db, {
        sessionId,
        key: `session:${sessionId}:started`,
        type: 'session.started',
        actor,
        entityType: 'session',
        entityId: sessionId,
        correlationId: sessionId,
        payload: { agents: inputs.length },
      }, now);
    });
    return { status: 202, body: { sessionId, status: 'running' } };
  }

  private async cancelSession(actor: string, sessionId: string): Promise<CommandResult> {
    const session = getSession(this.db, sessionId);
    if (!ACTIVE_SESSION_STATES.includes(session.status) && session.status !== 'needs_attention') {
      throw new DomainError('INVALID_STATE', `session is already ${session.status}`);
    }
    const now = Date.now();
    this.armAlarm();
    this.db.tx(() => {
      const jobs = this.db.all<{ id: string; workflow_id: string | null; status: string }>(
        "SELECT id, workflow_id, status FROM job WHERE session_id = ? AND status IN ('queued','leased','running')",
        sessionId,
      );
      for (const j of jobs) {
        // Invalidate authority first: bump the fence so any late callback is rejected.
        this.db.run(
          `UPDATE job SET cancel_requested_at = ?, current_fence = current_fence + 1, status = 'cancelled',
             lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
          now,
          now,
          j.id,
        );
        this.db.run("UPDATE job_attempt SET status = 'cancelled', finished_at = ? WHERE job_id = ? AND finished_at IS NULL", now, j.id);
        if (j.workflow_id) {
          enqueueOutbox(this.db, { effectKey: `terminate:${j.workflow_id}`, jobId: j.id, kind: 'terminate', payload: { workflowId: j.workflow_id } }, now);
        }
        enqueueOutbox(this.db, { effectKey: `cleanup:${j.id}`, jobId: j.id, kind: 'cleanup', payload: { jobId: j.id } }, now);
      }
      this.db.run(
        "UPDATE proposal SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('pending','working')",
        now,
        sessionId,
      );
      for (const c of this.db.all<CandidateRow>(
        "SELECT * FROM candidate WHERE session_id = ? AND state IN ('planned','assembling','testing')",
        sessionId,
      )) {
        setCandidateState(this.db, c, 'cancelled', now);
      }
      // A model request in flight at cancel time has an unknown outcome: book it as uncertain, never as free.
      for (const r of this.db.all<{ operation_key: string; job_id: string; reserved_delta_microusd: number }>(
        `SELECT b.operation_key, b.job_id, b.reserved_delta_microusd FROM budget_entry b
         WHERE b.session_id = ? AND b.kind = 'reserve'
           AND NOT EXISTS (SELECT 1 FROM budget_entry s WHERE s.operation_key = 'settle:' || substr(b.operation_key, 9))`,
        sessionId,
      )) {
        const reservationId = r.operation_key.replace(/^reserve:/, '');
        this.insertLedger(sessionId, r.job_id, `settle:${reservationId}`, uncertainEntry({ reservationId, amountMicroUsd: r.reserved_delta_microusd }), { outcome: 'uncertain', reason: 'cancelled while in flight' }, now);
      }
      setSessionStatus(this.db, session, 'cancelled', `cancelled by ${actor}`, now);
      appendEvent(this.db, {
        sessionId,
        key: `session:${sessionId}:cancel:${now}`,
        type: 'job.cancelled',
        actor,
        entityType: 'session',
        entityId: sessionId,
        correlationId: sessionId,
        payload: { jobs: jobs.length },
      }, now);
    });
    return { status: 202, body: { sessionId, status: 'cancelled' } };
  }

  private async retryJob(actor: string, jobId: string): Promise<CommandResult> {
    const job = getJob(this.db, jobId);
    if (!['failed', 'expired'].includes(job.status)) throw new DomainError('INVALID_STATE', `job is ${job.status}`);
    if (job.session_id) {
      const s = getSession(this.db, job.session_id);
      if (!ACTIVE_SESSION_STATES.includes(s.status) && s.status !== 'needs_attention') {
        throw new DomainError('INVALID_STATE', `session is ${s.status}`);
      }
    }
    if (job.attempt_no >= 3) throw new DomainError('LIMIT_EXCEEDED', 'retry limit reached for this job');
    const now = Date.now();
    this.armAlarm();
    const updated = this.db.tx(() => {
      const j = queueAttempt(this.db, jobId, now);
      if (job.kind === 'integrate' || job.kind === 'verify') {
        const c = this.db.one<CandidateRow>('SELECT * FROM candidate WHERE id = ?', job.entity_id);
        if (c?.state === 'error') {
          this.db.run('UPDATE candidate SET error_json = NULL WHERE id = ?', c.id);
          setCandidateState(this.db, c, job.kind === 'integrate' ? 'planned' : 'testing', now, { retry: j.attempt_no });
        }
      }
      if (job.kind === 'agent') {
        this.db.run("UPDATE proposal SET status = 'pending', summary = NULL, updated_at = ? WHERE id = ? AND status = 'blocked'", now, job.entity_id);
      }
      if (job.session_id) {
        const s = getSession(this.db, job.session_id);
        if (s.status === 'needs_attention') setSessionStatus(this.db, s, this.resumeStatus(s.id), 'retry requested', now);
      }
      appendEvent(this.db, {
        sessionId: job.session_id,
        key: `job:${jobId}:retry:${j.attempt_no}`,
        type: 'job.retried',
        actor,
        entityType: 'job',
        entityId: jobId,
        correlationId: job.session_id ?? jobId,
        payload: { attemptNo: j.attempt_no },
      }, now);
      return j;
    });
    return { status: 202, body: { jobId, attemptNo: updated.attempt_no } };
  }

  private async requestRepair(actor: string, candidateId: string): Promise<CommandResult> {
    const c = this.candidateRow(candidateId);
    if (c.state !== 'failed') throw new DomainError('INVALID_STATE', 'only a failed candidate can be repaired');
    const session = getSession(this.db, c.session_id);
    const policy = parse<SessionPolicy>(session.policy_json);
    const repairs = this.db.value<number>("SELECT count(*) FROM proposal WHERE session_id = ? AND kind = 'repair'", session.id) ?? 0;
    if (repairs >= policy.maxRepairAttempts) throw new DomainError('LIMIT_EXCEEDED', 'repair limit reached');
    const proposalId = await this.assignRepair(session, c, actor);
    return { status: 202, body: { proposalId } };
  }

  /** Create an additive repair proposal anchored on the exact failed candidate. */
  private async assignRepair(session: SessionRow, failed: CandidateRow, actor: string): Promise<string> {
    const existing = this.db.one<{ id: string }>("SELECT id FROM proposal WHERE base_candidate_id = ? AND kind = 'repair'", failed.id);
    if (existing) return existing.id;
    if (!failed.head_sha) throw new DomainError('INVALID_STATE', 'failed candidate is not materialized');
    const members = candidateMembers(this.db, failed.id);
    const memberProposals = members
      .map((r) => this.db.one<ProposalRow>('SELECT p.* FROM proposal p JOIN proposal_revision r ON r.proposal_id = p.id WHERE r.id = ?', r)!)
      .filter(Boolean);
    const editable = [...new Set(memberProposals.flatMap((p) => taskOf(p).editablePaths))];
    const repairNo = (this.db.value<number>("SELECT count(*) FROM proposal WHERE session_id = ? AND kind = 'repair'", session.id) ?? 0) + 1;
    const failing = latestRuns(this.db, failed.id).filter((r) => r.status === 'failed' || r.status === 'error');
    const task: TaskSpec = {
      id: `task-repair-${repairNo}`,
      title: `Repair ${repairNo}`,
      role: 'repair',
      objective: REPAIR_OBJECTIVE,
      capabilityIds: [],
      editablePaths: editable,
      forbiddenPaths: [...sessionProject(session).protectedPaths],
      requiredCheckIds: [...new Set(memberProposals.flatMap((p) => taskOf(p).requiredCheckIds))],
      preservedInvariantIds: [...new Set(memberProposals.flatMap((p) => taskOf(p).preservedInvariantIds))],
      baselineSha: failed.head_sha,
      ordinal: 100 + repairNo,
    };
    const counterexample = {
      candidateId: failed.id,
      candidateLabel: failed.label,
      headSha: failed.head_sha,
      dependencyRevisionIds: members,
      failedChecks: failing.map((r) => ({
        checkId: r.check_key,
        evidenceKey: r.evidence_key,
        observations: r.result_json ? (parse<CheckResult>(r.result_json).observations ?? []).filter((o) => !o.passed).slice(0, 8) : [],
      })),
    };
    const proposalId = newId('prop');
    const repoName = repoNameFor('proposal', session.id, `repair${repairNo}`);
    const taskDigest = await digestOf(task);
    const input = {
      sessionId: session.id,
      proposalId,
      mode: session.mode,
      role: 'repair',
      baseRepo: failed.repo_name,
      baseSha: failed.head_sha,
      proposalRepo: repoName,
      counterexample,
    };
    const inputDigest = await digestOf(input);
    const now = Date.now();
    this.armAlarm();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO proposal (id, session_id, title, kind, task_spec_json, task_spec_digest, base_candidate_id, status, repo_name, created_at, updated_at)
         VALUES (?, ?, ?, 'repair', ?, ?, ?, 'pending', ?, ?, ?)`,
        proposalId,
        session.id,
        task.title,
        json(task),
        taskDigest,
        failed.id,
        repoName,
        now,
        now,
      );
      createJob(this.db, {
        sessionId: session.id,
        kind: 'agent',
        entityId: proposalId,
        input,
        inputDigest,
        dedupeKey: `agent:${proposalId}:1`,
        deadlineAt: now + this.config.AGENT_DEADLINE_SECONDS * 1000,
      }, now);
      if (session.status === 'validating') setSessionStatus(this.db, session, 'repairing', `repair assigned for ${failed.label}`, now);
      appendEvent(this.db, {
        sessionId: session.id,
        key: `repair:${proposalId}:assigned`,
        type: 'repair.assigned',
        actor,
        entityType: 'proposal',
        entityId: proposalId,
        correlationId: session.id,
        payload: { failedCandidateId: failed.id, failedLabel: failed.label, checks: counterexample.failedChecks.map((f) => f.checkId) },
      }, now);
    });
    return proposalId;
  }

  private async approve(
    actor: string,
    req: { candidateId: string; headSha: string; expectedMainSha: string; validationDigest: string; decision: 'approve' | 'reject' },
    id: string,
  ): Promise<CommandResult> {
    const prior = this.db.one<{ decision: string; expires_at: number }>('SELECT decision, expires_at FROM approval WHERE id = ?', id);
    if (prior) return { status: 201, body: { approvalId: id, decision: prior.decision, expiresAt: prior.expires_at } };
    const c = this.candidateRow(req.candidateId);
    const project = this.requireProject();
    const session = getSession(this.db, c.session_id);
    const now = Date.now();
    let evidenceVerified = false;
    let manifest: ValidationManifest | null = null;
    if (c.validation_digest) {
      const validation = this.db.one<{ r2_key: string; sha256: string }>(
        "SELECT r2_key, sha256 FROM evidence WHERE session_id = ? AND kind = 'validation' AND sha256 = ?",
        session.id,
        c.validation_digest,
      );
      if (validation) {
        manifest = await verifyEvidence<ValidationManifest>(this.env.EVIDENCE, validation.r2_key, validation.sha256).catch(() => null);
        if (manifest) {
          const checks = await Promise.all(
            manifest.requiredChecks.map((rc) => verifyEvidence(this.env.EVIDENCE, rc.result.key, rc.result.sha256).then(() => true, () => false)),
          );
          evidenceVerified = checks.every(Boolean);
        }
      }
    }
    if (req.decision === 'approve') {
      const blockers = approvalEligibility({
        candidateState: c.state,
        manifest,
        validationDigest: c.validation_digest,
        reviewed: { headSha: req.headSha, validationDigest: req.validationDigest, expectedMainSha: req.expectedMainSha },
        observedMainSha: project.observed_main_sha ?? '',
        evidenceVerified,
      });
      if (c.promotable !== 1 || req.headSha !== c.head_sha) {
        blockers.push({ code: 'NOT_PROMOTABLE', reason: 'candidate is not promotable at the reviewed head' });
      }
      if (blockers.length > 0) {
        const first = blockers[0]!;
        throw new DomainError(first.code, first.reason, { blockers });
      }
    } else if (req.headSha !== c.head_sha) {
      throw new DomainError('STALE_APPROVAL', 'the reviewed head does not match this candidate');
    }
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO approval (id, candidate_id, head_sha, expected_main_sha, validation_digest, policy_digest, harness_digest,
           actor_subject, decision, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        c.id,
        req.headSha,
        req.expectedMainSha,
        req.validationDigest,
        session.policy_digest,
        session.harness_digest,
        actor,
        req.decision,
        now + APPROVAL_TTL_MS,
        now,
      );
      appendEvent(this.db, {
        sessionId: session.id,
        key: `approval:${id}`,
        type: 'approval.recorded',
        actor,
        entityType: 'approval',
        entityId: id,
        correlationId: session.id,
        payload: { candidateId: c.id, decision: req.decision, headSha: req.headSha, validationDigest: req.validationDigest },
      }, now);
    });
    return { status: 201, body: { approvalId: id, decision: req.decision, expiresAt: now + APPROVAL_TTL_MS } };
  }

  private async promote(actor: string, approvalId: string): Promise<CommandResult> {
    const a = this.db.one<{ id: string; candidate_id: string; head_sha: string; expected_main_sha: string; validation_digest: string; decision: string; expires_at: number }>(
      'SELECT * FROM approval WHERE id = ?',
      approvalId,
    );
    if (!a) throw new DomainError('NOT_FOUND', 'approval not found');
    if (a.decision !== 'approve') throw new DomainError('NOT_PROMOTABLE', 'this approval recorded a rejection');
    const now = Date.now();
    if (a.expires_at < now) throw new DomainError('STALE_APPROVAL', 'approval expired; review the candidate again');
    const c = this.candidateRow(a.candidate_id);
    if (c.head_sha !== a.head_sha || c.validation_digest !== a.validation_digest) {
      throw new DomainError('STALE_APPROVAL', 'candidate evidence changed after approval');
    }
    const project = this.requireProject();
    if (project.observed_main_sha !== a.expected_main_sha) {
      throw new DomainError('STALE_APPROVAL', 'Main changed after this candidate was reviewed.', {
        expectedMainSha: a.expected_main_sha,
        observedMainSha: project.observed_main_sha,
      });
    }
    const existing = this.db.one<{ id: string; job_id: string; state: string }>('SELECT id, job_id, state FROM promotion WHERE approval_id = ?', a.id);
    if (existing) return { status: 202, body: { promotionId: existing.id, jobId: existing.job_id, state: existing.state } };
    const input = {
      promotionId: newId('prom'),
      approvalId: a.id,
      candidateId: c.id,
      candidateSha: a.head_sha,
      expectedMainSha: a.expected_main_sha,
      sourceRepo: c.repo_name,
      canonicalRepo: project.canonical_repo,
    };
    const inputDigest = await digestOf(input);
    this.armAlarm();
    const result = this.db.tx(() => {
      const job = createJob(this.db, {
        sessionId: c.session_id,
        kind: 'promote',
        entityId: input.promotionId,
        input,
        inputDigest,
        dedupeKey: `promote:${a.id}`,
        deadlineAt: now + 10 * 60_000,
      }, now);
      this.db.run(
        `INSERT INTO promotion (id, approval_id, job_id, before_sha, target_sha, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        input.promotionId,
        a.id,
        job.id,
        a.expected_main_sha,
        a.head_sha,
        now,
        now,
      );
      appendEvent(this.db, {
        sessionId: c.session_id,
        key: `promotion:${input.promotionId}:queued`,
        type: 'promotion.queued',
        actor,
        entityType: 'promotion',
        entityId: input.promotionId,
        correlationId: c.session_id,
        payload: { approvalId: a.id, targetSha: a.head_sha, expectedMainSha: a.expected_main_sha },
      }, now);
      return { promotionId: input.promotionId, jobId: job.id };
    });
    return { status: 202, body: { ...result, state: 'pending' } };
  }

  private async createPreview(actor: string, candidateId: string): Promise<CommandResult> {
    const c = this.candidateRow(candidateId);
    if (!c.head_sha) throw new DomainError('INVALID_STATE', 'candidate is not materialized yet');
    const def = sessionProject(getSession(this.db, c.session_id));
    if (def.runtime.kind === 'project') {
      // The app uses absolute asset paths, which break under the /p/<capability>/ prefix.
      throw new DomainError('INVALID_STATE', 'previews are not available for this project; open the deployed URL after promotion', {
        deployUrl: def.deploy?.url ?? null,
      });
    }
    const now = Date.now();
    // Reuse a live preview of this exact candidate: same capability, same absolute expiry (never extended).
    const live = this.db.one<{ id: string; resource_id: string; nonce: string; expires_at: number }>(
      "SELECT id, resource_id, nonce, expires_at FROM preview WHERE candidate_id = ? AND head_sha = ? AND state IN ('starting','active') AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      c.id, c.head_sha, now + 30_000,
    );
    if (live) {
      return {
        status: 201,
        body: {
          previewId: live.id,
          capability: {
            version: 1, scope: 'candidate-preview', projectId: this.config.PROJECT_SLUG, candidateId: c.id,
            headSha: c.head_sha, resourceId: live.resource_id, expiresAt: live.expires_at, nonce: live.nonce,
          },
          repoName: c.repo_name,
          reused: true,
        },
      };
    }
    const active = this.db.value<number>("SELECT count(*) FROM preview WHERE state IN ('starting','active') AND expires_at > ?", now) ?? 0;
    if (active >= 2) throw new DomainError('LIMIT_EXCEEDED', 'preview limit reached; wait for an existing preview to expire');
    const id = newId('prev');
    const resourceId = `preview-${id}`;
    const nonce = newId('n').replace(/[^a-z0-9]/g, '').padEnd(16, '0');
    const expiresAt = now + this.config.PREVIEW_TTL_SECONDS * 1000;
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO preview (id, candidate_id, head_sha, resource_id, nonce, state, created_by, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
        id, c.id, c.head_sha, resourceId, nonce, actor, expiresAt, now, now,
      );
      this.db.run(
        `INSERT OR IGNORE INTO managed_resource (id, session_id, kind, external_name, state, created_at, expires_at, updated_at)
         VALUES (?, ?, 'preview', ?, 'active', ?, ?, ?)`,
        newId('res'), c.session_id, resourceId, now, expiresAt, now,
      );
      appendEvent(this.db, {
        sessionId: c.session_id,
        key: `preview:${id}`,
        type: 'preview.created',
        actor,
        entityType: 'preview',
        entityId: id,
        correlationId: c.session_id,
        payload: { candidateId: c.id, headSha: c.head_sha, expiresAt },
        visibility: 'private',
      }, now);
    });
    return {
      status: 201,
      body: {
        previewId: id,
        capability: {
          version: 1, scope: 'candidate-preview', projectId: this.config.PROJECT_SLUG, candidateId: c.id,
          headSha: c.head_sha, resourceId, expiresAt, nonce,
        },
        repoName: c.repo_name,
      },
    };
  }

  private async publishReplay(actor: string, sessionId: string): Promise<CommandResult> {
    const session = getSession(this.db, sessionId);
    if (ACTIVE_SESSION_STATES.includes(session.status) && session.status !== 'ready') {
      throw new DomainError('INVALID_STATE', 'publish a replay after the session settles');
    }
    const snapshot = buildSnapshot(this.db, sessionId, this.config);
    const events = listEvents(this.db, sessionId, 0, 2000).events;
    const replayId = newId('rpl');
    const now = Date.now();
    const dto = redactReplay({ replayId, snapshot, events, publishedAt: now });
    const ref = await writeEvidence(this.env.EVIDENCE, {
      prefix: `public/replays/${replayId}`,
      body: dto,
      visibility: 'public',
    });
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO published_replay (id, session_id, original_mode, recorded_at, published_at, snapshot_key, snapshot_digest, snapshot_bytes, published_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        replayId, sessionId, session.mode, session.created_at, now, ref.key, ref.sha256, ref.bytes, actor,
      );
      this.registerEvidence(sessionId, 'replay', ref, now);
      appendEvent(this.db, {
        sessionId,
        key: `replay:${replayId}`,
        type: 'replay.published',
        actor,
        entityType: 'replay',
        entityId: replayId,
        correlationId: sessionId,
        payload: { replayId, digest: ref.sha256 },
      }, now);
    });
    return { status: 201, body: { replayId, digest: ref.sha256 } };
  }

  // =====================================================================
  // Queries
  // =====================================================================

  async getProjectSummary() {
    const p = this.project();
    if (!p) return { seeded: false as const, slug: this.config.PROJECT_SLUG };
    const policy = parse<ProjectPolicy>(p.policy_json);
    const seedJob = policy.seedJobId ?? this.db.value<string>("SELECT id FROM job WHERE kind = 'seed' ORDER BY created_at DESC LIMIT 1") ?? null;
    const seedStatus = seedJob ? this.db.value<string>('SELECT status FROM job WHERE id = ?', seedJob) ?? null : null;
    return {
      seeded: Boolean(p.observed_main_sha),
      slug: p.slug,
      canonicalRepo: p.canonical_repo,
      defaultBranch: p.default_branch,
      observedMainSha: p.observed_main_sha,
      presetBaselineSha: policy.seededBaselineSha,
      seedJobStatus: seedStatus,
      presetCompatible: Boolean(p.observed_main_sha) && p.observed_main_sha === policy.seededBaselineSha,
    };
  }

  async listSessions(limit = 20) {
    return this.db
      .all<SessionRow>('SELECT * FROM session ORDER BY created_at DESC LIMIT ?', Math.min(Math.max(limit, 1), 50))
      .map((s) => ({ id: s.id, mode: s.mode, status: s.status, objective: s.objective, createdAt: s.created_at, finishedAt: s.finished_at }));
  }

  /** JSON text of the snapshot; a string keeps the RPC type shallow and avoids a re-encode. */
  async getSessionSnapshotJson(sessionId: string): Promise<string> {
    getSession(this.db, sessionId);
    return JSON.stringify(buildSnapshot(this.db, sessionId, this.config) satisfies SessionSnapshot);
  }

  async getEventsJson(sessionId: string, after: number, limit: number): Promise<string> {
    getSession(this.db, sessionId);
    return JSON.stringify(listEvents(this.db, sessionId, after, limit));
  }

  async getProposal(id: string) {
    const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', id);
    if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
    return {
      id: p.id,
      sessionId: p.session_id,
      title: p.title,
      kind: p.kind,
      status: p.status,
      taskSpec: taskOf(p),
      baseCandidateId: p.base_candidate_id,
      intents: this.db
        .all<{ version: number; intent_json: string; intent_digest: string; created_at: number }>(
          'SELECT version, intent_json, intent_digest, created_at FROM intent_version WHERE proposal_id = ? ORDER BY version',
          id,
        )
        .map((i) => ({ version: i.version, intent: parse<ChangeIntent>(i.intent_json), digest: i.intent_digest, createdAt: i.created_at })),
      revisions: this.db.all<RevisionRow>('SELECT * FROM proposal_revision WHERE proposal_id = ? ORDER BY revision_no', id).map((r) => ({
        id: r.id,
        revisionNo: r.revision_no,
        repoName: r.repo_name,
        baseSha: r.base_sha,
        headSha: r.head_sha,
        treeSha: r.tree_sha,
        intentDigest: r.intent_digest,
        diffEvidenceId: this.db.value<string>('SELECT id FROM evidence WHERE r2_key = ?', r.diff_evidence_key) ?? null,
        dependencies: this.db.all<{ d: string }>('SELECT dependency_revision_id AS d FROM revision_dependency WHERE revision_id = ?', r.id).map((x) => x.d),
        createdAt: r.created_at,
      })),
    };
  }

  async getCandidateJson(id: string): Promise<string> {
    return JSON.stringify(this.candidateView(id));
  }

  private candidateView(id: string) {
    const c = this.candidateRow(id);
    const caps = candidateCapabilities(this.db, c.id);
    const project = this.requireProject();
    return {
      id: c.id,
      sessionId: c.session_id,
      label: c.label,
      state: c.state,
      headSha: c.head_sha,
      treeSha: c.tree_sha,
      repoName: c.repo_name,
      expectedMainSha: c.expected_main_sha,
      observedMainSha: project.observed_main_sha,
      manifest: c.manifest_json ? parse<CandidateManifest>(c.manifest_json) : null,
      manifestDigest: c.manifest_digest,
      validationDigest: c.validation_digest,
      promotable: c.promotable === 1,
      fullGoal: isFullGoal(caps, sessionFullGoal(getSession(this.db, c.session_id))),
      capabilities: [...caps],
      anchorCandidateId: c.anchor_candidate_id,
      members: candidateMembers(this.db, c.id),
      error: c.error_json ? parse<Json>(c.error_json) : null,
      checks: this.db.all<CheckRunRow>('SELECT * FROM check_run WHERE candidate_id = ? ORDER BY check_key, attempt_no', c.id).map((r) => ({
        id: r.id,
        checkId: r.check_key,
        attemptNo: r.attempt_no,
        status: r.status,
        applicable: r.applicable === 1,
        applicabilityReason: r.applicability_reason,
        assertionCount: r.assertion_count,
        failedCount: r.failed_count,
        result: r.result_json ? parse<CheckResult>(r.result_json) : null,
        evidenceId: r.evidence_key ? this.db.value<string>('SELECT id FROM evidence WHERE r2_key = ?', r.evidence_key) ?? null : null,
      })),
      approvals: this.db.all<Record<string, SqlStorageValue>>('SELECT id, decision, head_sha, validation_digest, expected_main_sha, actor_subject, expires_at, created_at FROM approval WHERE candidate_id = ? ORDER BY created_at', c.id),
    };
  }

  async getEvidenceMeta(id: string) {
    const e = this.db.one<{ id: string; session_id: string | null; kind: string; r2_key: string; sha256: string; bytes: number; content_type: string; visibility: string }>(
      'SELECT * FROM evidence WHERE id = ?',
      id,
    );
    if (!e) throw new DomainError('NOT_FOUND', 'evidence not found');
    return e;
  }

  /** Runtime for execution containers of this project (snapshot for project mode). */
  async getRuntime(): Promise<{ kind: 'storefront' } | { kind: 'project'; snapshotId: string }> {
    const def = projectDefinition(this.config.PROJECT_KIND);
    if (def.runtime.kind === 'storefront') return { kind: 'storefront' };
    const snapshotId = parse<ProjectPolicy>(this.requireProject().policy_json).snapshotId;
    if (!snapshotId) throw new DomainError('INVALID_STATE', 'the dependency snapshot is not ready; seed the project first');
    return { kind: 'project', snapshotId };
  }

  // =====================================================================
  // Preview gateway support (reached only through PreviewEntrypoint)
  // =====================================================================

  async resolvePreview(previewId: string, nonce: string, candidateId: string, headSha: string) {
    const p = this.db.one<{ id: string; candidate_id: string; head_sha: string; nonce: string; state: string; expires_at: number; resource_id: string }>(
      'SELECT * FROM preview WHERE resource_id = ?',
      previewId,
    );
    if (!p || p.nonce !== nonce || p.candidate_id !== candidateId || p.head_sha !== headSha) return null;
    const c = this.candidateRow(candidateId);
    return { resourceId: p.resource_id, state: p.state, expiresAt: p.expires_at, repoName: c.repo_name, headSha: p.head_sha };
  }

  async markPreview(resourceId: string, state: 'active' | 'expired' | 'error') {
    this.db.run('UPDATE preview SET state = ?, updated_at = ? WHERE resource_id = ?', state, Date.now(), resourceId);
  }

  async getPublishedReplay(replayId: string) {
    return this.db.one<{ id: string; snapshot_key: string; snapshot_digest: string; original_mode: string }>(
      'SELECT id, snapshot_key, snapshot_digest, original_mode FROM published_replay WHERE id = ?',
      replayId,
    ) ?? null;
  }

  // =====================================================================
  // Workflow callbacks (job + attempt + fence on every call)
  // =====================================================================

  async wfLease(jobId: string, attemptNo: number, fence: number): Promise<Lease | null> {
    return this.db.tx(() => leaseJob(this.db, { jobId, attemptNo, fence, leaseMs: this.leaseMs }));
  }

  async wfHeartbeat(jobId: string, fence: number): Promise<void> {
    this.db.tx(() => assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs }));
  }

  async wfProgress(jobId: string, fence: number, message: string, details: Record<string, unknown> = {}): Promise<void> {
    const now = Date.now();
    this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      appendEvent(this.db, {
        sessionId: job.session_id,
        key: `progress:${jobId}:${fence}:${now}:${message.slice(0, 40)}`,
        type: `${job.kind}.progress`,
        actor: `job:${jobId}`,
        entityType: job.kind === 'agent' ? 'proposal' : job.kind === 'promote' ? 'promotion' : 'candidate',
        entityId: job.entity_id,
        correlationId: job.session_id ?? jobId,
        payload: { message: message.slice(0, 280), ...details },
      }, now);
    });
  }

  async wfActivity(jobId: string, fence: number, a: { id: string; kind: 'model' | 'tool' | 'fixture'; label: string; startedAt: number; finishedAt?: number; details?: Record<string, unknown> }) {
    this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      this.db.run(
        `INSERT INTO agent_activity (id, session_id, job_id, attempt_no, kind, label, started_at, finished_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, details_json = excluded.details_json`,
        a.id, job.session_id!, jobId, job.attempt_no, a.kind, a.label.slice(0, 120), a.startedAt, a.finishedAt ?? null, json(a.details ?? {}),
      );
    });
  }

  async wfMarkWorking(jobId: string, fence: number): Promise<void> {
    const now = Date.now();
    this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', job.entity_id);
      if (p && p.status === 'pending') {
        assertTransition('proposal', 'pending', 'working');
        this.db.run("UPDATE proposal SET status = 'working', version = version + 1, updated_at = ? WHERE id = ?", now, p.id);
        appendEvent(this.db, {
          sessionId: p.session_id,
          key: `proposal:${p.id}:working:${job.attempt_no}`,
          type: 'agent.started',
          actor: `job:${jobId}`,
          entityType: 'proposal',
          entityId: p.id,
          correlationId: p.session_id,
          payload: { attemptNo: job.attempt_no },
        }, now);
      }
    });
  }

  async wfDeclareIntent(jobId: string, fence: number, expectedVersion: number, intentInput: unknown): Promise<{ version: number; digest: string }> {
    const intent = ChangeIntent.parse(intentInput);
    const digest = await digestOf(intent);
    const job = getJob(this.db, jobId);
    const session = getSession(this.db, job.session_id!);
    const digests = new Map<string, string>();
    for (const p of proposalsOf(this.db, session.id)) {
      const d = this.db.value<string>('SELECT intent_digest FROM intent_version WHERE proposal_id = ? ORDER BY version DESC LIMIT 1', p.id);
      if (d) digests.set(p.id, d);
    }
    digests.set(job.entity_id, digest);
    const now = Date.now();
    return this.db.tx(() => {
      assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', job.entity_id)!;
      if (p.intent_version !== expectedVersion) {
        throw new DomainError('INVALID_STATE', 'intent version changed; re-read and retry', { expected: expectedVersion, actual: p.intent_version });
      }
      const version = p.intent_version + 1;
      this.db.run('UPDATE proposal SET draft_intent_json = ?, intent_version = ?, version = version + 1, updated_at = ? WHERE id = ?', json(intent), version, now, p.id);
      this.db.run(
        'INSERT INTO intent_version (proposal_id, version, intent_json, intent_digest, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        p.id, version, json(intent), digest, jobId, now,
      );
      appendEvent(this.db, {
        sessionId: session.id,
        key: `intent:${p.id}:${version}`,
        type: 'intent.updated',
        actor: `job:${jobId}`,
        entityType: 'proposal',
        entityId: p.id,
        correlationId: session.id,
        payload: {
          version,
          digest,
          contractChanges: intent.contractChanges.map((c) => ({ key: c.key, after: c.after })),
          assumptions: intent.assumptions.map((a) => ({ key: a.key, operator: a.operator, expected: a.expected })),
        },
      }, now);
      if (p.kind === 'feature') refreshInteractions(this.db, session, digests, now);
      return { version, digest };
    });
  }

  async wfReadInbox(jobId: string, fence: number, after: number) {
    const job = this.db.tx(() => assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs }));
    return this.db
      .all<{ seq: number; kind: string; payload_json: string; created_at: number }>(
        'SELECT seq, kind, payload_json, created_at FROM inbox_message WHERE proposal_id = ? AND seq > ? ORDER BY seq LIMIT 20',
        job.entity_id,
        after,
      )
      .map((m) => ({ seq: m.seq, kind: m.kind, payloadJson: m.payload_json, createdAt: m.created_at }));
  }

  /** Shared contract facts and other proposals' declared intents (summaries only, never transcripts). */
  async wfRequestContext(jobId: string, fence: number) {
    const job = this.db.tx(() => assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs }));
    const session = getSession(this.db, job.session_id!);
    return {
      baselineFacts: parse<BaselineFacts>(session.baseline_facts_json),
      peers: proposalsOf(this.db, session.id)
        .filter((p) => p.id !== job.entity_id)
        .map((p) => ({
          proposalId: p.id,
          title: p.title,
          status: p.status,
          intent: p.draft_intent_json
            ? (({ objective, contractChanges, assumptions }: ChangeIntent) => ({ objective, contractChanges, assumptions }))(parse<ChangeIntent>(p.draft_intent_json))
            : null,
          sealedRevisionId: latestRevision(this.db, p.id)?.id ?? null,
        })),
    };
  }

  async wfRegisterEvidence(jobId: string, fence: number, kind: string, ref: EvidenceRef): Promise<string> {
    return this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      return this.registerEvidence(job.session_id, kind, ref, Date.now());
    });
  }

  private registerEvidence(sessionId: string | null, kind: string, ref: EvidenceRef, now: number): string {
    const existing = this.db.value<string>('SELECT id FROM evidence WHERE r2_key = ?', ref.key);
    if (existing) return existing;
    const id = newId('ev');
    this.db.run(
      `INSERT INTO evidence (id, session_id, kind, r2_key, sha256, bytes, content_type, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, sessionId, kind, ref.key, ref.sha256, ref.bytes, ref.contentType, ref.visibility, now,
    );
    return id;
  }

  /** Validate and record a sealed revision produced by the broker. */
  async wfSeal(
    jobId: string,
    fence: number,
    r: { headSha: string; treeSha: string; baseSha: string; repoName: string; changedPaths: string[]; diff: EvidenceRef; summary: string },
  ): Promise<{ revisionId: string; warnings: string[] }> {
    const job = getJob(this.db, jobId);
    const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', job.entity_id)!;
    if (!p.draft_intent_json) throw new DomainError('INVALID_STATE', 'declare an intent before sealing');
    const intent = parse<ChangeIntent>(p.draft_intent_json);
    const task = taskOf(p);
    const classified = classifyEdits({
      changedPaths: r.changedPaths,
      editablePaths: task.editablePaths,
      protectedPaths: task.forbiddenPaths,
      declaredPaths: intent.affectedPaths,
    });
    if (classified.protectedViolations.length) {
      throw new DomainError('PROTECTED_PATH', 'sealed changes touch protected files', { paths: classified.protectedViolations });
    }
    if (classified.outOfScope.length) {
      throw new DomainError('OUT_OF_SCOPE_EDIT', 'sealed changes are outside the task scope', { paths: classified.outOfScope });
    }
    const intentDigest = await digestOf(intent);
    // A feature may depend only on sealed revisions of other proposals in this session.
    const sessionRevisions = new Set(
      this.db
        .all<{ id: string }>(
          'SELECT r.id FROM proposal_revision r JOIN proposal q ON q.id = r.proposal_id WHERE q.session_id = ? AND q.id <> ?',
          p.session_id,
          p.id,
        )
        .map((r) => r.id),
    );
    const unknownDeps = intent.dependencyRevisionIds.filter((d) => !sessionRevisions.has(d));
    if (p.kind === 'feature' && unknownDeps.length) {
      throw new DomainError('INVALID_INPUT', 'declared dependencies must be sealed revisions of other proposals in this session', { unknownDeps });
    }
    const dependencies =
      p.kind === 'repair' && p.base_candidate_id ? candidateMembers(this.db, p.base_candidate_id) : intent.dependencyRevisionIds;
    const now = Date.now();
    const warnings = classified.undeclared.map((path: string) => `changed ${path} without declaring it in affectedPaths`);
    const result = this.db.tx(() => {
      assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      const revisionNo = (this.db.value<number>('SELECT max(revision_no) FROM proposal_revision WHERE proposal_id = ?', p.id) ?? 0) + 1;
      const revisionId = newId('rev');
      this.db.run(
        `INSERT INTO proposal_revision (id, proposal_id, revision_no, repo_name, base_sha, head_sha, tree_sha, intent_json,
           intent_digest, diff_evidence_key, diff_evidence_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revisionId, p.id, revisionNo, r.repoName, r.baseSha, r.headSha, r.treeSha, json(intent), intentDigest, r.diff.key, r.diff.sha256, now,
      );
      for (const d of dependencies) {
        this.db.run('INSERT OR IGNORE INTO revision_dependency (revision_id, dependency_revision_id) VALUES (?, ?)', revisionId, d);
      }
      this.registerEvidence(p.session_id, 'diff', r.diff, now);
      assertTransition('proposal', p.status, 'sealed');
      this.db.run("UPDATE proposal SET status = 'sealed', summary = ?, version = version + 1, updated_at = ? WHERE id = ?", r.summary.slice(0, 2000), now, p.id);
      this.db.run(
        `INSERT OR IGNORE INTO managed_resource (id, session_id, kind, external_name, state, created_at, updated_at)
         VALUES (?, ?, 'artifact_repo', ?, 'active', ?, ?)`,
        newId('res'), p.session_id, r.repoName, now, now,
      );
      appendEvent(this.db, {
        sessionId: p.session_id,
        key: `revision:${revisionId}:sealed`,
        type: 'revision.sealed',
        actor: `job:${jobId}`,
        entityType: 'proposal',
        entityId: p.id,
        correlationId: p.session_id,
        payload: { revisionId, revisionNo, headSha: r.headSha, treeSha: r.treeSha, changedPaths: r.changedPaths, warnings, dependencies },
      }, now);
      finishAttempt(this.db, getJob(this.db, jobId), 'succeeded', null, now);
      return { revisionId, warnings };
    });
    await this.advance(p.session_id);
    return result;
  }

  async wfAgentBlocked(jobId: string, fence: number, reason: string, code = 'AGENT_BLOCKED'): Promise<void> {
    const now = Date.now();
    const sessionId = this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence });
      const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', job.entity_id)!;
      if (p.status === 'working' || p.status === 'pending') {
        this.db.run("UPDATE proposal SET status = 'blocked', summary = ?, updated_at = ? WHERE id = ?", reason.slice(0, 2000), now, p.id);
      }
      finishAttempt(this.db, job, 'failed', code, now);
      appendEvent(this.db, {
        sessionId: p.session_id,
        key: `proposal:${p.id}:blocked:${job.attempt_no}`,
        type: 'agent.blocked',
        actor: `job:${jobId}`,
        entityType: 'proposal',
        entityId: p.id,
        correlationId: p.session_id,
        payload: { reason: reason.slice(0, 500), code },
      }, now);
      const s = getSession(this.db, p.session_id);
      if (ACTIVE_SESSION_STATES.includes(s.status)) setSessionStatus(this.db, s, 'needs_attention', `agent ${p.title} blocked: ${reason.slice(0, 120)}`, now);
      return p.session_id;
    });
    void sessionId;
  }

  async wfAssembly(jobId: string, fence: number) {
    const job = this.db.tx(() => assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs }));
    const c = this.candidateRow(job.entity_id);
    const project = this.requireProject();
    const plan = parse<import('@converge/domain').CandidatePlan>(c.plan_json);
    const included = new Set(plan.anchor?.includedRevisionIds ?? []);
    const start = plan.anchor
      ? { repo: this.candidateRow(plan.anchor.candidateId).repo_name, sha: plan.anchor.headSha }
      : { repo: project.canonical_repo, sha: plan.baselineSha };
    const merges = plan.members.filter((m) => !included.has(m.revisionId)).map((m) => ({ repo: m.repoName, sha: m.headSha, label: m.revisionId }));
    this.db.tx(() => {
      if (c.state === 'planned') setCandidateState(this.db, c, 'assembling', Date.now());
    });
    return {
      candidateId: c.id,
      label: c.label,
      canonicalRepo: project.canonical_repo,
      targetRepo: c.repo_name,
      branch: `candidates/${c.id}`,
      start,
      merges,
      message: `Converge candidate ${c.label} (${c.id})`,
      timestamp: Math.floor(c.created_at / 1000),
    };
  }

  async wfAssembled(
    jobId: string,
    fence: number,
    r:
      | { status: 'merged'; headSha: string; treeSha: string; executionImageDigest: string }
      | { status: 'text_conflict'; conflictedPaths: string[]; atMerge: string }
      | { status: 'error'; code: string; message: string },
  ): Promise<void> {
    const job = getJob(this.db, jobId);
    const c = this.candidateRow(job.entity_id);
    const session = getSession(this.db, c.session_id);
    const policy = parse<SessionPolicy>(session.policy_json);
    const now = Date.now();
    let manifest: CandidateManifest | null = null;
    let manifestDigest: string | null = null;
    if (r.status === 'merged') {
      const plan = parse<import('@converge/domain').CandidatePlan>(c.plan_json);
      manifest = {
        schemaVersion: 1,
        planDigest: c.plan_key,
        plan,
        headSha: r.headSha,
        treeSha: r.treeSha,
        executionImageDigest: r.executionImageDigest,
        lockfileDigest: policy.lockfileDigest,
        verifierBuildId: this.config.BUILD_ID,
        createdAt: c.created_at,
      };
      manifestDigest = await digestOf(manifest);
    }
    const verifyInput = { candidateId: c.id };
    const verifyDigest = await digestOf({ ...verifyInput, manifestDigest });
    this.armAlarm();
    this.db.tx(() => {
      const j = assertFence(this.db, { jobId, fence });
      if (r.status === 'merged' && manifest && manifestDigest) {
        if (!c.head_sha) {
          this.db.run(
            'UPDATE candidate SET head_sha = ?, tree_sha = ?, manifest_json = ?, manifest_digest = ?, materialized_at = ? WHERE id = ?',
            r.headSha, r.treeSha, json(manifest), manifestDigest, now, c.id,
          );
        } else if (c.head_sha !== r.headSha) {
          throw new DomainError('INVALID_STATE', 'candidate already materialized with a different commit', { existing: c.head_sha, observed: r.headSha });
        }
        setCandidateState(this.db, c, 'testing', now, { headSha: r.headSha, treeSha: r.treeSha });
        appendEvent(this.db, {
          sessionId: c.session_id,
          key: `candidate:${c.id}:assembled`,
          type: 'candidate.assembled',
          actor: `job:${jobId}`,
          entityType: 'candidate',
          entityId: c.id,
          correlationId: c.session_id,
          payload: { headSha: r.headSha, treeSha: r.treeSha, manifestDigest },
        }, now);
        createJob(this.db, {
          sessionId: c.session_id,
          kind: 'verify',
          entityId: c.id,
          input: verifyInput,
          inputDigest: verifyDigest,
          dedupeKey: `verify:${c.id}:1`,
          deadlineAt: now + 20 * 60_000,
        }, now);
        this.db.run(
          `INSERT OR IGNORE INTO managed_resource (id, session_id, kind, external_name, state, created_at, updated_at)
           VALUES (?, ?, 'artifact_repo', ?, 'active', ?, ?)`,
          newId('res'), c.session_id, c.repo_name, now, now,
        );
      } else {
        this.db.run('UPDATE candidate SET error_json = ? WHERE id = ?', json(r), c.id);
        setCandidateState(this.db, c, r.status === 'text_conflict' ? 'text_conflict' : 'error', now, r);
      }
      finishAttempt(this.db, j, r.status === 'error' ? 'failed' : 'succeeded', r.status === 'error' ? r.code : null, now);
    });
    if (r.status !== 'merged') await this.advance(session.id);
  }

  async wfVerifyInput(jobId: string, fence: number) {
    const job = this.db.tx(() => assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs }));
    const c = this.candidateRow(job.entity_id);
    if (!c.head_sha || !c.manifest_digest) throw new DomainError('INVALID_STATE', 'candidate is not materialized');
    const session = getSession(this.db, c.session_id);
    const caps = candidateCapabilities(this.db, c.id);
    return {
      candidateId: c.id,
      sessionId: c.session_id,
      repoName: c.repo_name,
      headSha: c.head_sha,
      treeSha: c.tree_sha,
      manifestDigest: c.manifest_digest,
      harnessDigest: session.harness_digest,
      capabilities: [...caps],
      attemptNo: job.attempt_no,
    };
  }

  async wfRecordCheck(jobId: string, fence: number, result: CheckResult, evidence: EvidenceRef | null): Promise<void> {
    const job = getJob(this.db, jobId);
    const c = this.candidateRow(job.entity_id);
    if (result.candidateId !== c.id || result.candidateHeadSha !== c.head_sha || result.candidateManifestDigest !== c.manifest_digest) {
      throw new DomainError('INVALID_INPUT', 'check result does not reference this exact candidate');
    }
    const session = getSession(this.db, c.session_id);
    if (result.harnessDigest !== session.harness_digest) {
      throw new DomainError('INVALID_INPUT', 'check result was produced by a different harness');
    }
    const required = CHECK_REQUIRED(result.checkId, candidateCapabilities(this.db, c.id), sessionProject(session).checks);
    // Reject an inconsistent result here. INSERT OR IGNORE below would drop it without a trace,
    // and a skip of a check that applies must never count as a pass.
    const problems = resultInvariantViolations(result);
    if (result.applicable !== required) problems.push(`applicability differs from the frozen policy (policy: ${required ? 'applies' : 'excluded'})`);
    if (problems.length > 0) {
      throw new DomainError('INVALID_INPUT', 'check result is not consistent', { checkId: result.checkId, problems });
    }
    const now = Date.now();
    this.db.tx(() => {
      assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      const evidenceId = evidence ? this.registerEvidence(c.session_id, 'check', evidence, now) : null;
      this.db.run(
        `INSERT OR IGNORE INTO check_run (id, candidate_id, job_id, check_key, attempt_no, harness_digest, required, applicable,
           applicability_reason, status, assertion_count, failed_count, result_json, evidence_key, evidence_digest, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('chk'), c.id, jobId, result.checkId, job.attempt_no, result.harnessDigest, required ? 1 : 0, result.applicable ? 1 : 0,
        result.applicabilityReason, result.status, result.assertionCount, result.failedCount, json(result),
        evidence?.key ?? null, evidence?.sha256 ?? null, result.startedAt, result.finishedAt,
      );
      if (result.status === 'failed' || result.status === 'error') {
        appendEvent(this.db, {
          sessionId: c.session_id,
          key: `check:${c.id}:${result.checkId}:${job.attempt_no}`,
          type: result.status === 'failed' ? 'check.failed' : 'check.error',
          actor: `job:${jobId}`,
          entityType: 'candidate',
          entityId: c.id,
          correlationId: c.session_id,
          payload: { checkId: result.checkId, label: c.label, failedCount: result.failedCount, evidenceId },
        }, now);
      }
    });
  }

  async wfVerified(jobId: string, fence: number, buildError?: { message: string }): Promise<void> {
    const job = getJob(this.db, jobId);
    const c = this.candidateRow(job.entity_id);
    const session = getSession(this.db, c.session_id);
    const caps = candidateCapabilities(this.db, c.id);
    const runs = latestRuns(this.db, c.id);
    const project = sessionProject(session);
    const applicable = applicableChecks(caps, project.checks);
    const anyBad = runs.some((r) => r.applicable === 1 && (r.status === 'failed' || r.status === 'error'));
    // Every check the policy applies needs an applicable, passed run. A skip or a missing run is not a pass.
    const unmet = applicable.some((chk) => {
      const run = runs.find((r) => r.check_key === chk.id);
      return !run || run.applicable !== 1 || run.status !== 'passed';
    });
    const to = buildError || anyBad || unmet ? 'failed' : 'passed';
    let validation: { manifest: ValidationManifest; digest: string; ref: EvidenceRef } | null = null;
    if (to === 'passed' && isFullGoal(caps, sessionFullGoal(session))) {
      const built = buildValidationManifest({
        candidate: { id: c.id, headSha: c.head_sha!, manifestDigest: c.manifest_digest! },
        policyDigest: session.policy_digest,
        harnessDigest: session.harness_digest,
        checks: project.checks,
        capabilities: caps,
        fullGoalCapabilities: [...sessionFullGoal(session)] as Capability[],
        runs: runs.map((r) => ({
          checkId: r.check_key,
          status: r.status as CheckStatus | 'pending',
          applicable: r.applicable === 1,
          assertionCount: r.assertion_count,
          failedCount: r.failed_count,
          harnessDigest: r.harness_digest,
          evidence: r.evidence_key
            ? { key: r.evidence_key, sha256: r.evidence_digest!, bytes: this.db.value<number>('SELECT bytes FROM evidence WHERE r2_key = ?', r.evidence_key) ?? 0, contentType: 'application/json', visibility: 'private' as const }
            : undefined,
        })),
      });
      if (built.ok) {
        const ref = await writeEvidence(this.env.EVIDENCE, {
          prefix: `private/${this.config.PROJECT_SLUG}/${session.id}/validation`,
          body: built.manifest,
          visibility: 'private',
        });
        validation = { manifest: built.manifest, digest: ref.sha256, ref };
      }
    }
    const now = Date.now();
    this.db.tx(() => {
      const j = assertFence(this.db, { jobId, fence });
      if (buildError) this.db.run('UPDATE candidate SET error_json = ? WHERE id = ?', json({ status: 'build_failed', message: buildError.message.slice(0, 2000) }), c.id);
      setCandidateState(this.db, c, to, now, { checks: runs.length });
      if (validation) {
        this.registerEvidence(session.id, 'validation', validation.ref, now);
        this.db.run('UPDATE candidate SET validation_digest = ?, promotable = 1 WHERE id = ?', validation.digest, c.id);
        appendEvent(this.db, {
          sessionId: session.id,
          key: `candidate:${c.id}:validated`,
          type: 'candidate.validated',
          actor: `job:${jobId}`,
          entityType: 'candidate',
          entityId: c.id,
          correlationId: session.id,
          payload: { validationDigest: validation.digest, headSha: c.head_sha },
        }, now);
      }
      updateInteractionsFromEvidence(this.db, c, now);
      finishAttempt(this.db, j, 'succeeded', null, now);
    });
    await this.advance(session.id);
  }

  async wfPromotionResult(
    jobId: string,
    fence: number,
    r: { state: 'succeeded' | 'stale' | 'failed'; observedRemoteSha: string | null; reconciled?: boolean; receipt: EvidenceRef | null; message?: string },
  ): Promise<void> {
    const job = getJob(this.db, jobId);
    const now = Date.now();
    this.db.tx(() => {
      const j = assertFence(this.db, { jobId, fence });
      const prom = this.db.one<{ id: string; approval_id: string; target_sha: string; before_sha: string }>('SELECT * FROM promotion WHERE id = ?', job.entity_id)!;
      this.db.run(
        'UPDATE promotion SET state = ?, observed_remote_sha = ?, receipt_key = ?, receipt_digest = ?, updated_at = ? WHERE id = ?',
        r.state, r.observedRemoteSha, r.receipt?.key ?? null, r.receipt?.sha256 ?? null, now, prom.id,
      );
      if (r.receipt) this.registerEvidence(job.session_id, 'promotion', r.receipt, now);
      if (r.observedRemoteSha) {
        this.db.run('UPDATE project SET observed_main_sha = ?, updated_at = ?', r.observedRemoteSha, now);
      }
      const session = getSession(this.db, job.session_id!);
      if (r.state === 'succeeded' && r.observedRemoteSha === prom.target_sha) {
        setSessionStatus(this.db, session, 'promoted', 'canonical main now points to the approved commit', now);
      }
      appendEvent(this.db, {
        sessionId: session.id,
        key: `promotion:${prom.id}:${r.state}`,
        type: `promotion.${r.state}`,
        actor: `job:${jobId}`,
        entityType: 'promotion',
        entityId: prom.id,
        correlationId: session.id,
        payload: { targetSha: prom.target_sha, observedRemoteSha: r.observedRemoteSha, reconciled: Boolean(r.reconciled), message: r.message ?? null },
      }, now);
      finishAttempt(this.db, j, r.state === 'failed' ? 'failed' : 'succeeded', r.state === 'failed' ? 'PROMOTION_FAILED' : null, now);
    });
  }

  /**
   * Deployment observation after a successful promotion. It is evidence only (no
   * job fence): the guarded push already decided what main is.
   */
  async wfDeployObserved(
    promotionId: string,
    r: { url: string; expectedCommit: string; observedVersion: string | null; state: 'verified' | 'version-mismatch' | 'checks-failed'; failedChecks: string[]; checks: number; evidence: EvidenceRef },
  ): Promise<void> {
    const prom = this.db.one<{ id: string; state: string; target_sha: string; job_id: string }>('SELECT id, state, target_sha, job_id FROM promotion WHERE id = ?', promotionId);
    if (!prom || prom.state !== 'succeeded' || prom.target_sha !== r.expectedCommit) throw new DomainError('INVALID_STATE', 'no matching successful promotion');
    const sessionId = this.db.value<string>('SELECT session_id FROM job WHERE id = ?', prom.job_id) ?? null;
    const now = Date.now();
    this.db.tx(() => {
      const evidenceId = this.registerEvidence(sessionId, 'deployment', r.evidence, now);
      appendEvent(this.db, {
        sessionId,
        key: `deploy:${promotionId}:${r.state}`,
        type: `deploy.${r.state}`,
        actor: 'system:deploy-observer',
        entityType: 'promotion',
        entityId: promotionId,
        correlationId: sessionId ?? promotionId,
        payload: { url: r.url, expectedCommit: r.expectedCommit, observedVersion: r.observedVersion, failedChecks: r.failedChecks, checks: r.checks, evidenceId },
      }, now);
    });
  }

  async wfSeeded(jobId: string, fence: number, r: { headSha: string; lockfileDigest: string; snapshotId?: string | null }): Promise<void> {
    const now = Date.now();
    this.db.tx(() => {
      const j = assertFence(this.db, { jobId, fence });
      const p = this.requireProject();
      const policy = parse<ProjectPolicy>(p.policy_json);
      const next: ProjectPolicy = {
        seededBaselineSha: policy.seededBaselineSha ?? r.headSha,
        lockfileDigest: policy.lockfileDigest ?? r.lockfileDigest,
        seedJobId: jobId,
        snapshotId: r.snapshotId ?? policy.snapshotId ?? null,
      };
      this.db.run(
        'UPDATE project SET observed_main_sha = coalesce(observed_main_sha, ?), policy_json = ?, updated_at = ?',
        r.headSha, json(next), now,
      );
      this.db.run("UPDATE managed_resource SET state = 'active', updated_at = ? WHERE kind = 'artifact_repo' AND external_name = ?", now, p.canonical_repo);
      appendEvent(this.db, {
        sessionId: null,
        key: `project:${p.id}:seeded`,
        type: 'project.seeded',
        actor: `job:${jobId}`,
        entityType: 'project',
        entityId: p.id,
        correlationId: p.id,
        payload: { headSha: r.headSha },
        visibility: 'private',
      }, now);
      finishAttempt(this.db, j, 'succeeded', null, now);
    });
  }

  /** Infrastructure failure of an attempt (not a semantic test failure). */
  async wfFail(jobId: string, fence: number, code: string, message: string): Promise<void> {
    const now = Date.now();
    const job = getJob(this.db, jobId);
    if (job.current_fence !== fence) return; // stale attempt: ignore
    this.db.tx(() => {
      const j = getJob(this.db, jobId);
      if (!['running', 'queued', 'leased'].includes(j.status)) return;
      finishAttempt(this.db, j, 'failed', code.slice(0, 64), now);
      appendEvent(this.db, {
        sessionId: j.session_id,
        key: `job:${jobId}:failed:${j.attempt_no}`,
        type: 'job.failed',
        actor: `job:${jobId}`,
        entityType: 'job',
        entityId: jobId,
        correlationId: j.session_id ?? jobId,
        payload: { kind: j.kind, code, message: message.slice(0, 500), attemptNo: j.attempt_no },
      }, now);
      if (j.kind === 'integrate' || j.kind === 'verify') {
        const c = this.db.one<CandidateRow>('SELECT * FROM candidate WHERE id = ?', j.entity_id);
        if (c && ['planned', 'assembling', 'testing'].includes(c.state)) {
          this.db.run('UPDATE candidate SET error_json = ? WHERE id = ?', json({ status: 'error', code, message: message.slice(0, 500) }), c.id);
          setCandidateState(this.db, c, 'error', now);
        }
      }
      if (j.kind === 'agent') {
        const p = this.db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', j.entity_id);
        if (p && (p.status === 'working' || p.status === 'pending')) {
          this.db.run("UPDATE proposal SET status = 'blocked', summary = ?, updated_at = ? WHERE id = ?", `${code}: ${message}`.slice(0, 500), now, p.id);
        }
      }
      if (j.kind === 'promote') {
        this.db.run("UPDATE promotion SET state = 'failed', updated_at = ? WHERE job_id = ?", now, jobId);
      }
      if (j.session_id) {
        const s = getSession(this.db, j.session_id);
        if (ACTIVE_SESSION_STATES.includes(s.status) && s.status !== 'ready') {
          setSessionStatus(this.db, s, 'needs_attention', `${j.kind} job failed: ${code}`, now);
        }
      }
    });
  }

  // ---------- model budget ledger ----------

  async wfBudgetReserve(jobId: string, fence: number, operationKey: string, amountMicroUsd: number): Promise<{ ok: boolean; balances: ReturnType<typeof balances> }> {
    const now = Date.now();
    return this.db.tx(() => {
      const job = assertFence(this.db, { jobId, fence, leaseMs: this.leaseMs });
      const session = getSession(this.db, job.session_id!);
      const existing = this.db.value<string>('SELECT id FROM budget_entry WHERE operation_key = ?', `reserve:${operationKey}`);
      const entries = this.ledger(session.id);
      if (existing) return { ok: true, balances: balances(entries) };
      const b = balances(entries);
      if (!canReserve(b, session.model_budget_microusd, amountMicroUsd)) {
        appendEvent(this.db, {
          sessionId: session.id,
          key: `budget:${operationKey}:blocked`,
          type: 'budget.blocked',
          actor: `job:${jobId}`,
          entityType: 'session',
          entityId: session.id,
          correlationId: session.id,
          payload: { requested: amountMicroUsd, ...b, ceiling: session.model_budget_microusd },
        }, now);
        return { ok: false, balances: b };
      }
      this.insertLedger(session.id, jobId, `reserve:${operationKey}`, reserveEntry(operationKey, amountMicroUsd), { amountMicroUsd }, now);
      return { ok: true, balances: balances(this.ledger(session.id)) };
    });
  }

  /** Settle a reservation. Late usage from an old attempt is accepted (billing ≠ domain authority). */
  async wfBudgetSettle(jobId: string, operationKey: string, outcome: { kind: 'settled'; costMicroUsd: number; usage: unknown } | { kind: 'released' } | { kind: 'uncertain' }): Promise<void> {
    const now = Date.now();
    this.db.tx(() => {
      const job = getJob(this.db, jobId);
      const reservation = this.db.one<{ reserved_delta_microusd: number }>(
        'SELECT reserved_delta_microusd FROM budget_entry WHERE operation_key = ?',
        `reserve:${operationKey}`,
      );
      if (!reservation) return;
      const amount = reservation.reserved_delta_microusd;
      const key = `settle:${operationKey}`;
      if (this.db.value<string>('SELECT id FROM budget_entry WHERE operation_key = ?', key)) return;
      const r = { reservationId: operationKey, amountMicroUsd: amount };
      const entry: LedgerEntry =
        outcome.kind === 'settled' ? settleEntry(r, outcome.costMicroUsd) : outcome.kind === 'released' ? releaseEntry(r) : uncertainEntry(r);
      this.insertLedger(job.session_id!, jobId, key, entry, outcome.kind === 'settled' ? { usage: outcome.usage } : { outcome: outcome.kind }, now);
    });
  }

  private ledger(sessionId: string): LedgerEntry[] {
    return this.db
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
  }

  private insertLedger(sessionId: string, jobId: string, key: string, e: LedgerEntry, details: Record<string, unknown>, now: number) {
    const next = balances([...this.ledger(sessionId), e]); // throws on negative balance
    void next;
    this.db.run(
      `INSERT INTO budget_entry (id, session_id, job_id, operation_key, kind, reserved_delta_microusd, spent_delta_microusd,
         uncertain_delta_microusd, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('bud'), sessionId, jobId, key, e.kind, e.reservedDelta, e.spentDelta, e.uncertainDelta, json(details), now,
    );
  }

  // =====================================================================
  // Progression
  // =====================================================================

  /**
   * Advance the session after a state change; safe to call repeatedly. A
   * failure here must not vanish: the session moves to needs_attention with the reason.
   */
  private async advance(sessionId: string): Promise<void> {
    try {
      await this.advanceUnsafe(sessionId);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const now = Date.now();
      this.db.tx(() => {
        const s = getSession(this.db, sessionId);
        appendEvent(this.db, {
          sessionId,
          key: `session:${sessionId}:advance-failed:${now}`,
          type: 'session.advance_failed',
          actor: SYSTEM_ACTOR,
          entityType: 'session',
          entityId: sessionId,
          correlationId: sessionId,
          payload: { reason },
        }, now);
        if (ACTIVE_SESSION_STATES.includes(s.status) && s.status !== 'ready') setSessionStatus(this.db, s, 'needs_attention', `planning failed: ${reason}`, now);
      });
    }
  }

  private async advanceUnsafe(sessionId: string): Promise<void> {
    const session = getSession(this.db, sessionId);
    if (!ACTIVE_SESSION_STATES.includes(session.status)) return;
    const integrationRepo = repoNameFor('candidate', sessionId, 'int');
    const now = Date.now();

    // 1. All features sealed -> plan the selected initial candidates.
    if (session.status === 'running') {
      const inputs = initialPlanInputs(this.db, session);
      if (inputs) {
        await this.planAll(session, inputs, integrationRepo, 'validating', 'all proposals sealed');
        return;
      }
    }

    // 2. A sealed repair without a candidate -> plan the anchored final candidate.
    if (session.status === 'repairing') {
      for (const repair of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE session_id = ? AND kind = 'repair' AND status = 'sealed'", sessionId)) {
        const rev = latestRevision(this.db, repair.id);
        if (!rev) continue;
        const planned = this.db.value<number>('SELECT count(*) FROM candidate_member WHERE revision_id = ?', rev.id);
        if (planned) continue;
        const features = proposalsOf(this.db, sessionId)
          .filter((p) => p.kind === 'feature')
          .map((p) => latestRevision(this.db, p.id)!.id);
        const anchorMembers = candidateMembers(this.db, repair.base_candidate_id!);
        const memberIds = [...new Set([...anchorMembers, ...features, rev.id])];
        await this.planAll(session, [{ label: `Full goal + ${repair.title}`, memberRevisionIds: memberIds, anchorCandidateId: repair.base_candidate_id! }], integrationRepo, 'validating', `${repair.title} sealed`);
        return;
      }
    }

    // 3. Nothing in flight -> ready, repair, or ask for attention.
    if (session.status !== 'validating') return;
    const next = decideNext(this.db, session);
    if (next.kind === 'wait') return;
    if (next.kind === 'ready') {
      this.db.tx(() => setSessionStatus(this.db, session, 'ready', `candidate ${next.candidateId} passed every required check`, now));
      return;
    }
    if (next.kind === 'repair') {
      await this.assignRepair(session, this.candidateRow(next.failedCandidateId), SYSTEM_ACTOR);
      return;
    }
    this.db.tx(() => setSessionStatus(this.db, session, 'needs_attention', next.reason, now));
  }

  private async planAll(session: SessionRow, inputs: PlanInput[], integrationRepo: string, to: 'validating', reason: string) {
    const plans = inputs.map((i) => draftPlan(this.db, session, i));
    const keys = await Promise.all(plans.map((p) => planKey(p)));
    const now = Date.now();
    this.armAlarm();
    this.db.tx(() => {
      plans.forEach((plan, i) => insertCandidate(this.db, session, plan, keys[i]!, integrationRepo, now));
      setSessionStatus(this.db, session, to, reason, now);
    });
  }

  /** The phase a session resumes in after a human retry. */
  private resumeStatus(sessionId: string): 'running' | 'validating' | 'repairing' {
    const unsealedFeature = this.db.value<number>(
      "SELECT count(*) FROM proposal WHERE session_id = ? AND kind = 'feature' AND status <> 'sealed'",
      sessionId,
    );
    if (unsealedFeature) return 'running';
    const openRepair = this.db.value<number>(
      "SELECT count(*) FROM proposal WHERE session_id = ? AND kind = 'repair' AND status <> 'sealed'",
      sessionId,
    );
    return openRepair ? 'repairing' : 'validating';
  }

  private candidateRow(id: string): CandidateRow {
    const c = this.db.one<CandidateRow>('SELECT * FROM candidate WHERE id = ?', id);
    if (!c) throw new DomainError('NOT_FOUND', `candidate ${id} not found`);
    return c;
  }

  // =====================================================================
  // Outbox dispatch and recovery
  // =====================================================================

  override async alarm(): Promise<void> {
    await this.dispatchOutbox();
    await this.recoverLeases();
    const next = this.db.value<number>("SELECT min(next_attempt_at) FROM outbox WHERE status IN ('pending','dispatching')");
    if (next) void this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /** Cron entry point: reconcile due outbox work, stale leases, and expired previews. */
  async recover(): Promise<{ dispatched: number; expired: number }> {
    const dispatched = await this.dispatchOutbox();
    const expired = await this.recoverLeases();
    // Re-run progression for active sessions; a lost trigger never strands a session.
    for (const s of this.db.all<{ id: string }>(`SELECT id FROM session WHERE status IN ('running','validating','repairing')`)) {
      await this.advance(s.id);
    }
    this.db.run("UPDATE preview SET state = 'expired', updated_at = ? WHERE state IN ('starting','active') AND expires_at < ?", Date.now(), Date.now());
    return { dispatched, expired };
  }

  private async dispatchOutbox(): Promise<number> {
    const now = Date.now();
    const due = this.db.all<{ id: string; kind: string; payload_json: string; attempts: number; job_id: string | null }>(
      "SELECT id, kind, payload_json, attempts, job_id FROM outbox WHERE status IN ('pending','dispatching') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20",
      now,
    );
    let count = 0;
    for (const item of due) {
      const payload = parse<Record<string, unknown>>(item.payload_json);
      this.db.run("UPDATE outbox SET status = 'dispatching', attempts = attempts + 1, updated_at = ? WHERE id = ?", now, item.id);
      try {
        if (item.kind === 'dispatch') {
          const job = item.job_id ? this.db.one<{ status: string; current_fence: number }>('SELECT status, current_fence FROM job WHERE id = ?', item.job_id) : undefined;
          if (!job || job.status === 'cancelled' || job.current_fence !== payload.fence) {
            this.db.run("UPDATE outbox SET status = 'delivered', last_error_code = 'SUPERSEDED', updated_at = ? WHERE id = ?", now, item.id);
            continue;
          }
          // Resource policy: defer, do not drop, work that would exceed the agent or container limits.
          const limit = this.capacityBlock(String(payload.kind));
          if (limit) {
            this.db.run(
              "UPDATE outbox SET status = 'pending', attempts = attempts - 1, next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?",
              now + 5000, limit, now, item.id,
            );
            continue;
          }
          await this.createWorkflow(String(payload.workflowId), {
            jobId: String(payload.jobId),
            attemptNo: Number(payload.attemptNo),
            fence: Number(payload.fence),
            kind: String(payload.kind),
          });
        } else if (item.kind === 'terminate') {
          try {
            const inst = await this.env.JOBS.get(String(payload.workflowId));
            await inst.terminate();
          } catch {
            // Already finished or never created: nothing to stop.
          }
        } else if (item.kind === 'cleanup') {
          await this.cleanupJobContainers(String(payload.jobId));
        }
        this.db.run("UPDATE outbox SET status = 'delivered', updated_at = ? WHERE id = ?", Date.now(), item.id);
        count++;
      } catch (err) {
        const attempts = item.attempts + 1;
        const code = err instanceof Error ? err.message.slice(0, 120) : 'UNKNOWN';
        this.db.run(
          'UPDATE outbox SET status = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?',
          attempts >= 8 ? 'failed' : 'pending',
          Date.now() + Math.min(60_000, 1000 * 2 ** attempts),
          code,
          Date.now(),
          item.id,
        );
      }
    }
    return count;
  }

  /** Name of the limit that blocks a new job of this kind, or null when there is capacity. */
  private capacityBlock(kind: string): string | null {
    const busy = (kinds: string[]) =>
      this.db.value<number>(
        `SELECT count(*) FROM job WHERE status IN ('leased','running') AND kind IN (${kinds.map(() => '?').join(',')})`,
        ...kinds,
      ) ?? 0;
    if (kind === 'agent' && busy(['agent']) >= this.config.MAX_CONCURRENT_AGENTS) return 'MAX_CONCURRENT_AGENTS';
    // Agent checks, verification, and previews use execution containers.
    if (['agent', 'verify'].includes(kind) && busy(['agent', 'verify']) >= this.config.MAX_ACTIVE_CONTAINERS) return 'MAX_ACTIVE_CONTAINERS';
    return null;
  }

  private async createWorkflow(id: string, params: { jobId: string; attemptNo: number; fence: number; kind: string }) {
    try {
      await this.env.JOBS.create({ id, params: { ...params, projectSlug: this.config.PROJECT_SLUG } });
    } catch (err) {
      // A duplicate create after a lost response is fine if the instance exists.
      const inst = await this.env.JOBS.get(id).catch(() => null);
      if (!inst) throw err;
    }
  }

  private async cleanupJobContainers(jobId: string) {
    const attempts = this.db.all<{ attempt_no: number }>('SELECT attempt_no FROM job_attempt WHERE job_id = ?', jobId);
    for (const a of attempts) {
      const stub = this.env.EXECUTION.getByName(`${jobId}-a${a.attempt_no}`);
      await stub.destroyContainer('cancelled').catch(() => undefined);
    }
  }

  /** Expire attempts whose lease lapsed and whose workflow is no longer running. */
  private async recoverLeases(): Promise<number> {
    const now = Date.now();
    const stale = this.db.all<{ id: string; workflow_id: string | null; attempt_no: number; session_id: string | null; kind: string }>(
      "SELECT id, workflow_id, attempt_no, session_id, kind FROM job WHERE status IN ('leased','running') AND lease_expires_at < ?",
      now,
    );
    let expired = 0;
    for (const j of stale) {
      let running = false;
      if (j.workflow_id) {
        try {
          const status = await (await this.env.JOBS.get(j.workflow_id)).status();
          running = ['queued', 'running', 'waiting', 'waitingForPause'].includes(status.status);
        } catch {
          running = false;
        }
      }
      if (running) continue;
      await this.wfFail(j.id, this.db.value<number>('SELECT current_fence FROM job WHERE id = ?', j.id) ?? 0, 'LEASE_EXPIRED', 'lease expired and the workflow instance is not running');
      expired++;
    }
    return expired;
  }
}

function CHECK_REQUIRED(checkId: string, caps: Set<Capability>, checks: readonly CheckDefinition[]): boolean {
  return applicableChecks(caps, checks).some((c) => c.id === checkId);
}

/**
 * Record ID derived from the command's idempotency scope and key, so a command
 * that re-runs after a crash (before its receipt was stored) finds its own record.
 */
async function commandId(prefix: string, cmd: CommandEnvelope): Promise<string> {
  const hex = (await digestOf({ actor: cmd.actor, type: cmd.type, key: cmd.idempotencyKey })).slice('sha256:'.length);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return `${prefix}_${out}`;
}

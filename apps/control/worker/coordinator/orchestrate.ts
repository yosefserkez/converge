// Session progression rules. Each function runs synchronously inside a
// coordinator transaction; digests are precomputed by the async caller.
import {
  ALL_CAPABILITIES,
  type Capability,
  type CandidatePlan,
  type ChangeIntent,
  CHECKS,
  DomainError,
  type RevisionRef,
  type TaskSpec,
  assertTransition,
  capabilitiesOf,
  detectInteractions,
  newId,
  selectInitialCandidates,
  topoSortRevisions,
  type BaselineFacts,
  type SessionStatus,
} from '@converge/domain';
import { type Db, json, parse } from './db.ts';
import type { CandidateRow, CheckRunRow, ProposalRow, RevisionRow, SessionPolicy, SessionRow } from './model.ts';
import { appendEvent, createJob } from './store.ts';

export const SYSTEM_ACTOR = 'system:coordinator';

export function getSession(db: Db, id: string): SessionRow {
  const s = db.one<SessionRow>('SELECT * FROM session WHERE id = ?', id);
  if (!s) throw new DomainError('NOT_FOUND', `session ${id} not found`);
  return s;
}

export function setSessionStatus(db: Db, session: SessionRow, to: SessionStatus, reason: string, now: number): void {
  if (session.status === to) return;
  assertTransition('session', session.status, to);
  const terminal = ['promoted', 'failed', 'cancelled'].includes(to);
  db.run(
    'UPDATE session SET status = ?, version = version + 1, finished_at = ? WHERE id = ?',
    to,
    terminal ? now : null,
    session.id,
  );
  appendEvent(db, {
    sessionId: session.id,
    key: `session:${session.id}:status:${to}:${now}`,
    type: `session.${to}`,
    actor: SYSTEM_ACTOR,
    entityType: 'session',
    entityId: session.id,
    correlationId: session.id,
    payload: { from: session.status, to, reason },
  }, now);
  session.status = to;
}

export function proposalsOf(db: Db, sessionId: string): ProposalRow[] {
  return db.all<ProposalRow>('SELECT * FROM proposal WHERE session_id = ? ORDER BY created_at, id', sessionId);
}

export function latestRevision(db: Db, proposalId: string): RevisionRow | undefined {
  return db.one<RevisionRow>(
    'SELECT * FROM proposal_revision WHERE proposal_id = ? ORDER BY revision_no DESC LIMIT 1',
    proposalId,
  );
}

export function revisionDeps(db: Db, revisionId: string): string[] {
  return db
    .all<{ d: string }>('SELECT dependency_revision_id AS d FROM revision_dependency WHERE revision_id = ? ORDER BY d', revisionId)
    .map((r) => r.d);
}

export function taskOf(p: ProposalRow): TaskSpec {
  return parse<TaskSpec>(p.task_spec_json);
}

function toRef(db: Db, r: RevisionRow): RevisionRef & { ordinal: number } {
  const proposal = db.one<ProposalRow>('SELECT * FROM proposal WHERE id = ?', r.proposal_id)!;
  return {
    revisionId: r.id,
    proposalId: r.proposal_id,
    repoName: r.repo_name,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    treeSha: r.tree_sha,
    intentDigest: r.intent_digest,
    dependencyRevisionIds: revisionDeps(db, r.id),
    ordinal: taskOf(proposal).ordinal,
  };
}

export function candidateMembers(db: Db, candidateId: string): string[] {
  return db
    .all<{ r: string }>('SELECT revision_id AS r FROM candidate_member WHERE candidate_id = ? ORDER BY ordinal', candidateId)
    .map((x) => x.r);
}

export function candidateCapabilities(db: Db, candidateId: string): Set<Capability> {
  const members = candidateMembers(db, candidateId);
  const revisionToTask = new Map<string, string>();
  const tasks = new Map<string, TaskSpec>();
  for (const id of members) {
    const row = db.one<{ task_spec_json: string }>(
      'SELECT p.task_spec_json FROM proposal_revision r JOIN proposal p ON p.id = r.proposal_id WHERE r.id = ?',
      id,
    );
    if (!row) continue;
    const task = parse<TaskSpec>(row.task_spec_json);
    revisionToTask.set(id, task.id);
    tasks.set(task.id, task);
  }
  return capabilitiesOf(members, revisionToTask, [...tasks.values()]);
}

// ---------- intents and interactions ----------

/** Re-run deterministic detection over the latest declared intents and record new interactions. */
export function refreshInteractions(
  db: Db,
  session: SessionRow,
  digests: Map<string, string>,
  now: number,
): void {
  const proposals = proposalsOf(db, session.id).filter((p) => p.draft_intent_json && p.kind === 'feature');
  const facts = parse<BaselineFacts>(session.baseline_facts_json);
  const predicted = detectInteractions({
    baselineFacts: facts,
    proposals: proposals.map((p) => ({
      proposalId: p.id,
      intentDigest: digests.get(p.id) ?? '',
      intent: parse<ChangeIntent>(p.draft_intent_json),
      ordinal: taskOf(p).ordinal,
    })),
  });
  const live = new Set(predicted.map((i) => i.dedupeKey));
  for (const i of predicted) {
    const inserted = db.run(
      `INSERT OR IGNORE INTO interaction (id, session_id, left_proposal_id, right_proposal_id, left_intent_digest,
         right_intent_digest, contract_key, kind, state, explanation, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('ix'),
      session.id,
      i.leftProposalId,
      i.rightProposalId,
      i.leftIntentDigest,
      i.rightIntentDigest,
      i.contractKey ?? null,
      i.kind,
      i.state,
      i.explanation,
      i.dedupeKey,
      now,
      now,
    );
    if (!inserted) continue;
    appendEvent(db, {
      sessionId: session.id,
      key: `interaction:${i.dedupeKey}`,
      type: 'interaction.predicted',
      actor: SYSTEM_ACTOR,
      entityType: 'interaction',
      entityId: i.dedupeKey,
      correlationId: session.id,
      payload: { kind: i.kind, state: i.state, contractKey: i.contractKey ?? null, explanation: i.explanation },
    }, now);
    // Targeted inbox: each side learns about the other's relevant change only.
    for (const target of [i.leftProposalId, i.rightProposalId]) {
      db.run(
        `INSERT OR IGNORE INTO inbox_message (session_id, proposal_id, message_key, kind, payload_json, created_at)
         VALUES (?, ?, ?, 'interaction', ?, ?)`,
        session.id,
        target,
        `ix:${i.dedupeKey}:${target}`,
        json({ contractKey: i.contractKey ?? null, explanation: i.explanation, state: i.state }),
        now,
      );
    }
  }
  // Predictions computed from superseded intents are no longer current claims.
  for (const old of db.all<{ id: string; dedupe_key: string }>(
    "SELECT id, dedupe_key FROM interaction WHERE session_id = ? AND state = 'predicted'",
    session.id,
  )) {
    if (!live.has(old.dedupe_key)) {
      db.run("UPDATE interaction SET state = 'unknown', updated_at = ?, explanation = explanation || ' (superseded by a revised intent)' WHERE id = ?", now, old.id);
    }
  }
}

// ---------- candidates ----------

export interface PlanInput {
  label: string;
  memberRevisionIds: string[];
  anchorCandidateId?: string;
}

/** Build plans (async digest work happens in the caller via `finalizePlans`). */
export function draftPlan(db: Db, session: SessionRow, input: PlanInput): CandidatePlan {
  const policy = parse<SessionPolicy>(session.policy_json);
  const revisions = input.memberRevisionIds.map((id) => {
    const r = db.one<RevisionRow>('SELECT * FROM proposal_revision WHERE id = ?', id);
    if (!r) throw new DomainError('NOT_FOUND', `revision ${id} not found`);
    return toRef(db, r);
  });
  let anchor: CandidatePlan['anchor'];
  if (input.anchorCandidateId) {
    const a = db.one<CandidateRow>('SELECT * FROM candidate WHERE id = ?', input.anchorCandidateId);
    if (!a?.head_sha) throw new DomainError('INVALID_STATE', 'anchor candidate is not materialized');
    anchor = { candidateId: a.id, headSha: a.head_sha, includedRevisionIds: candidateMembers(db, a.id) };
  }
  const sorted = topoSortRevisions(revisions, { satisfiedRevisionIds: anchor?.includedRevisionIds ?? [] });
  return {
    schemaVersion: 1,
    sessionId: session.id,
    label: input.label,
    baselineSha: session.baseline_sha,
    expectedMainSha: policy.expectedMainSha,
    taskSetDigest: session.task_set_digest,
    members: sorted.map(({ ordinal: _o, ...ref }) => ref),
    ...(anchor ? { anchor } : {}),
    harnessDigest: session.harness_digest,
    policyDigest: session.policy_digest,
    environmentDigest: policy.environmentDigest,
  };
}

export function insertCandidate(
  db: Db,
  session: SessionRow,
  plan: CandidatePlan,
  planKey: string,
  integrationRepo: string,
  now: number,
): CandidateRow {
  const existing = db.one<CandidateRow>('SELECT * FROM candidate WHERE session_id = ? AND plan_key = ?', session.id, planKey);
  if (existing) return existing;
  const policy = parse<SessionPolicy>(session.policy_json);
  const count = db.value<number>('SELECT count(*) FROM candidate WHERE session_id = ?', session.id) ?? 0;
  if (count >= policy.maxCandidates) {
    throw new DomainError('LIMIT_EXCEEDED', 'candidate cap reached for this session', { maxCandidates: policy.maxCandidates });
  }
  const id = newId('cand');
  db.run(
    `INSERT INTO candidate (id, session_id, plan_key, plan_json, baseline_sha, expected_main_sha, repo_name, state,
       promotable, created_at, label, anchor_candidate_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?, ?)`,
    id,
    session.id,
    planKey,
    json(plan),
    plan.baselineSha,
    plan.expectedMainSha,
    integrationRepo,
    now,
    plan.label,
    plan.anchor?.candidateId ?? null,
  );
  plan.members.forEach((m, i) =>
    db.run('INSERT INTO candidate_member (candidate_id, revision_id, ordinal) VALUES (?, ?, ?)', id, m.revisionId, i),
  );
  appendEvent(db, {
    sessionId: session.id,
    key: `candidate:${id}:planned`,
    type: 'candidate.planned',
    actor: SYSTEM_ACTOR,
    entityType: 'candidate',
    entityId: id,
    correlationId: session.id,
    payload: { label: plan.label, members: plan.members.map((m) => m.revisionId), anchor: plan.anchor?.candidateId ?? null },
  }, now);
  createJob(db, {
    sessionId: session.id,
    kind: 'integrate',
    entityId: id,
    input: { candidateId: id },
    inputDigest: planKey,
    dedupeKey: `integrate:${id}`,
    deadlineAt: now + 15 * 60_000,
  }, now);
  return db.one<CandidateRow>('SELECT * FROM candidate WHERE id = ?', id)!;
}

export function setCandidateState(db: Db, c: CandidateRow, to: CandidateRow['state'], now: number, extra: Record<string, unknown> = {}): void {
  if (c.state === to) return;
  assertTransition('candidate', c.state, to);
  db.run(
    `UPDATE candidate SET state = ?, finished_at = CASE WHEN ? IN ('passed','failed','text_conflict','error','cancelled') THEN ? ELSE finished_at END WHERE id = ?`,
    to,
    to,
    now,
    c.id,
  );
  appendEvent(db, {
    sessionId: c.session_id,
    key: `candidate:${c.id}:${to}`,
    type: `candidate.${to}`,
    actor: SYSTEM_ACTOR,
    entityType: 'candidate',
    entityId: c.id,
    correlationId: c.session_id,
    payload: { label: c.label, from: c.state, to, ...extra },
  }, now);
  c.state = to;
}

/** Plans the selected initial candidates once every feature proposal has a sealed revision. */
export function initialPlanInputs(db: Db, session: SessionRow): PlanInput[] | null {
  const features = proposalsOf(db, session.id).filter((p) => p.kind === 'feature');
  if (features.some((p) => p.status !== 'sealed')) return null;
  const standalone: Array<{ proposalId: string; revisionId: string; ordinal: number }> = [];
  const labels = new Map<string, string>();
  for (const p of features) {
    const rev = latestRevision(db, p.id);
    if (!rev) return null;
    standalone.push({ proposalId: p.id, revisionId: rev.id, ordinal: taskOf(p).ordinal });
    labels.set(p.id, p.title);
  }
  const interactions = db.all<{ kind: string; left_proposal_id: string; right_proposal_id: string; state: string }>(
    'SELECT kind, left_proposal_id, right_proposal_id, state FROM interaction WHERE session_id = ?',
    session.id,
  );
  const policy = parse<SessionPolicy>(session.policy_json);
  return selectInitialCandidates({
    standalone,
    labels,
    interactions: interactions.map((i) => ({ kind: i.kind, state: i.state, leftProposalId: i.left_proposal_id, rightProposalId: i.right_proposal_id })),
    maxCandidates: policy.maxCandidates,
  })
    .filter((s) => s.kind !== 'baseline') // the baseline was planned at session start
    .map((s) => ({ label: s.label, memberRevisionIds: s.revisionIds }));
}

// ---------- verification outcomes ----------

export function latestRuns(db: Db, candidateId: string): CheckRunRow[] {
  return db.all<CheckRunRow>(
    `SELECT c.* FROM check_run c
     JOIN (SELECT check_key, max(attempt_no) AS a FROM check_run WHERE candidate_id = ? GROUP BY check_key) l
       ON l.check_key = c.check_key AND l.a = c.attempt_no
     WHERE c.candidate_id = ? ORDER BY c.check_key`,
    candidateId,
    candidateId,
  );
}

function proposalIdsOf(db: Db, candidateId: string): Set<string> {
  return new Set(
    db
      .all<{ p: string }>(
        'SELECT r.proposal_id AS p FROM candidate_member m JOIN proposal_revision r ON r.id = m.revision_id WHERE m.candidate_id = ?',
        candidateId,
      )
      .map((x) => x.p),
  );
}

/** Confirm interactions a failing combined candidate exhibits, and resolve ones a passing candidate fixes. */
export function updateInteractionsFromEvidence(db: Db, c: CandidateRow, now: number): void {
  const runs = latestRuns(db, c.id);
  const members = proposalIdsOf(db, c.id);
  const featureMembers = [...members].filter(
    (p) => db.value<string>('SELECT kind FROM proposal WHERE id = ?', p) === 'feature',
  );
  const failed = runs.filter((r) => r.status === 'failed');
  if (featureMembers.length >= 2) {
    for (const run of failed) {
      // Only a failure every member passed alone counts as an interaction.
      const memberAlonePassed = featureMembers.every((p) => standaloneOutcome(db, c.session_id, p, run.check_key) !== 'failed');
      if (!memberAlonePassed) continue;
      const open = db.all<{ id: string; left_proposal_id: string; right_proposal_id: string }>(
        "SELECT id, left_proposal_id, right_proposal_id FROM interaction WHERE session_id = ? AND state = 'predicted'",
        c.session_id,
      ).filter((i) => members.has(i.left_proposal_id) && members.has(i.right_proposal_id));
      if (open.length === 0 && !hasConfirmedFor(db, c.session_id, members)) {
        const [left, right] = featureMembers.sort();
        db.run(
          `INSERT OR IGNORE INTO interaction (id, session_id, left_proposal_id, right_proposal_id, left_intent_digest,
             right_intent_digest, kind, state, explanation, failed_candidate_id, failed_check_id, dedupe_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', '', 'assumption', 'confirmed', ?, ?, ?, ?, ?, ?)`,
          newId('ix'),
          c.session_id,
          left!,
          right!,
          `Combined behavior failed ${run.check_key} although each member passed alone; no declared assumption predicted it.`,
          c.id,
          run.id,
          `unpredicted:${c.id}:${run.check_key}`,
          now,
          now,
        );
      }
      for (const i of open) {
        assertTransition('interaction', 'predicted', 'confirmed');
        db.run(
          "UPDATE interaction SET state = 'confirmed', failed_candidate_id = ?, failed_check_id = ?, updated_at = ? WHERE id = ?",
          c.id,
          run.id,
          now,
          i.id,
        );
        appendEvent(db, {
          sessionId: c.session_id,
          key: `interaction:${i.id}:confirmed`,
          type: 'interaction.confirmed',
          actor: SYSTEM_ACTOR,
          entityType: 'interaction',
          entityId: i.id,
          correlationId: c.session_id,
          payload: { candidateId: c.id, checkId: run.check_key },
        }, now);
      }
    }
  }
  if (c.state !== 'passed') return;
  for (const i of db.all<{ id: string; left_proposal_id: string; right_proposal_id: string; check_key: string }>(
    `SELECT i.id, i.left_proposal_id, i.right_proposal_id, r.check_key FROM interaction i
     JOIN check_run r ON r.id = i.failed_check_id WHERE i.session_id = ? AND i.state = 'confirmed'`,
    c.session_id,
  )) {
    if (!members.has(i.left_proposal_id) || !members.has(i.right_proposal_id)) continue;
    const pass = runs.find((r) => r.check_key === i.check_key && r.status === 'passed');
    if (!pass) continue;
    db.run(
      "UPDATE interaction SET state = 'resolved', resolved_candidate_id = ?, resolution_check_id = ?, updated_at = ? WHERE id = ?",
      c.id,
      pass.id,
      now,
      i.id,
    );
    appendEvent(db, {
      sessionId: c.session_id,
      key: `interaction:${i.id}:resolved`,
      type: 'interaction.resolved',
      actor: SYSTEM_ACTOR,
      entityType: 'interaction',
      entityId: i.id,
      correlationId: c.session_id,
      payload: { candidateId: c.id, checkId: i.check_key },
    }, now);
  }
}

function hasConfirmedFor(db: Db, sessionId: string, members: Set<string>): boolean {
  return db
    .all<{ l: string; r: string }>(
      "SELECT left_proposal_id AS l, right_proposal_id AS r FROM interaction WHERE session_id = ? AND state = 'confirmed'",
      sessionId,
    )
    .some((i) => members.has(i.l) && members.has(i.r));
}

function standaloneOutcome(db: Db, sessionId: string, proposalId: string, checkKey: string): string | undefined {
  const rev = latestRevision(db, proposalId);
  if (!rev) return undefined;
  const cand = db.one<{ id: string }>(
    `SELECT c.id FROM candidate c WHERE c.session_id = ? AND
       (SELECT count(*) FROM candidate_member m WHERE m.candidate_id = c.id) = 1 AND
       EXISTS (SELECT 1 FROM candidate_member m WHERE m.candidate_id = c.id AND m.revision_id = ?)
     ORDER BY c.created_at DESC LIMIT 1`,
    sessionId,
    rev.id,
  );
  if (!cand) return undefined;
  return latestRuns(db, cand.id).find((r) => r.check_key === checkKey)?.status;
}

export function isFullGoal(caps: Set<Capability>): boolean {
  return ALL_CAPABILITIES.every((c) => caps.has(c));
}

export type NextStep =
  | { kind: 'wait' }
  | { kind: 'ready'; candidateId: string }
  | { kind: 'repair'; failedCandidateId: string }
  | { kind: 'attention'; reason: string };

/** Decide what the session needs once no candidate or proposal is in flight. */
export function decideNext(db: Db, session: SessionRow): NextStep {
  const busyCandidates = db.value<number>(
    "SELECT count(*) FROM candidate WHERE session_id = ? AND state IN ('planned','assembling','testing')",
    session.id,
  );
  const busyProposals = db.value<number>(
    "SELECT count(*) FROM proposal WHERE session_id = ? AND status IN ('pending','working')",
    session.id,
  );
  if (busyCandidates || busyProposals) return { kind: 'wait' };
  const candidates = db.all<CandidateRow>('SELECT * FROM candidate WHERE session_id = ? ORDER BY created_at DESC', session.id);
  const passedFull = candidates.find((c) => c.state === 'passed' && isFullGoal(candidateCapabilities(db, c.id)));
  if (passedFull) return { kind: 'ready', candidateId: passedFull.id };
  const policy = parse<SessionPolicy>(session.policy_json);
  const repairs = db.all<ProposalRow>("SELECT * FROM proposal WHERE session_id = ? AND kind = 'repair'", session.id);
  const repaired = new Set(repairs.map((r) => r.base_candidate_id));
  const latestRepair = repairs.sort((a, b) => b.created_at - a.created_at)[0];
  const failedMulti = candidates.filter((c) => c.state === 'failed' && candidateMembers(db, c.id).length >= 2 && !repaired.has(c.id));
  let target: CandidateRow | undefined;
  if (latestRepair) {
    const rev = latestRevision(db, latestRepair.id);
    target = failedMulti.find((c) => rev && candidateMembers(db, c.id).includes(rev.id));
  } else {
    target = [...failedMulti].sort((a, b) => candidateMembers(db, a.id).length - candidateMembers(db, b.id).length || a.created_at - b.created_at)[0];
  }
  const blocked = candidates.find((c) => c.state === 'text_conflict' || c.state === 'error');
  if (!target) {
    return { kind: 'attention', reason: blocked ? `candidate ${blocked.label} ended in ${blocked.state}` : 'no promotable candidate and no repairable failure' };
  }
  if (repairs.length >= policy.maxRepairAttempts) {
    return { kind: 'attention', reason: `repair limit (${policy.maxRepairAttempts}) reached` };
  }
  return { kind: 'repair', failedCandidateId: target.id };
}

/** Check catalog entries for a candidate's derived capabilities. */
export function applicableChecks(caps: Set<Capability>) {
  return CHECKS.filter((c) => !c.requires || caps.has(c.requires));
}

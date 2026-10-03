// Shared drivers for the coordinator tests. They play the part of the job
// workflows: lease a job, call the coordinator callbacks, and write evidence to
// the test R2 bucket. Git, containers and models are simulated with fake data.
import { env, runInDurableObject } from 'cloudflare:test';
import {
  CHECKS,
  type Capability,
  type CheckResult,
  type CheckStatus,
  type EvidenceRef,
  type Observation,
  checkApplicability,
  requestDigest,
  sha256Hex,
} from '@converge/domain';
import cachingManifest from '../../../fixtures/deterministic/caching/manifest.json';
import checkoutManifest from '../../../fixtures/deterministic/checkout/manifest.json';
import pricingManifest from '../../../fixtures/deterministic/pricing/manifest.json';
import repairManifest from '../../../fixtures/deterministic/repair/manifest.json';
import type { CommandEnvelope, CommandType, ProjectCoordinator } from '../worker/coordinator/index.ts';
import type { SessionSnapshot } from '../worker/coordinator/queries.ts';
import type { Lease } from '../worker/coordinator/store.ts';
import { evidencePrefix, writeEvidence } from '../worker/evidence.ts';

export type Coordinator = DurableObjectStub<ProjectCoordinator>;
export type Role = 'pricing' | 'caching' | 'checkout' | 'repair';

export const ACTOR = 'local-operator';
export const SLUG = 'storefront';

interface FixtureManifest {
  role: string;
  summary: string;
  files: Record<string, string>;
  intent: unknown;
}

export const MANIFESTS: Record<Role, FixtureManifest> = {
  pricing: pricingManifest,
  caching: cachingManifest,
  checkout: checkoutManifest,
  repair: repairManifest,
};

let counter = 0;

/** A fresh coordinator instance. Each test uses its own name, so storage never leaks between tests. */
export function freshCoordinator(label: string): Coordinator {
  counter += 1;
  return env.PROJECTS.getByName(`${SLUG}-${label}-${counter}-${crypto.randomUUID().slice(0, 8)}`);
}

/** Deterministic fake 40-hex Git object ID. */
export async function fakeSha(label: string): Promise<string> {
  return (await sha256Hex(`git:${label}`)).slice(0, 40);
}

export async function fakeDigest(label: string): Promise<string> {
  return `sha256:${await sha256Hex(`digest:${label}`)}`;
}

export interface CommandOutcome<T> {
  status: number;
  body: T;
}

export interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

/** Send an operator command. The request digest covers the type and params, like the HTTP layer. */
export async function command<T = Record<string, unknown>>(
  stub: Coordinator,
  type: CommandType,
  params: Record<string, unknown> = {},
  options: { key?: string; digestOf?: unknown } = {},
): Promise<CommandOutcome<T>> {
  const envelope: CommandEnvelope = {
    type,
    actor: ACTOR,
    idempotencyKey: options.key ?? `key-${crypto.randomUUID()}`,
    requestDigest: await requestDigest(options.digestOf ?? { type, params }),
    params,
  };
  const r = await stub.command(envelope);
  return { status: r.status, body: JSON.parse(r.bodyJson) as T };
}

/** Send a command and fail the test when it does not succeed. */
export async function ok<T = Record<string, unknown>>(
  stub: Coordinator,
  type: CommandType,
  params: Record<string, unknown> = {},
): Promise<T> {
  const r = await command<T>(stub, type, params);
  if (r.status >= 300) throw new Error(`${type} failed with ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

export function sql<T extends Record<string, SqlStorageValue>>(stub: Coordinator, query: string, ...params: Array<string | number | null>): Promise<T[]> {
  return runInDurableObject(stub, (_instance: ProjectCoordinator, state) => state.storage.sql.exec<T>(query, ...params).toArray());
}

export interface JobInfo extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  entity_id: string;
  status: string;
  attempt_no: number;
  current_fence: number;
  input_json: string;
}

export function jobs(stub: Coordinator, where = '1 = 1', ...params: Array<string | number | null>): Promise<JobInfo[]> {
  return sql<JobInfo>(
    stub,
    `SELECT id, kind, entity_id, status, attempt_no, current_fence, input_json FROM job WHERE ${where} ORDER BY created_at, rowid`,
    ...params,
  );
}

export async function jobById(stub: Coordinator, id: string): Promise<JobInfo> {
  const [job] = await jobs(stub, 'id = ?', id);
  if (!job) throw new Error(`job ${id} not found`);
  return job;
}

/** Lease the current attempt of a job, as the workflow instance for that attempt would. */
export async function lease(stub: Coordinator, jobId: string): Promise<Lease> {
  const job = await jobById(stub, jobId);
  const l = await stub.wfLease(job.id, job.attempt_no, job.current_fence);
  if (!l) throw new Error(`lease refused for job ${jobId}`);
  return l;
}

export async function snapshot(stub: Coordinator, sessionId: string): Promise<SessionSnapshot> {
  return JSON.parse(await stub.getSessionSnapshotJson(sessionId)) as SessionSnapshot;
}

export interface CandidateView {
  id: string;
  label: string;
  state: string;
  headSha: string | null;
  treeSha: string | null;
  manifestDigest: string | null;
  validationDigest: string | null;
  promotable: boolean;
  fullGoal: boolean;
  capabilities: Capability[];
  anchorCandidateId: string | null;
  members: string[];
  expectedMainSha: string;
  checks: Array<{ checkId: string; status: string; applicable: boolean; assertionCount: number; evidenceId: string | null }>;
}

export async function candidate(stub: Coordinator, id: string): Promise<CandidateView> {
  return JSON.parse(await stub.getCandidateJson(id)) as CandidateView;
}

// ---------- seed ----------

export interface Seeded {
  mainSha: string;
  lockfileDigest: string;
  seedJobId: string;
}

export async function seedProject(stub: Coordinator): Promise<Seeded> {
  const body = await ok<{ jobId: string }>(stub, 'seed');
  const mainSha = await fakeSha('baseline-main');
  const lockfileDigest = await fakeDigest('package-lock.json');
  const l = await lease(stub, body.jobId);
  await stub.wfSeeded(l.jobId, l.fence, { headSha: mainSha, lockfileDigest });
  return { mainSha, lockfileDigest, seedJobId: body.jobId };
}

/** Seed, create a fixture session, and start it. */
export async function startedSession(stub: Coordinator): Promise<{ seeded: Seeded; sessionId: string }> {
  const seeded = await seedProject(stub);
  const { sessionId } = await ok<{ sessionId: string }>(stub, 'createSession', { mode: 'fixture' });
  await ok(stub, 'startSession', { sessionId });
  return { seeded, sessionId };
}

// ---------- agents ----------

export interface AgentInput {
  sessionId: string;
  proposalId: string;
  role: Role;
  baseRepo: string;
  baseSha: string;
  proposalRepo: string;
}

export async function agentJobFor(stub: Coordinator, role: Role): Promise<{ job: JobInfo; input: AgentInput }> {
  for (const job of await jobs(stub, "kind = 'agent'")) {
    const input = JSON.parse(job.input_json) as AgentInput;
    if (input.role === role) return { job, input };
  }
  throw new Error(`no agent job for ${role}`);
}

export async function writeDiff(sessionId: string, role: string, paths: string[]): Promise<EvidenceRef> {
  const body = paths.map((p) => `diff --git a/${p} b/${p}\n+fixture change for ${role}\n`).join('');
  return writeEvidence(env.EVIDENCE, { prefix: evidencePrefix(SLUG, sessionId, 'diffs'), body, visibility: 'private' });
}

/** Lease, mark working, and declare the fixture intent. */
export async function startAgent(stub: Coordinator, role: Role): Promise<{ lease: Lease; input: AgentInput }> {
  const { job, input } = await agentJobFor(stub, role);
  const l = await lease(stub, job.id);
  await stub.wfMarkWorking(l.jobId, l.fence);
  await stub.wfDeclareIntent(l.jobId, l.fence, 0, MANIFESTS[role].intent);
  return { lease: l, input };
}

export interface Sealed {
  revisionId: string;
  headSha: string;
  diff: EvidenceRef;
}

export async function sealAgent(stub: Coordinator, l: Lease, input: AgentInput): Promise<Sealed> {
  const manifest = MANIFESTS[input.role];
  const changedPaths = Object.keys(manifest.files);
  const diff = await writeDiff(input.sessionId, input.role, changedPaths);
  const headSha = await fakeSha(`revision:${input.proposalId}`);
  const r = await stub.wfSeal(l.jobId, l.fence, {
    headSha,
    treeSha: await fakeSha(`tree:${input.proposalId}`),
    baseSha: input.baseSha,
    repoName: input.proposalRepo,
    changedPaths,
    diff,
    summary: manifest.summary,
  });
  return { revisionId: r.revisionId, headSha, diff };
}

export async function runAgent(stub: Coordinator, role: Role): Promise<Sealed> {
  const { lease: l, input } = await startAgent(stub, role);
  return sealAgent(stub, l, input);
}

// ---------- integrate and verify ----------

export async function integrate(stub: Coordinator, jobId: string) {
  const l = await lease(stub, jobId);
  const plan = await stub.wfAssembly(l.jobId, l.fence);
  const headSha = await fakeSha(`candidate:${plan.candidateId}`);
  await stub.wfAssembled(l.jobId, l.fence, {
    status: 'merged',
    headSha,
    treeSha: await fakeSha(`candidate-tree:${plan.candidateId}`),
    executionImageDigest: 'registry.example/converge-workspace@sha256:test',
  });
  return { plan, headSha };
}

/** Outcome for one check: a status, or 'auto' (skip when not applicable, else pass). */
export type Verdict = 'passed' | 'failed' | 'skipped' | 'error';
export type Decide = (candidate: CandidateView, checkId: string, applicable: boolean) => Verdict;

export const passAll: Decide = (_c, _id, applicable) => (applicable ? 'passed' : 'skipped');

export function checkResult(
  input: { candidateId: string; headSha: string; manifestDigest: string; harnessDigest: string },
  checkId: string,
  applicable: boolean,
  applicabilityReason: string,
  status: Verdict,
): CheckResult {
  const now = Date.now();
  let observations: Observation[] = [];
  if (status === 'passed') {
    observations = [
      { label: `${checkId} assertion 1`, expected: true, observed: true, passed: true },
      { label: `${checkId} assertion 2`, expected: true, observed: true, passed: true },
    ];
  } else if (status === 'failed') {
    observations = [
      { label: 'member-1 backpack unit price', expected: 8000, observed: 8000, passed: true },
      { label: 'regular-1 backpack unit price after member-1', expected: 10000, observed: 8000, passed: false },
    ];
  }
  return {
    schemaVersion: 1,
    checkId,
    candidateId: input.candidateId,
    candidateHeadSha: input.headSha,
    candidateManifestDigest: input.manifestDigest,
    harnessDigest: input.harnessDigest,
    status: status as CheckStatus,
    applicable,
    applicabilityReason,
    assertionCount: observations.length,
    failedCount: observations.filter((o) => !o.passed).length,
    observations,
    startedAt: now,
    finishedAt: now,
  };
}

/** Record every catalog check for the candidate's verify job, then finish verification. */
export async function verify(stub: Coordinator, jobId: string, decide: Decide = passAll) {
  const l = await lease(stub, jobId);
  const input = await stub.wfVerifyInput(l.jobId, l.fence);
  const view = await candidate(stub, input.candidateId);
  const caps = new Set(input.capabilities as Capability[]);
  for (const check of CHECKS) {
    const a = checkApplicability(check, caps);
    const result = checkResult(
      { candidateId: input.candidateId, headSha: input.headSha, manifestDigest: input.manifestDigest, harnessDigest: input.harnessDigest },
      check.id,
      a.applicable,
      a.reason,
      decide(view, check.id, a.applicable),
    );
    const ref = await writeEvidence(env.EVIDENCE, {
      prefix: evidencePrefix(SLUG, input.sessionId, 'checks'),
      body: result,
      visibility: 'private',
    });
    await stub.wfRecordCheck(l.jobId, l.fence, result, ref);
  }
  await stub.wfVerified(l.jobId, l.fence);
  return input;
}

/** Drive every queued integrate and verify job, oldest first, until none is left. */
export async function pump(stub: Coordinator, decide: Decide = passAll): Promise<number> {
  let driven = 0;
  for (;;) {
    const [next] = await jobs(stub, "status = 'queued' AND kind IN ('integrate', 'verify')");
    if (!next) return driven;
    if (next.kind === 'integrate') await integrate(stub, next.id);
    else await verify(stub, next.id, decide);
    driven += 1;
  }
}

/** Catch an async error and return its message (RPC keeps only the message). */
export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw');
}

import { z } from 'zod';

// ---------- primitives ----------

export const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/, 'invalid id');
export type Id = z.infer<typeof Id>;

/** SHA-1 Git object ID, the format Artifacts repositories use. */
export const GitOid = z.string().regex(/^[0-9a-f]{40}$/, 'invalid git object id');
export type GitOid = z.infer<typeof GitOid>;

export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'invalid digest');
export type Digest = z.infer<typeof Digest>;

/** Flat Artifacts repository name. */
export const RepoName = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/, 'invalid repo name');

/** Repository-relative POSIX path with no traversal, no absolute paths, no .git. */
export const RepoPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git'),
    'invalid repository path',
  );

/** Path glob: a RepoPath that may end in `/**` to cover a directory. */
export const PathPattern = z
  .string()
  .min(1)
  .max(240)
  .refine((p) => RepoPath.safeParse(p.replace(/\/\*\*$/, '')).success, 'invalid path pattern');

export const FactValue = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string()), z.null()]);
export type FactValue = z.infer<typeof FactValue>;

export const ContractKey = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'invalid contract key');

// ---------- intents ----------

export const Assumption = z.discriminatedUnion('operator', [
  z.object({ key: ContractKey, operator: z.literal('eq'), expected: FactValue, rationale: z.string().min(1).max(500) }),
  z.object({ key: ContractKey, operator: z.literal('subset_of'), expected: z.array(z.string()), rationale: z.string().min(1).max(500) }),
  z.object({ key: ContractKey, operator: z.literal('contains'), expected: z.string(), rationale: z.string().min(1).max(500) }),
]);
export type Assumption = z.infer<typeof Assumption>;

export const ContractChange = z.object({
  key: ContractKey,
  before: FactValue,
  after: FactValue,
  explanation: z.string().min(1).max(500),
});
export type ContractChange = z.infer<typeof ContractChange>;

const ResourceRef = z.string().regex(/^[a-z]+:[a-z0-9.-]+$/, 'expected kind:name');

export const ChangeIntent = z.object({
  schemaVersion: z.literal(1),
  objective: z.string().min(1).max(1000),
  reads: z.array(ResourceRef).max(32),
  writes: z.array(ResourceRef).max(32),
  affectedPaths: z.array(RepoPath).max(64),
  assumptions: z.array(Assumption).max(32),
  contractChanges: z.array(ContractChange).max(32),
  preservedInvariants: z.array(z.string().min(1).max(300)).max(32),
  proposedCheckIds: z.array(z.string().max(64)).max(32),
  dependencyRevisionIds: z.array(Id).max(16),
});
export type ChangeIntent = z.infer<typeof ChangeIntent>;

export const BaselineFacts = z.record(ContractKey, FactValue);
export type BaselineFacts = z.infer<typeof BaselineFacts>;

// ---------- tasks and revisions ----------

export const Capability = z.enum([
  'membership-pricing', 'quote-cache', 'checkout-summary',
  'view-limits', 'view-limits-ui', 'conditional-get',
]);
export type Capability = z.infer<typeof Capability>;

export const TaskSpec = z.object({
  id: Id,
  title: z.string().min(1).max(120),
  role: z.enum(['pricing', 'caching', 'checkout', 'storage', 'api-ui', 'delivery', 'repair']),
  objective: z.string().min(1).max(4000),
  capabilityIds: z.array(Capability),
  editablePaths: z.array(PathPattern).min(1),
  forbiddenPaths: z.array(PathPattern),
  requiredCheckIds: z.array(z.string()),
  preservedInvariantIds: z.array(z.string()),
  baselineSha: GitOid,
  ordinal: z.number().int().nonnegative(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const RevisionRef = z.object({
  revisionId: Id,
  proposalId: Id,
  repoName: RepoName,
  baseSha: GitOid,
  headSha: GitOid,
  treeSha: GitOid,
  intentDigest: Digest,
  dependencyRevisionIds: z.array(Id),
});
export type RevisionRef = z.infer<typeof RevisionRef>;

export const CandidatePlan = z.object({
  schemaVersion: z.literal(1),
  sessionId: Id,
  label: z.string().min(1).max(80),
  baselineSha: GitOid,
  expectedMainSha: GitOid,
  taskSetDigest: Digest,
  members: z.array(RevisionRef),
  anchor: z
    .object({ candidateId: Id, headSha: GitOid, includedRevisionIds: z.array(Id) })
    .optional(),
  harnessDigest: Digest,
  policyDigest: Digest,
  environmentDigest: Digest,
});
export type CandidatePlan = z.infer<typeof CandidatePlan>;

export const CandidateManifest = z.object({
  schemaVersion: z.literal(1),
  planDigest: Digest,
  plan: CandidatePlan,
  headSha: GitOid,
  treeSha: GitOid,
  executionImageDigest: z.string().min(1),
  lockfileDigest: Digest,
  verifierBuildId: z.string().min(1),
  createdAt: z.number().int(),
});
export type CandidateManifest = z.infer<typeof CandidateManifest>;

export const EvidenceRef = z.object({
  key: z.string().regex(/^(private|public)\/[A-Za-z0-9/_.:-]+$/),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  contentType: z.string(),
  visibility: z.enum(['private', 'public']),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const CheckStatus = z.enum(['passed', 'failed', 'error', 'skipped']);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const Observation = z.object({
  label: z.string(),
  expected: z.unknown(),
  observed: z.unknown(),
  passed: z.boolean(),
});
export type Observation = z.infer<typeof Observation>;

export const CheckResult = z.object({
  schemaVersion: z.literal(1),
  checkId: z.string(),
  candidateId: Id,
  candidateHeadSha: GitOid,
  candidateManifestDigest: Digest,
  harnessDigest: Digest,
  status: CheckStatus,
  applicable: z.boolean(),
  applicabilityReason: z.string(),
  assertionCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  observations: z.array(Observation),
  startedAt: z.number().int(),
  finishedAt: z.number().int(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ValidationManifest = z.object({
  schemaVersion: z.literal(1),
  candidateId: Id,
  headSha: GitOid,
  candidateManifestDigest: Digest,
  policyDigest: Digest,
  harnessDigest: Digest,
  requiredChecks: z.array(z.object({ checkId: z.string(), result: EvidenceRef })),
  excludedChecks: z.array(z.object({ checkId: z.string(), reason: z.string() })),
  fullGoalSatisfied: z.boolean(),
});
export type ValidationManifest = z.infer<typeof ValidationManifest>;

export const ApprovalRequest = z.object({
  candidateId: Id,
  headSha: GitOid,
  expectedMainSha: GitOid,
  validationDigest: Digest,
  decision: z.enum(['approve', 'reject']),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const SourceFile = z.object({ path: RepoPath, utf8: z.string(), sha256: Digest });
export type SourceFile = z.infer<typeof SourceFile>;

export const SourceBundle = z.object({
  schemaVersion: z.literal(1),
  baselineSha: GitOid,
  files: z.array(SourceFile),
});
export type SourceBundle = z.infer<typeof SourceBundle>;

export const AgentCheckpoint = z.object({
  schemaVersion: z.literal(1),
  sessionId: Id,
  jobId: Id,
  attemptNo: z.number().int().positive(),
  fence: z.number().int().positive(),
  turn: z.number().int().nonnegative(),
  intentVersion: z.number().int().nonnegative(),
  source: EvidenceRef,
  privateProviderMessages: EvidenceRef,
  lastInboxSequence: z.number().int().nonnegative(),
  completedOperationIds: z.array(z.string()),
  createdAt: z.number().int(),
});
export type AgentCheckpoint = z.infer<typeof AgentCheckpoint>;

export const PreviewCapability = z.object({
  version: z.literal(1),
  scope: z.literal('candidate-preview'),
  projectId: Id,
  candidateId: Id,
  headSha: GitOid,
  resourceId: Id,
  expiresAt: z.number().int(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
export type PreviewCapability = z.infer<typeof PreviewCapability>;

export const PublishedReplay = z.object({
  schemaVersion: z.literal(1),
  replayId: Id,
  sourceSessionId: Id,
  originalMode: z.enum(['live', 'fixture']),
  recordedAt: z.number().int(),
  publishedAt: z.number().int(),
  publicSnapshot: EvidenceRef,
});
export type PublishedReplay = z.infer<typeof PublishedReplay>;

// ---------- statuses ----------

export const SessionStatus = z.enum([
  'created', 'preflight', 'running', 'validating', 'repairing',
  'ready', 'promoted', 'needs_attention', 'failed', 'cancelled',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ProposalStatus = z.enum(['pending', 'working', 'sealed', 'blocked', 'cancelled']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const CandidateState = z.enum([
  'planned', 'assembling', 'testing', 'passed', 'failed', 'text_conflict', 'error', 'cancelled',
]);
export type CandidateState = z.infer<typeof CandidateState>;

export const JobStatus = z.enum(['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobKind = z.enum(['agent', 'integrate', 'verify', 'promote', 'cleanup', 'seed']);
export type JobKind = z.infer<typeof JobKind>;

export const InteractionState = z.enum(['predicted', 'confirmed', 'resolved', 'unknown']);
export type InteractionState = z.infer<typeof InteractionState>;

export const InteractionKind = z.enum(['assumption', 'shared_write', 'dependency', 'file_overlap']);
export type InteractionKind = z.infer<typeof InteractionKind>;

export const SessionMode = z.enum(['live', 'fixture']);
export type SessionMode = z.infer<typeof SessionMode>;

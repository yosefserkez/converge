// DTO types the SPAs render. Import with `import type` only.
// SessionSnapshot and PublicReplay come straight from the worker functions.
// The coordinator class cannot enter a browser type check, so the detail DTOs
// below list only the fields the UI reads. worker/dto-check.ts proves at
// compile time that the real responses still satisfy them.
import type { CandidateManifest, ChangeIntent, CheckResult, TaskSpec } from '@converge/domain';
import type { SessionSnapshot } from '../worker/coordinator/queries.ts';

export type { SessionSnapshot } from '../worker/coordinator/queries.ts';
export type { PublicReplay } from '../worker/replay.ts';

type SnapCandidate = SessionSnapshot['candidates'][number];
type SnapRevision = SessionSnapshot['proposals'][number]['revisions'][number];

/** GET /api/candidates/:id */
export interface CandidateDetail {
  id: string;
  sessionId: string;
  label: string;
  state: SnapCandidate['state'];
  headSha: string | null;
  treeSha: string | null;
  expectedMainSha: string;
  observedMainSha: string | null;
  manifest: CandidateManifest | null;
  manifestDigest: string | null;
  validationDigest: string | null;
  promotable: boolean;
  fullGoal: boolean;
  capabilities: string[];
  anchorCandidateId: string | null;
  members: string[];
  checks: Array<{
    id: string;
    checkId: string;
    attemptNo: number;
    status: string;
    applicable: boolean;
    applicabilityReason: string;
    assertionCount: number;
    failedCount: number;
    result: CheckResult | null;
    evidenceId: string | null;
  }>;
}

/** GET /api/proposals/:id */
export interface ProposalDetail {
  id: string;
  sessionId: string;
  title: string;
  kind: 'feature' | 'repair';
  status: string;
  taskSpec: TaskSpec;
  baseCandidateId: string | null;
  intents: Array<{ version: number; intent: ChangeIntent; digest: string; createdAt: number }>;
  revisions: SnapRevision[];
}

/** GET /api/project */
export type ProjectSummary =
  | { seeded: false; slug: string }
  | {
      seeded: boolean;
      slug: string;
      canonicalRepo: string;
      defaultBranch: string;
      observedMainSha: string | null;
      presetBaselineSha: string | null;
      seedJobStatus: string | null;
      presetCompatible: boolean;
    };

/** One row of GET /api/sessions */
export interface SessionListItem {
  id: string;
  mode: string;
  status: string;
  objective: string;
  createdAt: number;
  finishedAt: number | null;
}

/** GET /api/config */
export interface ConfigDto {
  environment: string;
  projectSlug: string;
  buildId: string;
  authMode: string;
  operator: string;
  liveExecutionEnabled: boolean;
  modelId: string;
  defaultBudgetMicroUsd: number;
  limits: {
    maxConcurrentAgents: number;
    maxCandidatesPerSession: number;
    maxRepairAttempts: number;
    maxAgentTurns: number;
    previewTtlSeconds: number;
  };
  previewOrigin: string;
}

/** GET /api/evidence/:id */
export interface EvidenceDto {
  id: string;
  kind: string;
  sha256: string;
  bytes: number;
  contentType: string;
  verified: boolean;
  content: unknown;
}

/** GET /api/sessions/:id/events */
export interface EventsPage {
  events: Array<{
    seq: number;
    type: string;
    actor: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    visibility: 'private' | 'public';
    createdAt: number;
  }>;
  cursor: number;
  hasMore: boolean;
}

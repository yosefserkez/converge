// Row shapes the coordinator reads back from SQLite.
import type { CandidateState, ProposalStatus, SessionMode, SessionStatus } from '@converge/domain';

export interface ProjectRow extends Record<string, SqlStorageValue> {
  id: string;
  slug: string;
  canonical_repo: string;
  default_branch: string;
  observed_main_sha: string | null;
  policy_json: string;
}

/** Project policy captured at seed time. */
export interface ProjectPolicy {
  seededBaselineSha: string | null;
  lockfileDigest: string | null;
  seedJobId: string | null;
  /** Project mode: dependency snapshot restored by candidate containers (offline). */
  snapshotId?: string | null;
}

export interface SessionRow extends Record<string, SqlStorageValue> {
  id: string;
  project_id: string;
  objective: string;
  mode: SessionMode;
  baseline_sha: string;
  task_set_json: string;
  task_set_digest: string;
  baseline_facts_json: string;
  policy_json: string;
  policy_digest: string;
  harness_digest: string;
  model_budget_microusd: number;
  status: SessionStatus;
  created_by: string;
  created_at: number;
  finished_at: number | null;
}

export interface SessionPolicy {
  /** Registry project; absent on sessions created before project mode (storefront). */
  projectKind?: 'storefront' | 'pastebin';
  maxCandidates: number;
  maxRepairAttempts: number;
  maxAgentTurns: number;
  fullGoalCapabilities: string[];
  protectedPaths: string[];
  lockfileDigest: string;
  environmentDigest: string;
  expectedMainSha: string;
  modelId: string | null;
  priceSnapshot: unknown;
}

export interface ProposalRow extends Record<string, SqlStorageValue> {
  id: string;
  session_id: string;
  title: string;
  kind: 'feature' | 'repair';
  task_spec_json: string;
  task_spec_digest: string;
  base_candidate_id: string | null;
  draft_intent_json: string | null;
  intent_version: number;
  status: ProposalStatus;
  repo_name: string | null;
  summary: string | null;
  created_at: number;
}

export interface RevisionRow extends Record<string, SqlStorageValue> {
  id: string;
  proposal_id: string;
  revision_no: number;
  repo_name: string;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  intent_json: string;
  intent_digest: string;
  diff_evidence_key: string;
  diff_evidence_digest: string;
  created_at: number;
}

export interface CandidateRow extends Record<string, SqlStorageValue> {
  id: string;
  session_id: string;
  label: string;
  plan_key: string;
  plan_json: string;
  baseline_sha: string;
  expected_main_sha: string;
  repo_name: string;
  head_sha: string | null;
  tree_sha: string | null;
  manifest_json: string | null;
  manifest_digest: string | null;
  validation_digest: string | null;
  state: CandidateState;
  promotable: number;
  anchor_candidate_id: string | null;
  error_json: string | null;
  created_at: number;
}

export interface CheckRunRow extends Record<string, SqlStorageValue> {
  id: string;
  candidate_id: string;
  job_id: string;
  check_key: string;
  attempt_no: number;
  harness_digest: string;
  required: number;
  applicable: number;
  applicability_reason: string;
  status: string;
  assertion_count: number;
  failed_count: number;
  result_json: string | null;
  evidence_key: string | null;
  evidence_digest: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export const ACTIVE_SESSION_STATES: readonly SessionStatus[] = [
  'created', 'preflight', 'running', 'validating', 'repairing', 'ready',
];

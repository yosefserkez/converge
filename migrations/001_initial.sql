-- Converge: initial project-local schema.
-- Run through versioned migrations inside one ProjectCoordinator Durable Object.
-- Business-level invariants and JSON schemas are specified in the master prompt.
-- SQLite-compatible reference DDL; validate again in the deployed DO runtime.

CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  slug TEXT NOT NULL UNIQUE,
  canonical_repo TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  observed_main_sha TEXT,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  objective TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'fixture')),
  baseline_sha TEXT NOT NULL,
  task_set_json TEXT NOT NULL CHECK (json_valid(task_set_json)),
  task_set_digest TEXT NOT NULL,
  baseline_facts_json TEXT NOT NULL CHECK (json_valid(baseline_facts_json)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  policy_digest TEXT NOT NULL,
  harness_digest TEXT NOT NULL,
  model_budget_microusd INTEGER NOT NULL CHECK (model_budget_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN
    ('created', 'preflight', 'running', 'validating', 'repairing',
     'ready', 'promoted', 'needs_attention', 'failed', 'cancelled')),
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX session_project_created ON session(project_id, created_at DESC);

CREATE TABLE proposal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feature', 'repair')),
  task_spec_json TEXT NOT NULL CHECK (json_valid(task_spec_json)),
  task_spec_digest TEXT NOT NULL,
  base_candidate_id TEXT REFERENCES candidate(id),
  draft_intent_json TEXT CHECK (draft_intent_json IS NULL OR json_valid(draft_intent_json)),
  intent_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'working', 'sealed', 'blocked', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'feature' AND base_candidate_id IS NULL) OR
         (kind = 'repair' AND base_candidate_id IS NOT NULL))
);
CREATE INDEX proposal_session ON proposal(session_id, created_at);

CREATE TABLE proposal_revision (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposal(id),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  repo_name TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  intent_digest TEXT NOT NULL,
  diff_evidence_key TEXT NOT NULL,
  diff_evidence_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (proposal_id, revision_no)
);
CREATE TRIGGER proposal_revision_immutable
BEFORE UPDATE ON proposal_revision
BEGIN
  SELECT RAISE(ABORT, 'sealed proposal revisions are immutable');
END;

CREATE TABLE revision_dependency (
  revision_id TEXT NOT NULL REFERENCES proposal_revision(id),
  dependency_revision_id TEXT NOT NULL REFERENCES proposal_revision(id),
  PRIMARY KEY (revision_id, dependency_revision_id),
  CHECK (revision_id <> dependency_revision_id)
);
CREATE INDEX dependency_reverse ON revision_dependency(dependency_revision_id);

CREATE TABLE candidate (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  plan_key TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  baseline_sha TEXT NOT NULL,
  expected_main_sha TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  head_sha TEXT,
  tree_sha TEXT,
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  manifest_digest TEXT,
  validation_digest TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('planned', 'assembling', 'testing', 'passed', 'failed', 'text_conflict', 'error', 'cancelled')),
  promotable INTEGER NOT NULL DEFAULT 0 CHECK (promotable IN (0, 1)),
  created_at INTEGER NOT NULL,
  materialized_at INTEGER,
  finished_at INTEGER,
  UNIQUE (session_id, plan_key),
  CHECK ((head_sha IS NULL AND tree_sha IS NULL AND manifest_digest IS NULL) OR
         (head_sha IS NOT NULL AND tree_sha IS NOT NULL AND manifest_digest IS NOT NULL))
);
CREATE INDEX candidate_session ON candidate(session_id, created_at);
CREATE TRIGGER candidate_commit_immutable
BEFORE UPDATE ON candidate
WHEN OLD.head_sha IS NOT NULL AND (
  NEW.head_sha IS NOT OLD.head_sha OR NEW.tree_sha IS NOT OLD.tree_sha OR
  NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.manifest_json IS NOT OLD.manifest_json OR
  NEW.plan_key IS NOT OLD.plan_key OR NEW.plan_json IS NOT OLD.plan_json OR
  NEW.baseline_sha IS NOT OLD.baseline_sha OR NEW.expected_main_sha IS NOT OLD.expected_main_sha OR
  NEW.repo_name IS NOT OLD.repo_name
)
BEGIN
  SELECT RAISE(ABORT, 'materialized candidate source and manifest are immutable');
END;
CREATE TRIGGER candidate_validation_immutable
BEFORE UPDATE ON candidate
WHEN OLD.validation_digest IS NOT NULL AND NEW.validation_digest IS NOT OLD.validation_digest
BEGIN
  SELECT RAISE(ABORT, 'candidate validation evidence is immutable');
END;

CREATE TABLE candidate_member (
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  revision_id TEXT NOT NULL REFERENCES proposal_revision(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (candidate_id, revision_id),
  UNIQUE (candidate_id, ordinal)
);

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'integrate', 'verify', 'promote', 'cleanup', 'seed')),
  entity_id TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  input_digest TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  attempt_no INTEGER NOT NULL DEFAULT 0,
  current_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  workflow_id TEXT,
  deadline_at INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  output_evidence_key TEXT,
  error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX job_schedulable ON job(status, lease_expires_at, created_at);
CREATE INDEX job_session ON job(session_id, kind, status);

CREATE TABLE job_attempt (
  job_id TEXT NOT NULL REFERENCES job(id),
  attempt_no INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  container_id TEXT,
  provider TEXT,
  model_id TEXT,
  checkpoint_key TEXT,
  checkpoint_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'expired')),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (job_id, attempt_no),
  UNIQUE (job_id, fence)
);

CREATE TABLE check_run (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  job_id TEXT NOT NULL REFERENCES job(id),
  check_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  harness_digest TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  applicable INTEGER NOT NULL CHECK (applicable IN (0, 1)),
  applicability_reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error', 'skipped')),
  assertion_count INTEGER NOT NULL DEFAULT 0 CHECK (assertion_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  evidence_key TEXT,
  evidence_digest TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (candidate_id, check_key, attempt_no),
  CHECK (status <> 'passed' OR (applicable = 1 AND assertion_count > 0 AND failed_count = 0)),
  CHECK (status <> 'skipped' OR applicable = 0),
  CHECK (failed_count <= assertion_count),
  CHECK (status <> 'failed' OR failed_count > 0),
  CHECK (status NOT IN ('passed', 'failed') OR (
    result_json IS NOT NULL AND evidence_key IS NOT NULL AND
    evidence_digest IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL
  ))
);
CREATE INDEX check_candidate ON check_run(candidate_id, status, check_key);

CREATE TABLE interaction (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  left_proposal_id TEXT NOT NULL REFERENCES proposal(id),
  right_proposal_id TEXT NOT NULL REFERENCES proposal(id),
  left_intent_digest TEXT NOT NULL,
  right_intent_digest TEXT NOT NULL,
  left_revision_id TEXT REFERENCES proposal_revision(id),
  right_revision_id TEXT REFERENCES proposal_revision(id),
  contract_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('assumption', 'shared_write', 'dependency', 'file_overlap')),
  state TEXT NOT NULL CHECK (state IN ('predicted', 'confirmed', 'resolved', 'unknown')),
  explanation TEXT NOT NULL,
  failed_candidate_id TEXT REFERENCES candidate(id),
  failed_check_id TEXT REFERENCES check_run(id),
  resolved_candidate_id TEXT REFERENCES candidate(id),
  resolution_check_id TEXT REFERENCES check_run(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX interaction_session ON interaction(session_id, state);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  head_sha TEXT NOT NULL,
  expected_main_sha TEXT NOT NULL,
  validation_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  harness_digest TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER approval_immutable
BEFORE UPDATE ON approval
BEGIN
  SELECT RAISE(ABORT, 'approval records are immutable');
END;

CREATE TABLE promotion (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES job(id),
  before_sha TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'stale', 'failed')),
  observed_remote_sha TEXT,
  receipt_key TEXT,
  receipt_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES session(id),
  event_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  created_at INTEGER NOT NULL
);
CREATE INDEX event_session_seq ON event(session_id, seq);
CREATE TRIGGER event_immutable
BEFORE UPDATE ON event
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  effect_key TEXT NOT NULL UNIQUE,
  job_id TEXT REFERENCES job(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE request_receipt (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE budget_entry (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  job_id TEXT REFERENCES job(id),
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('reserve', 'settle', 'release', 'uncertain', 'reconcile')),
  reserved_delta_microusd INTEGER NOT NULL DEFAULT 0,
  spent_delta_microusd INTEGER NOT NULL DEFAULT 0,
  uncertain_delta_microusd INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL
);
CREATE INDEX budget_session ON budget_entry(session_id, created_at);

CREATE TABLE managed_resource (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  job_id TEXT REFERENCES job(id),
  kind TEXT NOT NULL CHECK (kind IN ('artifact_repo', 'container', 'evidence_blob', 'preview')),
  external_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'cleanup_pending', 'deleted', 'error')),
  retain INTEGER NOT NULL DEFAULT 0 CHECK (retain IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, external_name)
);
CREATE INDEX managed_resource_cleanup ON managed_resource(state, retain, expires_at);

-- A materialized candidate cannot acquire different logical membership.
CREATE TRIGGER candidate_member_insert_frozen
BEFORE INSERT ON candidate_member
WHEN (SELECT head_sha FROM candidate WHERE id = NEW.candidate_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'materialized candidate membership is immutable');
END;
CREATE TRIGGER candidate_member_update_frozen
BEFORE UPDATE ON candidate_member
WHEN (SELECT head_sha FROM candidate WHERE id = OLD.candidate_id) IS NOT NULL
  OR (SELECT head_sha FROM candidate WHERE id = NEW.candidate_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'materialized candidate membership is immutable');
END;
CREATE TRIGGER candidate_member_delete_frozen
BEFORE DELETE ON candidate_member
WHEN (SELECT head_sha FROM candidate WHERE id = OLD.candidate_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'materialized candidate membership is immutable');
END;
CREATE TRIGGER completed_check_immutable
BEFORE UPDATE ON check_run
WHEN OLD.finished_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'completed check attempts are immutable');
END;

CREATE TRIGGER project_repo_identity_immutable
BEFORE UPDATE ON project
WHEN NEW.id IS NOT OLD.id OR NEW.canonical_repo IS NOT OLD.canonical_repo
  OR NEW.default_branch IS NOT OLD.default_branch
BEGIN
  SELECT RAISE(ABORT, 'a project keeps its canonical repository identity');
END;

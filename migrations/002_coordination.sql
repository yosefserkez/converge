-- Converge: coordination tables the initial schema references but does not define.
-- Evidence registry, intent history, targeted inbox, agent activity, previews, replays.

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  content_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  created_at INTEGER NOT NULL
);
CREATE INDEX evidence_session ON evidence(session_id, created_at);
CREATE TRIGGER evidence_immutable
BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence records are immutable');
END;

CREATE TABLE intent_version (
  proposal_id TEXT NOT NULL REFERENCES proposal(id),
  version INTEGER NOT NULL CHECK (version > 0),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  intent_digest TEXT NOT NULL,
  job_id TEXT REFERENCES job(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, version)
);
CREATE TRIGGER intent_version_immutable
BEFORE UPDATE ON intent_version
BEGIN
  SELECT RAISE(ABORT, 'intent versions are immutable');
END;

CREATE TABLE inbox_message (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id),
  proposal_id TEXT NOT NULL REFERENCES proposal(id),
  message_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_target ON inbox_message(proposal_id, seq);

-- Real start/end times of provider requests and tool executions; proves overlap.
CREATE TABLE agent_activity (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  job_id TEXT NOT NULL REFERENCES job(id),
  attempt_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'fixture')),
  label TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);
CREATE INDEX agent_activity_session ON agent_activity(session_id, started_at);

CREATE TABLE preview (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  head_sha TEXT NOT NULL,
  resource_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'expired', 'error')),
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX preview_candidate ON preview(candidate_id, created_at);

CREATE TABLE published_replay (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  original_mode TEXT NOT NULL CHECK (original_mode IN ('live', 'fixture')),
  recorded_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  snapshot_key TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL,
  published_by TEXT NOT NULL
);
CREATE TRIGGER published_replay_immutable
BEFORE UPDATE ON published_replay
BEGIN
  SELECT RAISE(ABORT, 'published replays are immutable');
END;

ALTER TABLE proposal ADD COLUMN repo_name TEXT;
ALTER TABLE proposal ADD COLUMN summary TEXT;
ALTER TABLE candidate ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE candidate ADD COLUMN anchor_candidate_id TEXT REFERENCES candidate(id);
ALTER TABLE candidate ADD COLUMN error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json));

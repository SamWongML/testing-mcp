-- P6 store — system of record + durable queue + stage-1 task state (research §16.1, §18).
-- Ids are `text` (not `uuid`): the IR types every id as a string; the store honors that.

CREATE TABLE manifests (
  hash        text PRIMARY KEY,
  git_sha     text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE catalog_entries (
  manifest_hash   text NOT NULL,
  id              text NOT NULL,
  kind            text NOT NULL,
  version         integer NOT NULL,
  tags            text[],
  owner           text,
  is_long_running boolean,
  PRIMARY KEY (manifest_hash, id)
);

-- Durable job queue (FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs (
  id               text PRIMARY KEY,
  run_id           text,
  spec             jsonb,
  priority         integer NOT NULL DEFAULT 0,
  status           text NOT NULL,
  worker_id        text,
  run_after        timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_run_after_idx ON jobs (status, run_after);

-- Run history (the record).
CREATE TABLE runs (
  id            text PRIMARY KEY,
  entry_id      text,
  manifest_hash text,
  git_sha       text,
  status        text,
  params        jsonb,
  env           text,
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   integer,
  artifact_s3   text,
  invoked_by    text
);

CREATE TABLE step_results (
  run_id    text NOT NULL,
  node_id   text NOT NULL,
  status    text,
  timing_ms integer,
  attempts  integer,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE assertion_results (
  run_id  text NOT NULL,
  node_id text NOT NULL,
  idx     integer NOT NULL,
  ok      boolean,
  message text,
  PRIMARY KEY (run_id, node_id, idx)
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz DEFAULT now(),
  principal text,
  action    text,
  entry_id  text,
  params    jsonb,
  scopes    text[]
);

-- Stage-1 hot task state collapsed into Postgres (§16.2 fields, §18 "dozens").
CREATE TABLE tasks (
  run_id           text PRIMARY KEY,
  state            text NOT NULL,
  progress_pct     integer,
  current_node     text,
  result_ref       text,
  error            text,
  cancel_requested boolean NOT NULL DEFAULT false,
  expires_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

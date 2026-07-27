-- Resumable run execution: per-node checkpoints, bounded job attempts with backoff and a
-- dead-letter state, and run-level attempt provenance.
--
-- Additive/expand-only (docs/deploy.md's migration policy): every new column is nullable or
-- carries a DEFAULT, so backfill is instant and the previous image keeps working against this
-- schema. Applied by the one-off MODE=migrate task, never at service boot.

-- Per-node execution checkpoints. Operational state — it mirrors `tasks`, not `runs` /
-- `step_results`: written as each DAG node settles so a crashed worker's replacement resumes
-- from the frontier instead of re-executing (and re-firing) what already ran, then pruned on
-- every terminal write. `payload` is a redacted StepResult; it passed the engine's redact()
-- before this table ever sees it.
CREATE TABLE run_checkpoints (
  run_id     text NOT NULL,
  node_id    text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id)
);
-- Bulk delete-by-run on the terminal write, and the TTL backstop's age scan.
CREATE INDEX run_checkpoints_created_at_idx ON run_checkpoints (created_at);

-- Bounded attempts, so a job that deterministically kills its worker reaches a terminal,
-- reportable state instead of reap-requeuing forever. `jobs.status` has no CHECK constraint
-- (see 0000_init.sql), so the new 'dead_letter' value needs no DDL.
ALTER TABLE jobs ADD COLUMN attempts         integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN max_attempts     integer NOT NULL DEFAULT 5;
ALTER TABLE jobs ADD COLUMN last_error       text;
-- Set once on the first claim and preserved across every reap — the source of a resumed
-- run's `firstStartedAt`.
ALTER TABLE jobs ADD COLUMN first_claimed_at timestamptz;

-- Run-level provenance: 1 for every existing row and every single-attempt run, so a normal
-- run's history is indistinguishable from before.
ALTER TABLE runs ADD COLUMN attempt          integer NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN first_started_at timestamptz;

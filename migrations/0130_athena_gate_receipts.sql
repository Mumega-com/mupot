-- 0130_athena_gate_receipts.sql — immutable Athena PR gate audit log.
--
-- One row per reviewed (repo, PR, head SHA). GitHub webhook retries for the
-- same head do not mint a second receipt. Schema only — a migration INSERT
-- would survive the chain and break the applyAllMigrations DDL cache
-- (helpers-migrations.test.ts).

CREATE TABLE IF NOT EXISTS athena_gate_receipts (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL
              CHECK (length(trim(repo)) BETWEEN 1 AND 200),
  pr_number   INTEGER NOT NULL
              CHECK (pr_number > 0),
  commit_sha  TEXT NOT NULL
              CHECK (length(trim(commit_sha)) BETWEEN 7 AND 64),
  verdict     TEXT NOT NULL
              CHECK (verdict IN ('APPROVED', 'BLOCKED', 'CHANGES_REQUESTED')),
  checks_json TEXT NOT NULL
              CHECK (length(trim(checks_json)) > 0),
  summary     TEXT NOT NULL
              CHECK (length(trim(summary)) > 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo, pr_number, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_athena_gate_receipts_created
  ON athena_gate_receipts(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_athena_gate_receipts_repo_pr
  ON athena_gate_receipts(repo, pr_number, created_at DESC);

CREATE TRIGGER athena_gate_receipts_immutable_update
BEFORE UPDATE ON athena_gate_receipts
BEGIN
  SELECT RAISE(ABORT, 'athena_gate_receipts immutable');
END;

CREATE TRIGGER athena_gate_receipts_immutable_delete
BEFORE DELETE ON athena_gate_receipts
BEGIN
  SELECT RAISE(ABORT, 'athena_gate_receipts immutable');
END;

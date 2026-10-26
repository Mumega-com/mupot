-- 0259_backup_runs.sql -- one row per nightly D1 backup run (src/backup/nightly.ts). Additive: a new table, nothing else.
-- Migration numbers 0256-0258 are held by open PRs (#2184, #2189, #2193); 0259 is the next free number.
--
-- status:
--   running                 the run started and has not finished (a row stuck here > 2h is marked failed by the next run)
--   ok                      dump stored, verified (size > 0 and sha256 equals the manifest), retention applied
--   failed                  export / store / verify failed; an alert was attempted (alerted records whether it was delivered)
--   skipped:no_credential   BACKUP_CF_API_TOKEN / BACKUP_ACCOUNT_ID / BACKUP_D1_ID / BACKUPS binding missing; alerted
-- The row is the audit record. The dump itself lives in R2 (key d1/mupot/YYYY-MM-DD.sql.gz) and is NOT referenced for restore
-- by this table: restore works from R2 alone, because this table lives in the database being backed up.
CREATE TABLE IF NOT EXISTS backup_runs (
  id            TEXT PRIMARY KEY,
  run_date      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped:no_credential')),
  r2_key        TEXT,
  sha256        TEXT,
  size_bytes    INTEGER,
  bookmark      TEXT,
  error         TEXT,
  alerted       INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_date ON backup_runs (run_date DESC);

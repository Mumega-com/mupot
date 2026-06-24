-- mupot — event-fed GitHub merged-PR signal table (S4b: pluggable KPI sources).
--
-- WHY THIS TABLE EXISTS:
-- The sane-brain goal loop needs a real domain signal for KPI progress. For the
-- dev-pot (mumega#0), the real output unit is a merged PR. Rather than polling
-- the GitHub API from the loop (polling = external cred in the hot path; latency;
-- rate-limit risk), we adopt the event-fed pattern: the EXISTING GitHub webhook
-- handler (src/integrations/github-routes.ts) already receives pull_request events.
-- On closed+merged, it now additionally writes a row here.
--
-- The KPI source (src/agents/kpi-sources.ts, 'github_prs') reads from this table:
--   merged_count_in_window / agent.kpi_target → kpi_progress (no new secret; sovereign)
--
-- ISOLATION: tenant_id on every row. Single-tenant pot = single tenant_id, but the
-- column is kept for query-plan parity with other event tables (cro_events, etc.).
--
-- IDEMPOTENCY: (repo, pr_number) is unique per tenant — a webhook redelivery of the
-- same PR close+merged is a no-op (INSERT OR IGNORE).
--
-- WINDOW: merged_at is epoch-ms (same as cro_events) — fast range-scan for the
-- trailing-window query the KPI source runs.

CREATE TABLE IF NOT EXISTS github_prs_merged (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL,
  repo        TEXT    NOT NULL,   -- "owner/repo" (safeField-sanitized before insert)
  pr_number   INTEGER NOT NULL,
  title       TEXT,               -- safeField-sanitized; nullable
  merged_at   INTEGER NOT NULL,   -- epoch-ms the merge was observed (webhook delivery time)
  created_at  INTEGER NOT NULL    -- epoch-ms this row was written
);

-- IDEMPOTENCY: one row per PR per repo per tenant. Redeliveries are silent no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_prs_merged_dedup
  ON github_prs_merged (tenant_id, repo, pr_number);

-- Time-series scan: the KPI source runs a trailing-window COUNT on merged_at.
CREATE INDEX IF NOT EXISTS idx_github_prs_merged_window
  ON github_prs_merged (tenant_id, merged_at);

-- 0179_office_publish_freezes.sql — mupot#1588 round 1 (Athena P0-1 / kasra-review
-- P0-1, P1-1): a human approval on a gate:office task must authorize EXACTLY ONE
-- WordPress write with EXACTLY the content the human saw — not "some publish, any
-- payload, any number of times".
--
-- NEW TABLE ONLY. No ALTER of `tasks` or any addon parent table, and no touch to
-- either's CHECK constraints — `tasks` has RESTRICT children (task_verdicts,
-- routine_run_actions, ...) and D1 applies one migration file inside one
-- transaction, so a table rebuild (the only way to add a new tasks.status enum
-- value or a new tasks column with a CHECK) is exactly the trap 0175's header
-- already documents. A brand-new child table with a plain, un-checked FK to
-- tasks(id) carries none of that risk.
--
-- One row per task. office.review_approval (src/addons/office/service.ts) writes
-- this row — via INSERT OR REPLACE, so a rework loop (rejected -> in_progress ->
-- review -> approved again) always refreezes against the CURRENT task.title/body
-- and the CURRENTLY active installation/connector/site, never a stale round's
-- payload — in the SAME call that approves the task, before writeVerdict. office.
-- publish_post then:
--   1. reads ONLY this row's payload_json for the WordPress title/content (never
--      caller args — office.publish_post's MCP schema no longer accepts title/
--      content at all, see src/mcp/office.ts),
--   2. re-resolves the CURRENT active installation/connector/site and refuses
--      (`binding_changed`) if any differs from what is frozen here,
--   3. atomically claims this row (`claimed_at IS NULL` -> claimed_at) BEFORE any
--      credential read or fetch — the one-shot guard: a concurrent second
--      publish_post call, or a retry after a timeout, gets 0 rows and is refused
--      (`publish_claimed`) with NO fetch, closing P1-1 and P3-3 (timeout-then-
--      retry double-post) the same way. A claimed row is NEVER un-claimed by this
--      addon — a failed or timed-out publish requires a fresh human approval
--      (reject + re-approve, which INSERT OR REPLACEs a brand-new, unclaimed row),
--      not an automatic retry.
CREATE TABLE IF NOT EXISTS office_publish_freezes (
  task_id           TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id),
  -- Canonical JSON (src/lib/canonical-json.ts's canonicalJson — sorted keys, no
  -- ambiguity) of { task_id, title, content, installation_id, connector_id,
  -- site_origin } as they stood at the moment of approval.
  payload_json      TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  installation_id   TEXT NOT NULL,
  connector_id      TEXT NOT NULL,
  site_origin       TEXT NOT NULL,
  frozen_by         TEXT NOT NULL, -- the approving member's principal id
  frozen_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- One-shot execution claim (P1-1). NULL = unclaimed = publishable exactly once.
  claimed_by        TEXT,
  claimed_at        TEXT,
  outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('done', 'failed')),
  outcome_detail    TEXT,
  completed_at      TEXT
);

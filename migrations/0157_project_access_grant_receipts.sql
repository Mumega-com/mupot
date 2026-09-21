-- 0157_project_access_grant_receipts.sql — FP-01 Slice 2 (mupot#1443, brief
-- `agents/kasra/briefs/flight-first-person-mubot-meets-shadi-20260920.md`
-- §2 Task A, §2f). NOT applied by this build — branch/schema only, exactly
-- like migrations 0143/0144/0147/0148 before it; a human applies it.
--
-- WHY THIS TABLE EXISTS
--
-- The proof rule this flight is built around is a CHAIN: proposal_id ->
-- verdict_id -> grant receipt id, each link explicit and queryable, never
-- inferred from "it happened after." Without a dedicated row, the only trace
-- of a project_access grant is the project_squad_access UPSERT itself
-- (src/projects/service.ts's upsertProjectSquadAccess), which has NO column
-- for who decided it or which proposal asked for it — and it is an upsert:
-- a later legitimate change to the SAME (project, squad) pair overwrites the
-- access_level in place, so the original grant's provenance would be lost
-- the moment anything else touched that edge. This table is the append-only
-- side-record that survives that overwrite.
--
-- WHY A NEW TABLE, NOT AN EXISTING RECEIPT LEDGER
--
-- Three existing ledgers were considered and rejected (same audit already
-- done for createHomeForMember's 'repaired' disposition, mupot#1472):
--   * migrations/0148 elevation_grants/elevation_usage_log — scoped to
--     time-boxed action:* elevation, not a standing project_squad_access row.
--   * door_receipts / membership_receipts (0107-adjacent) — scoped to the
--     onboarding-door self-service consent flow, a DIFFERENT authority path
--     (G-FP1b's "single write path for project access" ruling: the door is
--     explicitly NOT this flow).
--   * gate_owner_reassignments (0113) — scoped to re-gating an existing
--     review task, not to a grant's downstream effect.
-- None fit without widening what they mean. A fourth, purpose-built table is
-- narrower than stretching an existing one to cover a shape it was not
-- designed for.
--
-- SHAPE follows the append-only receipt idiom already established by
-- task_verdicts (0007) and gate_owner_reassignments (0113):
--   * TEXT id (UUID), no AUTOINCREMENT surrogate — the id is the external
--     handle callers reference (the "grant receipt id" in the chain).
--   * NO foreign keys to tasks/routine_run_actions/task_verdicts — 0086/0113
--     learned this the hard way: a CASCADE erases the receipt exactly when a
--     retired task/routine is cleaned up, which is precisely when the audit
--     trail is most needed. Orphan rows are the acceptable price.
--   * append-only, enforced by trigger, not convention.
--
-- proposal_id names the routine_run_actions.id that carried the
-- project_access action; verdict_id names the task_verdicts.id that
-- authorized it (decided_by/decided_via copied at write time so the receipt
-- reads standalone without a join, the same "frozen copy at grant time"
-- reasoning 0148's elevation_grants.effect column documents).

CREATE TABLE IF NOT EXISTS project_access_grant_receipts (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  squad_id     TEXT NOT NULL,                 -- the member's HOME squad that received the grant
  member_id    TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write', 'admin')),
  proposal_id  TEXT NOT NULL,                 -- routine_run_actions.id (the project_access proposal)
  verdict_id   TEXT NOT NULL,                 -- task_verdicts.id that authorized this grant
  decided_by   TEXT NOT NULL,                 -- task_verdicts.decided_by, copied at write time
  decided_via  TEXT,                          -- task_verdicts.decided_via, copied at write time
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (proposal_id)                        -- one grant receipt per proposal — idempotent on retry
);

CREATE INDEX IF NOT EXISTS idx_project_access_grant_receipts_verdict
  ON project_access_grant_receipts(verdict_id);
CREATE INDEX IF NOT EXISTS idx_project_access_grant_receipts_member
  ON project_access_grant_receipts(member_id);

CREATE TRIGGER IF NOT EXISTS project_access_grant_receipts_no_update
  BEFORE UPDATE ON project_access_grant_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_access_grant_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS project_access_grant_receipts_no_delete
  BEFORE DELETE ON project_access_grant_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_access_grant_receipts is append-only');
END;

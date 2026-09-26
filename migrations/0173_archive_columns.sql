-- 0173_archive_columns.sql — receipted archive substrate (mupot#1496 "data
-- hygiene: audit, mark, archive"). NOT applied by this build — branch/schema
-- only, exactly like 0143/.../0166 through 0172 before it; a human applies it
-- (MIGRATE FIRST, before deploying the code in this same PR — the archive_row/
-- unarchive_row tools and the CLI both assume these columns/tables exist).
--
-- Ask (issue #1496 + Hadi's 2026-09-26 go on the audit's Set 1): "mark-and-
-- archive, never delete: status='archived' + archived_reason, receipts kept."
-- Hadi's own follow-up comment on the issue found the gap this migration
-- closes: members.status CHECK has no 'archived' value, squads has no status
-- column at all, and none of the four tables (members/agents/squads/projects)
-- has archived_at/archived_reason — "a bare UPDATE with no reason is exactly
-- the debris-making habit this issue is about."
--
-- ============================================================================
-- WHY members.status IS NOT WIDENED (STOP-and-report, per brief)
-- ============================================================================
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT — the only way to widen a CHECK
-- is the row-preserving rebuild this repo already uses (0020, 0042, 0049,
-- 0158): CREATE members_new with the widened CHECK, copy every row, DROP
-- members, RENAME members_new -> members.
--
-- members is referenced by FAR more tables than any prior rebuild in this
-- repo has had to handle (agents, the previous largest case in 0049, had 2
-- referencing tables). Ground truth below was pulled by actually applying the
-- full migration chain to a real (node:sqlite) database and reading
-- `PRAGMA foreign_key_list` / `sqlite_master` back — not by hand-tracing ALTERs
-- across 172 files (scratchpad script:
-- /tmp/.../scratchpad/introspect-members.mjs, this session).
--
-- FK REFERENCES TO members(id), by ON DELETE action (29 columns, 24 tables):
--   CASCADE (rows are DELETED by SQLite as a side effect of dropping members,
--   verified empirically — DROP TABLE with FK enforcement effectively ON
--   mid-transaction, same finding 0049 already documented for `agents`):
--     capabilities.member_id, member_identities.member_id,
--     channel_link_codes.member_id, channel_capability_grants.member_id,
--     member_tokens.member_id, human_login_identities.member_id,
--     web_sessions.member_id, agent_sessions.member_id,
--     elevation_requests.member_id
--   SET NULL (columns are nulled by the same DROP-time side effect):
--     tasks.assignee_member_id, human_login_identities.linked_by_member_id
--   RESTRICT / (implicit) NO ACTION — a row referencing members BLOCKS the
--   DROP outright (verified empirically: `DROP TABLE members` throws
--   "FOREIGN KEY constraint failed" the instant any such row exists):
--     invites.minted_by_member_id, invites.member_id, agents.owner_member_id,
--     agent_inbox_fences.updated_by_member_id, agent_member_bindings.member_id,
--     oauth_consent_receipts.consenting_member_id,
--     token_binding_attestations.member_id, seat_attestations.member_id,
--     mutation_audit_entries.member_id, runtime_brokers.member_id,
--     fenced_deliveries.source_member_id,
--     agent_token_rotation_handoffs.{member_id,minted_by_member_id},
--     elevation_requests.decided_by_member_id,
--     elevation_grants.approved_by_member_id,
--     telegram_unbind_receipts.member_id,
--     telegram_origin_bind_receipts.member_id,
--     task_dispatch_runtime_receipts.member_id
--
-- The RESTRICT list is the blocker. Every one of those tables would need its
-- rows backed up, DELETEd (to clear the block), and re-INSERTed after the
-- rebuild — the exact 0049 dance, just 12+ tables instead of 1. But 9 of them
-- are IMMUTABLE-BY-DESIGN audit/receipt ledgers with their own `_no_delete`
-- triggers (verified against the real schema, same introspection run):
-- oauth_consent_receipts, token_binding_attestations, seat_attestations,
-- mutation_audit_entries, runtime_brokers, fenced_deliveries,
-- agent_token_rotation_handoffs (partial), telegram_unbind_receipts,
-- telegram_origin_bind_receipts, task_dispatch_runtime_receipts — plus
-- agent_member_bindings' `_no_update` + conditional `_delete_requires_no_tokens`
-- guard. Some of these tables (runtime_brokers: 4 triggers including a
-- lifecycle/key-separation state machine; fenced_deliveries: 7 triggers
-- including a multi-condition state-transition guard) are non-trivial to
-- drop-and-recreate byte-for-byte inside one migration file. Getting even one
-- trigger's WHEN clause or column list subtly wrong on rebuild is exactly the
-- "half-rebuild" this brief says not to ship, and there is no way to prove it
-- byte-for-byte-correct except by literally diffing 20+ trigger bodies by
-- hand — the amount of undetectable-until-it-matters risk this brief's STOP
-- clause exists for.
--
-- Also tested and rejected: renaming members out of the way first
-- (`PRAGMA legacy_alter_table=ON; ALTER TABLE members RENAME TO members_old`)
-- to dodge the DROP-time FK side effects entirely, hoping the rename would
-- leave children's FK text pointing at the old name (untouched) so recreating
-- a fresh `members` would silently re-bind them with zero children ever
-- touched. Verified empirically this does NOT work against the SQLite version
-- this repo's tooling uses: the rename rewrites children's FK text to
-- `members_old` regardless of `legacy_alter_table`, so the DROP TABLE
-- members_old step at the end hits the identical RESTRICT wall.
--
-- DECISION: do not widen members.status. Member archival is instead an
-- ORTHOGONAL signal — archived_at IS NOT NULL — completely independent of
-- status (which keeps meaning what it already means: active/suspended). This
-- needs no rebuild at all: archived_at/archived_reason/archived_by_member_id
-- are plain nullable ADD COLUMNs, which never touch a CHECK constraint and
-- therefore never trigger the DROP-TABLE FK problem above. Same reasoning
-- extends the "receipted, reversible, no delete" ask in full; it just answers
-- "is this member archived" with a timestamp instead of an enum value.
--
-- ============================================================================
-- WHY tasks GETS A SIDE TABLE, NOT A STATUS-ENUM WIDENING (STOP-and-report)
-- ============================================================================
-- Same SQLite limitation, worse blast radius: tasks has 12 triggers defined
-- directly ON it (flights_enter_waiting_on_task_status,
-- flights_leave_waiting_on_task_status, the provenance/parent/single-assignee/
-- project-lock guards from 0107/0150/0154/0156/0158/0172) that would all need
-- byte-for-byte recreation, PLUS 10 other tables hold an FK to tasks(id) — 8
-- of them RESTRICT (marketing_recommendations, routine_runs, flight_lanes,
-- flight_task_assignments, artifacts, flight_dependency_artifacts,
-- fenced_deliveries, task_dispatch_runtime_receipts) — at production scale
-- (2,176 rows per the audit snapshot). This is a strictly larger version of
-- the members problem above.
--
-- DECISION: tasks.status is NEVER touched by archiving. A side table,
-- `tasks_archive_state`, carries archived_at/archived_reason/
-- archived_by_member_id/prior_status keyed by task_id. `prior_status` is a
-- descriptive snapshot only (what the task's status was at archive time, for
-- audit/dashboard display) — nothing is ever written back to tasks.status on
-- unarchive because nothing was ever changed on it. This needs zero changes
-- to the tasks table itself: zero risk to its trigger web or its 8 RESTRICT
-- referrers.
--
-- ============================================================================
-- WHAT IS SAFE AND DOES CHANGE HERE
-- ============================================================================
-- squads has NO status column at all today — adding one fresh (default
-- 'active', CHECK IN ('active','archived')) is a plain ADD COLUMN, verified
-- empirically to work on a populated table (SQLite backfills the DEFAULT for
-- every existing row before evaluating the CHECK). agents.status and
-- projects.status are UNCHANGED (agents' enum already has a hygiene-equivalent
-- value, 'inactive'; projects' CHECK already includes 'archived' — see
-- migrations/0002_members.sql / the original agents/projects table
-- definitions). archived_at/archived_reason/archived_by_member_id are added,
-- as plain nullable columns, to members/agents/squads/projects — the
-- `archived_by_member_id TEXT REFERENCES members(id)` shape on a populated
-- table already has a proven precedent in this exact repo:
-- migrations/0155_agent_owner_member_and_origin_verdict.sql's
-- `ALTER TABLE agents ADD COLUMN owner_member_id TEXT REFERENCES members(id);`
--
-- projects additionally gets `archived_prior_status` (nullable) — projects.
-- status has SIX legal values (planned/active/paused/review/completed/
-- archived), so unlike squads (whose only non-archived value is 'active'),
-- unarchive_row needs to know what to restore TO. Captured at archive time,
-- cleared on unarchive.
--
-- archive_receipts is a new, generic, append-only ledger for archive_row /
-- unarchive_row (no single shared "admin action receipts" table exists in
-- this repo — src/org/service.ts's own comments list three different
-- domain-specific ledgers, membership_receipts/door_receipts/elevation_grants,
-- as the precedent for "every admin feature gets its own receipts table";
-- team_bootstrap_receipts (0166) is the most recent instance of that
-- convention). Immutable via `_no_update`/`_no_delete` triggers, matching
-- every other receipts table in this repo (membership_receipts,
-- telegram_unbind_receipts, telegram_origin_bind_receipts, etc.).

-- ── members: orthogonal archive signal (status untouched) ─────────────────────
ALTER TABLE members ADD COLUMN archived_at TEXT;
ALTER TABLE members ADD COLUMN archived_reason TEXT;
ALTER TABLE members ADD COLUMN archived_by_member_id TEXT REFERENCES members(id);

-- ── agents: orthogonal archive signal (status untouched — 'inactive' already
--    covers deactivation; archiving is a separate, later hygiene step) ────────
ALTER TABLE agents ADD COLUMN archived_at TEXT;
ALTER TABLE agents ADD COLUMN archived_reason TEXT;
ALTER TABLE agents ADD COLUMN archived_by_member_id TEXT REFERENCES members(id);

-- ── squads: brand-new status column (never existed before — no rebuild needed,
--    no prior non-'active' value is possible) ─────────────────────────────────
ALTER TABLE squads ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'));
ALTER TABLE squads ADD COLUMN archived_at TEXT;
ALTER TABLE squads ADD COLUMN archived_reason TEXT;
ALTER TABLE squads ADD COLUMN archived_by_member_id TEXT REFERENCES members(id);

-- ── projects: status CHECK already includes 'archived' — archive_row reuses
--    that existing value instead of widening anything. archived_prior_status
--    captures what to restore on unarchive (status has 6 legal values). ──────
ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN archived_reason TEXT;
ALTER TABLE projects ADD COLUMN archived_by_member_id TEXT REFERENCES members(id);
ALTER TABLE projects ADD COLUMN archived_prior_status TEXT;

-- ── tasks: side table, tasks.status untouched (see header) ─────────────────────
CREATE TABLE tasks_archive_state (
  task_id               TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  archived_at           TEXT NOT NULL CHECK (length(trim(archived_at)) > 0),
  archived_reason       TEXT NOT NULL CHECK (length(trim(archived_reason)) BETWEEN 1 AND 2000),
  archived_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  prior_status          TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── archive_receipts: generic, immutable, one row per archive_row/unarchive_row
--    call. entity_table is a closed enum (the five archivable tables); adding a
--    sixth table later means widening this CHECK, which is a plain ADD-COLUMN-
--    free rebuild only if this table ever grows FK referrers of its own — it
--    has none today, so a future widening is cheap. ────────────────────────────
CREATE TABLE archive_receipts (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  entity_table      TEXT NOT NULL CHECK (entity_table IN ('members','agents','squads','projects','tasks')),
  entity_id         TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('archive','unarchive')),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  actor_member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  prior_status      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_archive_receipts_entity ON archive_receipts(entity_table, entity_id, created_at);
CREATE INDEX idx_archive_receipts_tenant_cursor ON archive_receipts(tenant, created_at);

CREATE TRIGGER archive_receipts_no_update
BEFORE UPDATE ON archive_receipts
BEGIN
  SELECT RAISE(ABORT, 'archive_receipts immutable (no update)');
END;

CREATE TRIGGER archive_receipts_no_delete
BEFORE DELETE ON archive_receipts
BEGIN
  SELECT RAISE(ABORT, 'archive_receipts immutable (no delete)');
END;

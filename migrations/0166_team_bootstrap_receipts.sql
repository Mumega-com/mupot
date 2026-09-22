-- 0166_team_bootstrap_receipts.sql — mupot#1498 (team_bootstrap: one call
-- creates project-prj + squad-sqd + project bot + token claim + Hermes
-- profile scaffold). NOT applied by this build — branch/schema only, exactly
-- like 0143/0144/0147/0148/0157 through 0165 before it; a human applies it.
-- (Renumbered from 0163 — 0163/0164/0165 are owned by PRs #1501/#1507/#1509.)
--
-- WHY THIS TABLE EXISTS
--
-- team_bootstrap is a COMPOSITE act (project find-or-create, squad
-- find-or-create, an ADMIN project<->squad edge, an optional bot agent,
-- optional plain-squad human invites, an optional project_remember seed) run
-- from ONE call by an org-admin (or an org-admin-equivalent principal). None
-- of the rows it touches (projects, squads, project_squad_access, agents,
-- invites) carry a column naming "this state exists because of a
-- team_bootstrap call, run by this actor, for this slug_base" — and every one
-- of them can be independently re-touched afterward (a squad renamed, an
-- edge access_level changed, an agent's profile edited), which would erase
-- any inference drawn from "these rows look related." A dedicated,
-- append-only receipt is the only way to keep that provenance queryable
-- after the fact.
--
-- WHY A NEW TABLE, NOT AN EXISTING RECEIPT LEDGER
--
-- Same audit already done for createHomeForMember's disposition (0161) and
-- project_access_grant_receipts (0157) — three existing ledgers considered
-- and rejected for the same reason each of those headers gives: none fit
-- this shape without stretching what they mean.
--   * project_access_grant_receipts (0157/0160) — scoped to a proposal ->
--     verdict -> grant chain for a MEMBER'S HOME squad receiving project
--     access. team_bootstrap creates a NEW work squad and a NEW project, not
--     a grant onto an existing home; there is no proposal_id/verdict_id to
--     fill in, and cramming a project-creation event into a table whose
--     every row currently means "a home squad was granted access to an
--     existing project" would misrepresent both what happened and what the
--     existing rows mean.
--   * member_home_provisioning_receipts (0161) — scoped to a MEMBER's own
--     home squad, created on first IM contact. team_bootstrap's squad is a
--     WORK squad (kind='work'), never a home, and the actor is an org-admin
--     acting FOR a team, not a member acting for themselves.
--   * membership_receipts (0115) — target_agent_id NOT NULL, scoped to
--     squad_member_add/remove on an agent already in some squad; does not
--     fit "a project, a squad, and a brand-new agent were created together."
-- A fifth, purpose-built table is narrower than stretching any of these.
--
-- ONE ROW PER ATTEMPT, NOT PER TEAM (kasra-review adversarial round-1 gate on
-- PR #1510, P1-3, 2026-09-22). An earlier version of this migration kept
-- exactly one row per (tenant, slug_base), continuously UPDATEd across
-- retries — and every update-in-place path turned out falsifiable: a squad
-- renamed out from under a slug_base leaves the "pinned" squad_id pointing
-- at a squad that no longer represents that team (the pin then either wedges
-- every future write, or the trigger silently permits drift); a bot created
-- on attempt 2 could be recorded as if it existed on attempt 1;
-- `invited_count` accumulated onto ONE row regardless of which admin
-- actually placed which invites, misattributing a second admin's invites to
-- the first admin's `actor_member_id`. Every one of these is a symptom of
-- the same mistake: treating a MUTABLE "current state of this team" row as
-- if it were a historical log. It is not — this table now matches every
-- OTHER receipt table's actual append-only-COLUMN idiom (0086/0115/0157/
-- 0161): one INSERT per team_bootstrap call, NEVER an UPDATE. `attempt_no`
-- (1, 2, 3, ... per (tenant, slug_base)) orders a team's attempts without
-- needing a mutable "latest" row; `invited_count` on any one row is what
-- THAT call itself inserted, not a running total (sum across
-- `WHERE tenant=? AND slug_base=?` for the team's lifetime total, if ever
-- needed operationally). Resumability (an orphan project+squad+bot pair
-- surviving a failed attempt, adopted by the next attempt) is now a property
-- of team_bootstrap's OWN find-or-create reads against the real resource
-- tables (projects/squads/agents/invites) — never of this receipt table,
-- which merely records what each attempt observed and did.
--
-- SHAPE follows the SAME append-only receipt idiom as 0086/0115/0157/0161:
--   * TEXT id (UUID), no AUTOINCREMENT surrogate — one per ATTEMPT.
--   * actor_member_id is a frozen copy of who made THIS attempt — never
--     overwritten by a later attempt from a different admin, because there
--     is no later write to this row at all.
--   * NO foreign keys to projects/squads/agents/members — 0086/0113 learned
--     this the hard way: a CASCADE erases the receipt exactly when the
--     resource it documents is retired, which is precisely when the audit
--     trail is most needed. Orphan rows are the acceptable price (same
--     reasoning as 0157's header).
--   * bot_agent_id is NULL when this attempt declined to create a bot
--     (`bot.enabled === false`) or never reached the bot step (a
--     stage-1-or-earlier failure) — never fabricates an agent id that does
--     not exist AT THE TIME of this attempt.
--   * disposition: `'created'` (this attempt did something new),
--     `'existing'` (a pure no-op replay — every row it names was already
--     there), `'adopted'` (Athena, round-2 sharpening on PR #1510,
--     2026-09-22 — "find-or-create is create + explicit adopt": the
--     `adopt: true` override claimed a pre-existing, NON-EMPTY squad that no
--     prior team_bootstrap attempt had named — an org-admin's AUDITED
--     decision, not an ordinary idempotent replay, so it gets its own
--     disposition rather than folding into 'existing' where it would read
--     as unremarkable), or `'failed'` (the write phase did not finish this
--     attempt; `project_id`/`squad_id` are still real, already-committed
--     rows — only the composite outcome of THIS attempt is incomplete).
--     `failed_step` names where it stopped (`'edge_or_bot'` |
--     `'invite_insert'`); `failure_reason` is a short, STRUCTURAL
--     classification (`'unique_violation'` | `'write_failed'` |
--     `'archived_project'`) — deliberately NOT the raw driver error text
--     and NEVER an email address or other human PII, so this table stays
--     safe to page through operationally without becoming a second place
--     secrets/PII could leak from.
--   * append-only, enforced by trigger, not convention — no exceptions this
--     time, unlike the prior version of this migration.

CREATE TABLE IF NOT EXISTS team_bootstrap_receipts (
  id                TEXT NOT NULL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  actor_member_id   TEXT NOT NULL,          -- frozen copy of who made THIS attempt
  slug_base         TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,       -- 1, 2, 3... per (tenant, slug_base)
  project_id        TEXT NOT NULL,
  squad_id          TEXT NOT NULL,
  bot_agent_id      TEXT,                    -- NULL when no bot exists as of THIS attempt
  disposition       TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'adopted', 'failed')),
  failed_step       TEXT CHECK (failed_step IS NULL OR failed_step IN ('edge_or_bot', 'invite_insert')),
  failure_reason    TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('unique_violation', 'write_failed', 'archived_project')),
  invited_count     INTEGER NOT NULL DEFAULT 0,  -- invites inserted BY THIS ATTEMPT ONLY
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant, slug_base, attempt_no),
  CHECK ((disposition = 'failed') = (failed_step IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_slug_base
  ON team_bootstrap_receipts(tenant, slug_base, attempt_no DESC);
CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_project
  ON team_bootstrap_receipts(project_id);
CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_squad
  ON team_bootstrap_receipts(squad_id);

CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_no_update
  BEFORE UPDATE ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts is append-only — one row per attempt, never updated');
END;

CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_no_delete
  BEFORE DELETE ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts is append-only (rows are never deleted)');
END;

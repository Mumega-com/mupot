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
-- SHAPE follows the SAME append-only-ROWS receipt idiom as 0086/0115/0157/
-- 0161 (a row, once written, is never DELETEd) — but is DELIBERATELY NOT
-- append-only on every COLUMN, unlike those tables. See "FAILED ATTEMPTS
-- ARE RECEIPTED, AND RESUMABLE" below for why.
--   * TEXT id (UUID), no AUTOINCREMENT surrogate.
--   * NO foreign keys to projects/squads/agents/members — 0086/0113 learned
--     this the hard way: a CASCADE erases the receipt exactly when the
--     resource it documents is retired, which is precisely when the audit
--     trail is most needed. Orphan rows are the acceptable price (same
--     reasoning as 0157's header).
--   * bot_agent_id is NULL when the call declined to create a bot
--     (`bot.enabled === false`), or when no bot has been successfully
--     created YET (a 'failed' row whose failure happened before the bot
--     step ran) — disposition never fabricates an agent id that does not
--     exist.
--
-- FAILED ATTEMPTS ARE RECEIPTED, AND RESUMABLE (Athena round-1 gate on PR
-- #1510, 2026-09-22). team_bootstrap's write phase after project/squad
-- resolution is NOT one all-or-nothing unit — see src/org/team-bootstrap.ts's
-- file header: the ADMIN-edge+bot batch is atomic, but the per-human invite
-- inserts run ONE AT A TIME so a failure partway (an injected/transient D1
-- error on invite N of M) does not erase invites 1..N-1 that already landed.
-- The natural consequence: a team_bootstrap call can end in a state that is
-- neither "nothing happened" nor "everything happened" — a REAL, already-
-- committed project+squad (+bot, +some invites) with the composite call
-- itself unfinished. That state must be BOTH recorded (an operator watching
-- this table should see the failed attempt, not silence) AND resumable (a
-- retry with the same slug_base must adopt the existing project/squad/bot
-- and finish only what is left) — an orphan pair is a DESIGNED, expected
-- resting state, not corruption to clean up by hand.
--
-- disposition therefore has THREE values: 'created' (this call did
-- something new), 'existing' (a pure no-op replay — every row it names was
-- already there), or 'failed' (the write phase did not finish; project_id/
-- squad_id are still real, already-committed rows — only the FULL composite
-- outcome is incomplete). failed_step names WHERE it stopped
-- ('edge_or_bot' | 'invite_insert'); failure_reason is a short, STRUCTURAL
-- classification ('unique_violation' | 'write_failed') — deliberately NOT
-- the raw driver error text and NEVER an email address or other human PII,
-- so this table stays safe to page through operationally without becoming a
-- second place secrets/PII could leak from.
--
-- RESUMABILITY is why this table breaks from the append-only-COLUMN idiom
-- its siblings use: a retry for the SAME (tenant, slug_base) must UPDATE the
-- SAME row (never insert a second one — the UNIQUE constraint below is the
-- idempotency key both the service layer and this schema rely on), because
-- the row IS the current state of that team's bootstrap attempts, not a
-- historical log entry. What is genuinely IMMUTABLE — enforced below, not by
-- convention — is the row's IDENTITY: which tenant, which slug_base, and
-- (once first written) which concrete project_id/squad_id this receipt is
-- about, plus its created_at. Every other column (disposition,
-- actor_member_id, bot_agent_id, invited_count, failed_step, failure_reason)
-- reflects the LATEST call's outcome by design — a 'failed' row transitions
-- to 'created' the moment a retry finishes the job, and invited_count keeps
-- accumulating across calls the same way it always has.

CREATE TABLE IF NOT EXISTS team_bootstrap_receipts (
  id                TEXT NOT NULL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  actor_member_id   TEXT NOT NULL,          -- the caller of the MOST RECENT attempt (see header)
  slug_base         TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  squad_id          TEXT NOT NULL,
  bot_agent_id      TEXT,                    -- NULL when no bot exists yet (disabled, or not reached)
  disposition       TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'failed')),
  failed_step       TEXT CHECK (failed_step IS NULL OR failed_step IN ('edge_or_bot', 'invite_insert')),
  failure_reason    TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('unique_violation', 'write_failed')),
  invited_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant, slug_base),                -- one row per (tenant, slug_base), forever — see header
  CHECK ((disposition = 'failed') = (failed_step IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_project
  ON team_bootstrap_receipts(project_id);
CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_squad
  ON team_bootstrap_receipts(squad_id);

CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_no_delete
  BEFORE DELETE ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts is append-only (rows are never deleted)');
END;

-- The row's IDENTITY — which team, and (once set) which concrete project/
-- squad it names — is permanently pinned. Every other column tracks the
-- latest attempt's outcome (see the file header's "RESUMABILITY" section)
-- and is deliberately left mutable: disposition/bot_agent_id/invited_count/
-- failed_step/failure_reason all change as a bootstrap attempt is retried
-- and completed, and actor_member_id reflects whoever made the most recent
-- call. tenant/slug_base can never legitimately change (they are the
-- UNIQUE key a retry looks itself up by); project_id/squad_id can never
-- legitimately change either — once resolved, this receipt is about THOSE
-- rows, permanently, even across a failed-then-retried sequence.
CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_pinned_identity
  BEFORE UPDATE ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts.tenant/slug_base/project_id/squad_id/created_at are immutable')
  WHERE NEW.tenant <> OLD.tenant
     OR NEW.slug_base <> OLD.slug_base
     OR NEW.project_id <> OLD.project_id
     OR NEW.squad_id <> OLD.squad_id
     OR NEW.created_at <> OLD.created_at;
END;

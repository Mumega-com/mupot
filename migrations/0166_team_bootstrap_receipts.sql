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
-- SHAPE follows the SAME append-only receipt idiom as 0086/0115/0157/0161:
--   * TEXT id (UUID), no AUTOINCREMENT surrogate.
--   * actor_member_id is a FROZEN COPY of who called team_bootstrap, taken
--     at write time — same "frozen copy at grant time" reasoning 0148's
--     elevation_grants.effect column and 0157's decided_by/decided_via
--     document. A later capability change or member retirement must never
--     rewrite who a past bootstrap call is attributed to.
--   * NO foreign keys to projects/squads/agents/members — 0086/0113 learned
--     this the hard way: a CASCADE erases the receipt exactly when the
--     resource it documents is retired, which is precisely when the audit
--     trail is most needed. Orphan rows are the acceptable price (same
--     reasoning as 0157's header).
--   * bot_agent_id is NULL when the call declined to create a bot
--     (`bot.enabled === false`) — disposition never fabricates an agent id
--     that does not exist.
--   * disposition mirrors the two-value shape 0161's Athena ruling settled
--     on: 'created' (this call minted a new project AND/OR a new squad)
--     or 'existing' (idempotent replay — every row it names was already
--     there). A partial mix (new project, reused squad) is still recorded
--     as 'created' — the receipt names the CONCRETE ids either way, so the
--     exact disposition of each part is always re-derivable by reading
--     projects.created_at / squads.created_at against this row's
--     created_at, never by trusting this one flag alone for sub-parts.
--   * append-only, enforced by trigger, not convention.

CREATE TABLE IF NOT EXISTS team_bootstrap_receipts (
  id                TEXT NOT NULL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  actor_member_id   TEXT NOT NULL,          -- frozen copy of auth.memberId at call time
  slug_base         TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  squad_id          TEXT NOT NULL,
  bot_agent_id      TEXT,                    -- NULL when bot.enabled === false
  disposition       TEXT NOT NULL CHECK (disposition IN ('created', 'existing')),
  invited_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant, slug_base)                 -- one receipt per (tenant, slug_base) — idempotent replay UPDATEs invited_count only via the service layer, never a second row
);

CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_project
  ON team_bootstrap_receipts(project_id);
CREATE INDEX IF NOT EXISTS idx_team_bootstrap_receipts_squad
  ON team_bootstrap_receipts(squad_id);

-- Append-only in spirit, EXCEPT for invited_count: a second team_bootstrap
-- call for the same slug_base that adds NEW humans not previously invited
-- must be able to report an updated invited_count on the SAME receipt row —
-- the alternative (a second row) would violate the UNIQUE(tenant, slug_base)
-- idempotency the service layer relies on to find "the" receipt for a
-- slug_base. Every OTHER column is immutable once written.
CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_no_delete
  BEFORE DELETE ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS team_bootstrap_receipts_immutable_identity
  BEFORE UPDATE OF
    tenant, actor_member_id, slug_base, project_id, squad_id, bot_agent_id,
    disposition, created_at
  ON team_bootstrap_receipts
BEGIN
  SELECT RAISE(ABORT, 'team_bootstrap_receipts identity fields are immutable — only invited_count may change');
END;

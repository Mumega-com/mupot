-- 0166_team_bootstrap_receipts.sql — mupot#1498 (team_bootstrap: one call
-- creates project-prj + squad-sqd + project bot + token claim + Hermes
-- profile scaffold). NOT applied by this build — branch/schema only, exactly
-- like 0143/0144/0147/0148/0157 through 0165 before it; a human applies it.
-- (Renumbered from 0163 — 0163/0164/0165 are owned by PRs #1501/#1507/#1509.)
--
-- REWRITTEN IN PLACE (still unapplied — successor to PR #1510, kasra-review
-- adversarial round-2 gate on 29728793, 2026-09-22, P0 "find-or-create is
-- create + explicit adopt" applied to only ONE of the function's two
-- find-or-creates). Two classes of change over the round-2 shape:
--
-- (1) PROVENANCE COLUMNS on the resource tables themselves. Round-2 gave the
--     SQUAD limb an ownership ground (squadIsAdoptable) but left the PROJECT
--     limb with none at all — a lead's org-scoped `action:workspace_project`
--     elevation could plant `<x>-prj`, and the org-admin's LATER team_bootstrap
--     silently adopted it, keeping the planter's name/repo_url/worker_name (=
--     the deploy target) and wiring an ADMIN edge + mintable bot onto it.
--     Fix: `projects.created_by_member_id` and `squads.created_by_member_id`
--     (additive, nullable — pre-existing rows land NULL). Every create path
--     for either table now stamps this via a caller-only opts parameter (the
--     SAME "not reachable from a raw JSON body" discipline org/service.ts's
--     `CreateOpts.kind` already uses for the home/work distinction) — never a
--     field on any Input interface a route can construct from `c.req.json()`.
--
-- (2) "EMPTY" REMOVED AS AN ADOPTION GROUND, EVERYWHERE. Round-2's squad
--     ground (b) — zero `agents` rows, zero `capabilities` rows — is REMOVED
--     rather than widened. `createSquad` writes no capability row for its
--     creator, so EVERY freshly created squad satisfied that ground; the
--     round-1 squat was trivially reproducible by a lower principal than the
--     round-2 fix assumed. src/org/team-bootstrap.ts's adoptability check for
--     BOTH the project and the squad limb is now PURELY provenance-based:
--     adoptable iff (i) a prior team_bootstrap attempt already named this
--     exact resource id for this exact slug_base (a genuine resumed retry,
--     checked against this table — the append-only trail, never the
--     resource's current, attacker-controllable state), OR (ii)
--     `created_by_member_id` on the row equals the calling actor (they made
--     it, through whatever tool, before this call), OR (iii) the caller
--     passes `adopt: true` AND is org:admin (isOrgAdmin, checked in the core
--     function) — an explicit, informed, RECEIPTED override. A pre-existing
--     row with NULL `created_by_member_id` (everything created before this
--     migration) is adoptable only via (iii).
--
-- RESOLVE-BOTH-BEFORE-ANY-CREATE (P1-A, same gate). The round-2 shape created
-- the project FIRST, then found the squad name taken — an orphan project,
-- zero receipt, permanent name reservation, no retry path. team_bootstrap now
-- resolves (finds, never creates) BOTH `<slug_base>-prj` and `<slug_base>-sqd`
-- and clears BOTH adoptability checks BEFORE creating either. A refusal on
-- either limb writes a `'failed'` attempt receipt (new `failed_step` value
-- `'name_resolution'`, new `failure_reason` values `'project_slug_taken'` /
-- `'squad_slug_taken'`) instead of the round-2 shape's silent, unreceipted
-- return — so the retry surface and any operator watching this table both see
-- it. Because nothing is created until both names clear, `project_id` and
-- `squad_id` on a `'name_resolution'` failure row are the FOUND resource (if
-- one exists) or NULL (the name was simply free, refused on the OTHER limb) —
-- both columns are now nullable for exactly this reason (every OTHER
-- disposition still always carries both, unchanged from round-2: a create or
-- adopt cannot proceed without knowing both rows).
--
-- RELEASE PATH (P1-A, documented alternative to a dedicated release tool):
-- `isSlugBaseReserved` (src/org/team-bootstrap.ts, consumed by update_squad's
-- reserved-name rename floor) no longer treats a receipt as reserving a name
-- forever. A receipt reserves `slug_base` only WHILE the project it names
-- still exists (`EXISTS (SELECT 1 FROM projects WHERE id = receipt.project_id)`
-- — a receipt with NULL `project_id`, or one naming a project that has since
-- been deleted, does not reserve). Deleting the orphaned project is therefore
-- the release action; no new MCP tool was added for it.
--
-- HOME FENCE (P2-4): team_bootstrap never adopts a `kind='home'` squad, even
-- with `adopt: true` by an org-admin — checked in the core function on every
-- resolved squad row, not just the round-2 non-adoptable branch. This was
-- already LATENT-only (the canonical home slug `home-<8hex>` can never end in
-- `-sqd`), but the fence is now explicit rather than relying on that
-- coincidence of naming.
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
--   * project_id / squad_id are nullable (changed in this rewrite — see
--     RESOLVE-BOTH-BEFORE-ANY-CREATE above): NULL on a `'name_resolution'`
--     failure for whichever limb was never found or created; always non-NULL
--     on every other disposition.
--   * bot_agent_id is NULL when this attempt declined to create a bot
--     (`bot.enabled === false`) or never reached the bot step (a
--     stage-1-or-earlier failure) — never fabricates an agent id that does
--     not exist AT THE TIME of this attempt.
--   * disposition: `'created'` (BOTH the project and the squad were newly
--     created by this attempt), `'existing'` (a pure no-op replay — every
--     row it names was already there via a PRIOR team_bootstrap attempt
--     naming the exact same resources, and this attempt created no bot and
--     sent no new invite), `'adopted'` (this rewrite: fires on EVERY path
--     that is not one of the two above — a provenance-owned pre-existing
--     row, an org-admin's explicit `adopt: true` override, or a mixed
--     create-one/adopt-the-other attempt — not just the explicit-override
--     branch round-2 limited it to), or `'failed'` (the write phase did not
--     finish this attempt, OR name resolution refused before any write).
--     `failed_step` names where it stopped (`'edge_or_bot'` |
--     `'invite_insert'` | `'name_resolution'`, the last one added in this
--     rewrite); `failure_reason` is a short, STRUCTURAL classification
--     (`'unique_violation'` | `'write_failed'` | `'archived_project'` |
--     `'project_slug_taken'` | `'squad_slug_taken'`, the last two added in
--     this rewrite) — deliberately NOT the raw driver error text and NEVER
--     an email address or other human PII, so this table stays safe to page
--     through operationally without becoming a second place secrets/PII
--     could leak from.
--   * append-only, enforced by trigger, not convention — no exceptions this
--     time, unlike the prior version of this migration.

ALTER TABLE projects ADD COLUMN created_by_member_id TEXT;
ALTER TABLE squads ADD COLUMN created_by_member_id TEXT;

-- created_via_receipt (Athena ruling relayed 2026-09-22, mupot seq 5238):
-- the elevation_grants.id that authorized this create, when the create ran
-- under a bounded action:* elevation rather than standing capability — NULL
-- when created under standing capability (the common case) or before this
-- column existed. No FK to elevation_grants: that table's rows are never
-- deleted (only revoked_at is set), so an FK would be safe, but every other
-- provenance/receipt column in this migration is a plain pointer without one
-- (see created_by_member_id above, and team_bootstrap_receipts's own header
-- on why this repo prefers orphan-tolerant pointers over CASCADE risk on
-- audit-adjacent tables) — kept consistent rather than special-cased.
-- Surfaced in team_bootstrap's project_slug_taken/squad_slug_taken refusal
-- detail and the adopt:true override path so an admin adopting someone
-- else's row sees "created by member X under elevation receipt Y" when that
-- applies, not just the bare member id.
ALTER TABLE projects ADD COLUMN created_via_receipt TEXT;
ALTER TABLE squads ADD COLUMN created_via_receipt TEXT;

CREATE TABLE IF NOT EXISTS team_bootstrap_receipts (
  id                TEXT NOT NULL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  actor_member_id   TEXT NOT NULL,          -- frozen copy of who made THIS attempt
  slug_base         TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,       -- 1, 2, 3... per (tenant, slug_base)
  project_id        TEXT,                   -- NULL only on a name_resolution failure that never found/created it
  squad_id          TEXT,                   -- NULL only on a name_resolution failure that never found/created it
  bot_agent_id      TEXT,                    -- NULL when no bot exists as of THIS attempt
  disposition       TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'adopted', 'failed')),
  failed_step       TEXT CHECK (failed_step IS NULL OR failed_step IN ('edge_or_bot', 'invite_insert', 'name_resolution')),
  failure_reason    TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('unique_violation', 'write_failed', 'archived_project', 'project_slug_taken', 'squad_slug_taken')),
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

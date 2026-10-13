-- 0216_workspaces.sql — workspaces W1 (design: mumega-com docs/architecture/harness-seats-worktrees.md §4.0, §4.1).
--
-- Behind the WORKSPACES flag. This migration is additive and inert with the flag off: the new
-- tables are written only by worktree_open, and harnesses.grant_id is only chosen by the OAuth
-- consent path when WORKSPACES is on (every other writer gets a deterministic default below).
--
-- 4.0 HARNESS = ONE GRANT. oauth_client_id names a client APPLICATION; a shared connector
-- (claude.ai, ChatGPT) uses one client id for every install. The harness key becomes the grant
-- (one consent = one refresh-token family): unique on (tenant, member_id, grant_id).
--   * OAuth harness: grant_id = 'oauth:<member_tokens.id minted by that consent>'. The consent's
--     token row is one-per-consent and rides in the grant props for the grant's whole life, so it is
--     the stable id of the refresh-token family (the OAuth library does not expose its own grant id
--     before completeAuthorization, which is when the harness row has to exist).
--   * Token harness: grant_id = 'token:<token_id>' (already one row per member_tokens row).
--   * Backfill: every pre-existing OAuth row was created by exactly one consent, so it becomes its
--     own grant: 'legacy:<harness id>'. Seat keys, caps and audit key on harnesses.id, so every
--     existing seat stays valid: no harness id changes.
--   * oauth_client_id stays a label. DESIGN NOTE (as 0204): harnesses is the RESTRICT parent of
--     agent_seats / seat_handles, so the table cannot be rebuilt to drop UNIQUE (tenant,
--     member_id, oauth_client_id). A grant-keyed OAuth row therefore stores the label as
--     '<client_id>#oauth:<token id>' (unique per grant, so that legacy constraint never fires). Nothing
--     reads oauth_client_id for authority.
ALTER TABLE harnesses ADD COLUMN grant_id TEXT;

UPDATE harnesses
   SET grant_id = CASE WHEN credential_kind = 'token' THEN 'token:' || token_id ELSE 'legacy:' || id END
 WHERE grant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_harnesses_grant ON harnesses (tenant, member_id, grant_id);

-- Any writer that does not choose a grant (the flag-off OAuth upsert, the token mint, test fixtures)
-- gets a deterministic one, so no live row is ever grant-less.
CREATE TRIGGER IF NOT EXISTS harnesses_grant_default
AFTER INSERT ON harnesses
FOR EACH ROW
WHEN NEW.grant_id IS NULL
BEGIN
  UPDATE harnesses
     SET grant_id = CASE WHEN NEW.credential_kind = 'token' THEN 'token:' || NEW.token_id ELSE 'legacy:' || NEW.id END
   WHERE id = NEW.id;
END;

-- Shape: a token harness's grant IS its token; 'legacy:' is reserved for the backfill / default; an
-- OAuth harness may not squat the token namespace.
CREATE TRIGGER IF NOT EXISTS harnesses_grant_shape_insert
BEFORE INSERT ON harnesses
FOR EACH ROW
WHEN NEW.grant_id IS NOT NULL
 AND ((NEW.credential_kind = 'token' AND NEW.grant_id IS NOT ('token:' || NEW.token_id))
   OR (NEW.credential_kind = 'oauth' AND (NEW.grant_id LIKE 'token:%' OR (NEW.grant_id LIKE 'legacy:%' AND NEW.grant_id IS NOT ('legacy:' || NEW.id)))))
BEGIN
  SELECT RAISE(ABORT, 'harness_grant_shape');
END;

-- A grant is immutable EXCEPT for one move: an OAuth harness whose consent token is REVOKED may be
-- re-pointed at the same member's next consent (reuseRevokedHarness, src/members/harness.ts), so a
-- re-consent after revoke does not mint a fresh harness every time and burn seats toward the lifetime
-- cap. The old grant must be 'oauth:' + a token that is revoked; the new one must be 'oauth:' + a token of
-- the SAME member that is live. Anything else is refused.
CREATE TRIGGER IF NOT EXISTS harnesses_grant_immutable
BEFORE UPDATE OF grant_id ON harnesses
FOR EACH ROW
WHEN OLD.grant_id IS NOT NULL AND NEW.grant_id IS NOT OLD.grant_id
 AND NOT (
      OLD.credential_kind = 'oauth' AND OLD.grant_id LIKE 'oauth:%' AND NEW.grant_id LIKE 'oauth:%'
  AND EXISTS (SELECT 1 FROM member_tokens t WHERE t.id = substr(OLD.grant_id, 7) AND t.revoked_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM member_tokens n WHERE n.id = substr(NEW.grant_id, 7) AND n.member_id = OLD.member_id
                 AND n.tenant = OLD.tenant AND n.revoked_at IS NULL)
 )
BEGIN
  SELECT RAISE(ABORT, 'harness_grant_immutable');
END;

-- 4.1 WORKTREE AS A MUPOT RECORD. Identity is NEVER a local path.
--   kind 'git_branch' (the #1371 identity): project + repo_key + branch. repo_key comes from
--       repoIdentity() (src/workspaces/repo-key.ts) and must be the project's repo or a
--       project_repos entry (checked in code: repo_not_in_project). A detached HEAD has no identity.
--   kind 'folder': a named non-git workspace: project + a human-chosen slug.
--   kind 'thread': a chat thread id inside one harness: project + harness_id + thread id.
-- Shape is a CHECK so a mis-shaped row cannot exist whatever writes it. repo_key / harness_id use ''
-- as "not applicable" (NULLs are distinct in a SQLite UNIQUE index, which would defeat the identity).
CREATE TABLE IF NOT EXISTS worktrees (
  id                   TEXT PRIMARY KEY,
  tenant               TEXT NOT NULL,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind                 TEXT NOT NULL CHECK (kind IN ('git_branch', 'folder', 'thread')),
  repo_key             TEXT NOT NULL DEFAULT '' CHECK (length(repo_key) <= 512),
  harness_id           TEXT NOT NULL DEFAULT '',
  ref_kind             TEXT NOT NULL CHECK (ref_kind IN ('branch', 'slug', 'thread')),
  ref_name             TEXT NOT NULL CHECK (length(ref_name) BETWEEN 1 AND 255),
  created_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at          TEXT,
  -- display only: written on boot, never authority (nothing reads these to decide anything)
  last_head_sha        TEXT CHECK (last_head_sha IS NULL OR length(last_head_sha) BETWEEN 7 AND 64),
  last_seen_at         TEXT,
  CHECK (
       (kind = 'git_branch' AND ref_kind = 'branch' AND repo_key <> '' AND harness_id = '')
    OR (kind = 'folder'     AND ref_kind = 'slug'   AND repo_key = ''  AND harness_id = '')
    OR (kind = 'thread'     AND ref_kind = 'thread' AND repo_key = ''  AND harness_id <> '')
  ),
  UNIQUE (tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name)
);

CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees (tenant, project_id, archived_at);

-- Identity never changes; only archive state and the display columns may.
CREATE TRIGGER IF NOT EXISTS worktrees_identity_immutable
BEFORE UPDATE ON worktrees
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.project_id IS NOT OLD.project_id
  OR NEW.kind IS NOT OLD.kind OR NEW.repo_key IS NOT OLD.repo_key OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.ref_kind IS NOT OLD.ref_kind OR NEW.ref_name IS NOT OLD.ref_name
  OR NEW.created_by_member_id IS NOT OLD.created_by_member_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'worktree_identity_immutable');
END;

-- Creation cap, per member per project, INSIDE the inserting statement (so it holds under concurrency):
-- folder + thread rows 200, git_branch rows 1000, counting UNARCHIVED rows only (archive path: follow-up issue). Reopening an existing workspace never inserts, so it
-- is never refused by the cap.
CREATE TRIGGER IF NOT EXISTS worktrees_creation_cap
BEFORE INSERT ON worktrees
FOR EACH ROW
WHEN (NEW.kind = 'git_branch'
      AND (SELECT COUNT(*) FROM worktrees w WHERE w.tenant = NEW.tenant AND w.project_id = NEW.project_id
              AND w.created_by_member_id = NEW.created_by_member_id AND w.kind = 'git_branch' AND w.archived_at IS NULL) >= 1000)
  OR (NEW.kind <> 'git_branch'
      AND (SELECT COUNT(*) FROM worktrees w WHERE w.tenant = NEW.tenant AND w.project_id = NEW.project_id
              AND w.created_by_member_id = NEW.created_by_member_id AND w.kind <> 'git_branch' AND w.archived_at IS NULL) >= 200)
BEGIN
  SELECT RAISE(ABORT, 'worktree_cap_reached');
END;

-- harness_id is '' for non-thread rows, so it cannot carry a FOREIGN KEY. Instead a harness that a
-- thread worktree names cannot be deleted out from under it.
CREATE TRIGGER IF NOT EXISTS harnesses_worktree_delete_guard
BEFORE DELETE ON harnesses
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM worktrees w WHERE w.harness_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'harness_has_worktrees');
END;

-- A thread worktree names a REAL harness of the same tenant.
CREATE TRIGGER IF NOT EXISTS worktrees_thread_harness_insert
BEFORE INSERT ON worktrees
FOR EACH ROW
WHEN NEW.kind = 'thread'
 AND NOT EXISTS (SELECT 1 FROM harnesses h WHERE h.id = NEW.harness_id AND h.tenant = NEW.tenant)
BEGIN
  SELECT RAISE(ABORT, 'worktree_harness_unknown');
END;

-- project_repos: the per-project allow-list of repositories a git_branch worktree may name, besides
-- the project's own repo_url. repo_key is the canonical key (repoKeyFromUrl); written by a structural
-- write path (not by worktree_open: a typo must never widen the list).
CREATE TABLE IF NOT EXISTS project_repos (
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_key            TEXT NOT NULL CHECK (length(repo_key) BETWEEN 1 AND 512),
  added_by_member_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, repo_key)
);

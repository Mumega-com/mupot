-- 0253 canonical repo key on projects, so "which project owns this repository" is an indexed equality
-- lookup instead of a substring scan (#2137 item 3).
--
-- projects.repo_key: repoKeyFromUrl(repo_url), the same fold project_repos.repo_key already stores
-- ('github:owner/repo', 'url:host/path'). Three states, and the resolver (src/projects/office-repo-owner.ts)
-- reads each one:
--   a key        canonical; the lookup is `repo_key = ?` on the index below.
--   ''           repo_url has no network identity (a local path, an unparseable string). Owns nothing.
--   NULL         PENDING: repo_url is set but nobody has canonicalized it yet. The canonical key cannot be computed in SQL,
--                so every row that exists at migration time starts here. A pending row still COUNTS as an owner: the
--                lookups canonicalize its URL in memory at read time and write nothing. It is healed out of band, by a
--                bounded slice per maintenance-cron tick (src/projects/repo-key-heal.ts) and, if you want it done now, by
--                the one-time scripts/backfill-repo-key.mjs (idempotent, --dry-run). Both are compare-and-set.
--
-- DEPLOY ORDER. Apply this migration BEFORE the Worker that uses it: the project writers name repo_key, and a Worker
-- running without the column fails every project create/update with "no such column". The deploy script migrates first.
--
-- Writers (createProject, updateProject, client-bootstrap upsert) set repo_key beside repo_url. The trigger below
-- is the net under any writer that does not (raw SQL, a seed script, a future code path): when repo_url changes and
-- repo_key was left as it was, the key is no longer evidence of anything, so it goes back to PENDING.
--
-- project_repos already carries a canonical repo_key (written canonical by its structural write path; there is no
-- writer in the application today). It only gains an index on repo_key alone, since its primary key leads with
-- project_id.
ALTER TABLE projects ADD COLUMN repo_key TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_repo_key
  ON projects(repo_key)
  WHERE repo_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_repo_key_pending
  ON projects(id)
  WHERE repo_url IS NOT NULL AND repo_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_repos_repo_key
  ON project_repos(repo_key);

CREATE TRIGGER IF NOT EXISTS projects_repo_key_stale_on_url_change
AFTER UPDATE OF repo_url ON projects
FOR EACH ROW
WHEN NEW.repo_url IS NOT OLD.repo_url AND NEW.repo_key IS OLD.repo_key
BEGIN
  UPDATE projects SET repo_key = NULL WHERE id = NEW.id;
END;

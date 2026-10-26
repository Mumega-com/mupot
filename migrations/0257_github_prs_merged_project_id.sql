-- 0257: attribute a merged-PR observation to the project that owns its repo.
-- Nullable: NULL = no project owns the repo, or more than one does (resolveRepoProject's rule), or
-- the row predates this column. No backfill: old rows keep NULL, never a guess.
-- Apply BEFORE deploying the worker that writes it (recordMergedPr binds this column).
ALTER TABLE github_prs_merged ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_github_prs_merged_project
  ON github_prs_merged (tenant_id, project_id, merged_at);

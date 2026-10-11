-- 0209_project_seeds.sql — durable record of an applied mupot.seed/v1 (seed_attach, dry_run:false).
--
-- Additive only. One row per (tenant, derived project slug). The row is INSERTED FIRST (status
-- 'applying') and its UNIQUE key is the idempotency lock: a racing or repeated apply of the same seed
-- hits the UNIQUE constraint and creates nothing. Digest equal -> replay; digest different -> refused.
--
-- STORES ONLY THE CANONICAL FORM (canonical_json) and its digest — never the raw seed source, whose
-- comments and whitespace can carry secrets and still pass validation. `owner_label` is a label and is
-- never resolved to a member. `requests_json` lists every request the seed makes, each recorded as
-- 'pending_human': applying a seed GRANTS NOTHING (no gate, routine, credential, deploy right, agent).
-- `seat_cap` records the maximum seats the seed asked for; no agent or token is created from it.
CREATE TABLE IF NOT EXISTS project_seeds (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  project_id TEXT,
  squad_id TEXT,
  seed_sha256 TEXT NOT NULL CHECK (
    length(seed_sha256) = 64 AND seed_sha256 = lower(seed_sha256) AND seed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  requests_json TEXT NOT NULL CHECK (json_valid(requests_json)),
  owner_label TEXT NOT NULL,
  seat_cap INTEGER CHECK (seat_cap IS NULL OR seat_cap BETWEEN 1 AND 8),
  applied_by_member_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applying', 'applied')),
  lease_token TEXT,
  lease_expires_at TEXT,
  UNIQUE (tenant, project_slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_seeds_project
  ON project_seeds(project_id) WHERE project_id IS NOT NULL;

-- 0146_members_email_lower_index.sql — index members on lower(email).
--
-- #1330 F-D: src/auth/index.ts's unconditional status check (added to close the
-- registered-session fail-open, see 0145-era commit) queries
-- `WHERE lower(email) = ?1 AND tenant = ?2` on every cookie-authenticated
-- request. The only existing index on members.email is the UNIQUE constraint
-- on the raw column, which `lower()` makes unusable — SQLite/D1 cannot use an
-- index on `email` to satisfy a predicate on `lower(email)`. Without this,
-- every such request does a full table scan of members.
--
-- A functional index on the expression lets the query planner use it directly.

CREATE INDEX IF NOT EXISTS idx_members_email_lower ON members (lower(email));

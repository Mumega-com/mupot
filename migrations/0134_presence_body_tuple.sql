-- 0134_presence_body_tuple.sql — Body-level presence tuple (FLIGHT ID-03 / #1168 & #1163).
--
-- Why: Identity is the Name; Body is the active hands tuple (machine, harness, folder, thread).
-- Previously presence was uniquely keyed per (tenant, member_id, label). Two live running bodies
-- of an agent (e.g. river on Mac vs river on Cursor Cloud / Hetzner) would clobber each other's live session.
--
-- This migration adds folder, thread, and continuum_name to presence and updates indices so
-- multiple distinct bodies of the same continuum can coexist independently.

ALTER TABLE presence ADD COLUMN folder TEXT;
ALTER TABLE presence ADD COLUMN thread TEXT;
ALTER TABLE presence ADD COLUMN continuum_name TEXT;

CREATE INDEX IF NOT EXISTS idx_presence_continuum ON presence(tenant, continuum_name, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_body_tuple ON presence(tenant, member_id, machine, harness, folder, thread);

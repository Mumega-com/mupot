-- 0227_page_versions — a monotonic version COUNTER for agent-written wiki pages (PagesPort, src/pages/).
-- It carries NO ownership meaning. Owner, writer and tier live ONLY in the stamped envelope inside the
-- text record (the store of record); this table is rebuildable from that text: next version =
-- MAX(counter, text version) + 1, so a lost row costs nothing but a re-count. A row is committed only
-- AFTER a successful put, so a refused or failed write leaves nothing behind. Its one other use is a
-- refuse-only hint: a counter row whose page the store can no longer show means "we wrote here before",
-- so the slug is not re-put (an update would silently republish an unpublished topic).
CREATE TABLE IF NOT EXISTS page_versions (
  project_id  TEXT NOT NULL,
  slug        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  PRIMARY KEY (project_id, slug)
);

-- 0015_prospects.sql — the outreach prospect queue (P4, #35).
--
-- A prospect is one published B2B contact in an outreach loop's work queue. The loop's
-- 'queue' source reads queued prospects; the reasoner drafts to one; the gate approves;
-- GHL sends; a reply moves it to 'replied' (the KPI signal). CASL: consent_basis records
-- the lawful basis — 'unknown' (e.g. a discovered contact) MUST be human-gated, never
-- auto-sent. opt-out is terminal and always suppresses.

CREATE TABLE IF NOT EXISTS prospects (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  loop_id       TEXT,                         -- which loop's queue (null = shared/unassigned)
  org           TEXT,
  contact_name  TEXT,
  email         TEXT,
  source        TEXT NOT NULL DEFAULT 'seed'
                  CHECK(source IN ('seed', 'discovered')),
  consent_basis TEXT NOT NULL DEFAULT 'unknown'
                  CHECK(consent_basis IN ('existing_relationship', 'consent', 'unknown')),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK(status IN ('queued', 'drafted', 'sent', 'replied', 'opted_out', 'bounced')),
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prospects_tenant_status ON prospects (tenant, status);
CREATE INDEX IF NOT EXISTS idx_prospects_loop ON prospects (loop_id);

-- Dedup: at most ONE active (non-terminal) prospect per (tenant, email). A second seed
-- or discovery of the same email while one is in flight is rejected by this unique index
-- (the productive-tick amplification guard the P3 review required lands here, by construction).
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_email_active
  ON prospects (tenant, email)
  WHERE status IN ('queued', 'drafted', 'sent') AND email IS NOT NULL;

-- mupot — CRO event grain (epic #213, slice 1.5).
--
-- The raw conversion-funnel event store. metric_points is the AGGREGATED read layer
-- (dashboard KPIs); it cannot answer attribution or per-segment questions, so a confound
-- (traffic mix shifting mid-test → Simpson's paradox) is invisible there. cro_events is
-- the event grain: each CRO source adapter (first-party, PostHog, Ads, CRM) writes
-- normalized events here, and an aggregation job materializes segment-keyed metric_points
-- (e.g. metric_key 'cvr:device:mobile') from it. Two-tier model (Segment/RudderStack/
-- MetricFlow convention): raw grain → materialized aggregation → metrics.
--
-- tenant_id is the isolation boundary (single-tenant pot, but bound on every write).
-- occurred_at / created_at are epoch-ms INTEGERs (intraday precision + range-scan friendly).
CREATE TABLE IF NOT EXISTS cro_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  source      TEXT NOT NULL,        -- 'first_party' | 'posthog' | 'google_ads' | 'crm' | …
  event_name  TEXT NOT NULL,        -- 'pageview' | 'signup' | 'checkout' | …
  user_id     TEXT,                 -- pseudonymous, nullable
  session_id  TEXT,                 -- nullable
  occurred_at INTEGER NOT NULL,     -- epoch ms the event is FOR
  properties  TEXT,                 -- JSON blob (variant, page, device, …); nullable
  created_at  INTEGER NOT NULL      -- epoch ms the row was written
);

-- Time-series scan by source (the collector's primary read).
CREATE INDEX IF NOT EXISTS idx_cro_events_source ON cro_events (tenant_id, source, occurred_at);
-- Funnel-step scan by event name (conversion-rate aggregation).
CREATE INDEX IF NOT EXISTS idx_cro_events_name ON cro_events (tenant_id, event_name, occurred_at);
-- Per-session reconstruction (attribution path).
CREATE INDEX IF NOT EXISTS idx_cro_events_session ON cro_events (tenant_id, session_id);

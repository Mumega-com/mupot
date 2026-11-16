-- 0275: notify kernel slice 1 (src/notify/). Three additive tables; nothing existing is altered or read by routing.
--
-- notif_event    one row per notify() call that reached at least one recipient. Holds REFERENCES only
--                (type, subject_ref, recipient ids), never message bodies, tokens, codes or raw payloads.
-- notif_delivery one row per (event, recipient, channel). status is the adapter's outcome; retry_after and
--                external_ref are reserved for the retry / edit-in-place work and stay NULL in slice 1.
-- notif_dedupe   one row per (tenant, recipient, dedupe_key): the start of the current suppression window.
CREATE TABLE IF NOT EXISTS notif_event (
  id              TEXT NOT NULL PRIMARY KEY,
  tenant          TEXT NOT NULL,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','attention','decision','critical')),
  subject_ref     TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  action_class    TEXT CHECK (action_class IS NULL OR action_class IN ('reversible','high_risk')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_event_tenant_created ON notif_event (tenant, created_at);

CREATE TABLE IF NOT EXISTS notif_delivery (
  id           TEXT NOT NULL PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES notif_event (id) ON DELETE CASCADE,
  tenant       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  channel      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent','edited','acked','failed','capped')),
  retry_after  TEXT,
  external_ref TEXT,
  error_code   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_delivery_event ON notif_delivery (event_id);
CREATE INDEX IF NOT EXISTS idx_notif_delivery_rate ON notif_delivery (tenant, recipient, channel, created_at);

CREATE TABLE IF NOT EXISTS notif_dedupe (
  tenant          TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant, recipient, dedupe_key)
);

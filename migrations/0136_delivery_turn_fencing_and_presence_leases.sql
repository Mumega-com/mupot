-- 0136_delivery_turn_fencing_and_presence_leases.sql — Fenced Delivery Turn Fencing & Presence Epoch/Lease (FLIGHT DELIV-03 / #1031 & #1050).
--
-- Deliverables:
-- 1. Thread-bound dynamic delivery turn fences table:
--    Binds delivery consumption strictly to {thread_id, turn_id, generation, correlation_id, nonce_hash}
--    Preventing cross-turn replay, cross-thread misuse, and out-of-order delivery consumption.
--
-- 2. Presence session epoch & lease extensions (#1031):
--    Adds session_epoch and lease_ttl_sec to module_registry and presence so that peers can
--    distinguish live-epoch vs dead-epoch pending records without relying on inference-from-absence.

-- ── 1. Delivery Turn Fences ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS delivery_turn_fences (
  delivery_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'invalidated')),
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_turn_fences_tenant
  ON delivery_turn_fences(tenant, thread_id, turn_id);

CREATE INDEX IF NOT EXISTS idx_delivery_turn_fences_active
  ON delivery_turn_fences(tenant, status)
  WHERE status = 'active';

-- ── 2. Presence & Module Registry Session Epoch / Lease Extensions (#1031) ───

ALTER TABLE module_registry ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE module_registry ADD COLUMN lease_ttl_sec INTEGER NOT NULL DEFAULT 120;

ALTER TABLE presence ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE presence ADD COLUMN lease_ttl_sec INTEGER NOT NULL DEFAULT 180;

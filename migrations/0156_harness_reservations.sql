-- 0156_harness_reservations.sql — Harness Adapter SPI & pre-dispatch reservations.
--
-- mupot#1428 / Flight f0150aed-caee-4411-9690-1d03d7d9ea43
--
-- Why this table exists:
-- Vendor agent dispatches (e.g. Cursor Cloud, Grok CLI, Hermes, Codex) must be
-- reserved authoritatively in Mupot BEFORE contacting vendor cloud APIs.
-- Calling vendor cloud APIs before creating Mupot Task & Flight records caused
-- 30-second MCP client timeouts and left untracked orphan runs on vendor infrastructure.
--
-- With this table:
-- 1. Mupot creates Task + Flight + harness_reservations (state='reserved') < 200ms.
-- 2. MCP returns { accepted: true, state: 'reserved', reservation_id, task_id, flight_id }.
-- 3. The vendor execution attaches asynchronously via ToolCtx.waitUntil or background reconcile.
-- 4. Idempotency is enforced per (tenant, adapter, idempotency_key).

CREATE TABLE IF NOT EXISTS harness_reservations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN (
    'cursor-cloud','grok-cli','hermes','codex-cli','claude-code','antigravity-cli'
  )),
  idempotency_key TEXT NOT NULL CHECK (
    length(trim(idempotency_key)) BETWEEN 1 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest = lower(request_digest)
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  squad_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','agent')),
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved','attaching','attached','failed','reconciled'
  )),
  vendor_agent_id TEXT,
  vendor_run_id TEXT,
  vendor_url TEXT,
  last_vendor_status TEXT,
  attach_lease_until TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 2000),
  reserved_at TEXT NOT NULL,
  attached_at TEXT,
  reconciled_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant, adapter, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_harness_reservations_reconcile
  ON harness_reservations (tenant, state, updated_at);

CREATE INDEX IF NOT EXISTS idx_harness_reservations_task
  ON harness_reservations (tenant, task_id);

CREATE INDEX IF NOT EXISTS idx_harness_reservations_vendor
  ON harness_reservations (tenant, adapter, vendor_run_id);

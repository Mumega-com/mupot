-- Department ctx ports (S4 runtime): AuditPort.write → department_audit,
-- BusPort.publish → department_outbox. Both are REAL durable writes now (were
-- silent no-ops: capability check + `void event` / `void msg`). The outbox
-- mirrors flight_event_outbox (0046): a queue producer drains delivered_at IS
-- NULL rows into the mupot-events queue without reopening the source act.

-- ── department_audit: append-only, tenant+dept scoped ──────────────────────
CREATE TABLE IF NOT EXISTS department_audit (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  tenant_id      TEXT NOT NULL,
  department_key TEXT NOT NULL,
  action         TEXT NOT NULL,
  actor_type     TEXT NOT NULL DEFAULT 'system'
                 CHECK (actor_type IN ('system','agent','user')),
  actor_id       TEXT,
  payload_json   TEXT,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_department_audit_scope
  ON department_audit (tenant_id, department_key, recorded_at DESC);

-- ── department_outbox: durable bus messages ────────────────────────────────
CREATE TABLE IF NOT EXISTS department_outbox (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  department_key TEXT NOT NULL,
  msg_type       TEXT NOT NULL,
  payload_json   TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  consumed_at    TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_department_outbox_pending
  ON department_outbox (tenant_id, delivered_at, created_at);

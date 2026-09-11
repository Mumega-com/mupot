-- mupot-hostd initial schema (Flight 2 Task 2)
-- Nine spec tables + audit_events + migration metadata.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    system TEXT NOT NULL,
    tenant TEXT NOT NULL,
    native_id TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (system, tenant, native_id)
);

CREATE TABLE IF NOT EXISTS source_cursors (
    source TEXT NOT NULL,
    tenant TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, tenant)
);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    source TEXT NOT NULL,
    object_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    UNIQUE (tenant, source, object_id, fact_key, observed_at)
);

CREATE TABLE IF NOT EXISTS conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant, idempotency_key)
);

CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    tenant TEXT NOT NULL,
    native_receipt_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source, tenant, native_receipt_id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (tenant, action_hash)
);

CREATE TABLE IF NOT EXISTS runtime_seats (
    tenant TEXT NOT NULL,
    seat TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, seat)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    previous_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

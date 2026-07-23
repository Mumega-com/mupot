-- 0071_secret_env.sql — pot-level secret env grants (CF Worker secret custody)
-- Values NEVER stored here — metadata + audit names only.

CREATE TABLE IF NOT EXISTS secret_env_requests (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  schema_json   TEXT NOT NULL,
  status        TEXT NOT NULL, -- pending | approved | rejected
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_secret_env_requests_pending
  ON secret_env_requests (tenant, status, created_at);

CREATE TABLE IF NOT EXISTS secret_env_bindings (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  binding_name  TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  adapter_hint  TEXT,
  status        TEXT NOT NULL, -- pending | bound | revoked
  requested_by  TEXT NOT NULL,
  bound_by      TEXT,
  request_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  bound_at      TEXT,
  revoked_at    TEXT,
  UNIQUE (tenant, binding_name)
);

CREATE INDEX IF NOT EXISTS idx_secret_env_bindings_request
  ON secret_env_bindings (tenant, request_id);

CREATE TABLE IF NOT EXISTS secret_env_audit (
  id           TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  request_id   TEXT,
  binding_name TEXT,
  action       TEXT NOT NULL, -- request | bind | reject | rotate | revoke
  actor_id     TEXT NOT NULL,
  detail       TEXT,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secret_env_audit_tenant
  ON secret_env_audit (tenant, recorded_at DESC);

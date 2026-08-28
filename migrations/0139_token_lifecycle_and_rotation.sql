-- 0139_token_lifecycle_and_rotation.sql — Token Lifecycle & Automated Rotation (FLIGHT-002).
--
-- Deliverables:
-- 1. token_rotations table:
--    Records automated and operator-driven credential rotations.
--    Tracks {id, tenant, old_token_id, new_token_id, rotated_by, reason, rotated_at}.
--
-- 2. Indexes on member_tokens for efficient expiry sweep queries.

CREATE TABLE IF NOT EXISTS token_rotations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  old_token_id TEXT NOT NULL,
  new_token_id TEXT NOT NULL,
  rotated_by TEXT NOT NULL,
  reason TEXT,
  rotated_at TEXT NOT NULL,
  FOREIGN KEY (old_token_id) REFERENCES member_tokens(id),
  FOREIGN KEY (new_token_id) REFERENCES member_tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_token_rotations_tenant
  ON token_rotations(tenant, old_token_id, new_token_id);

CREATE INDEX IF NOT EXISTS idx_member_tokens_tenant_expiry
  ON member_tokens(tenant, revoked_at, expires_at);

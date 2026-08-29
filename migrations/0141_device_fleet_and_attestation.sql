-- 0141_device_fleet_and_attestation.sql — Mupot OS Hardware Attestation & Device Fleet Control (Journey 2 / MU.200.001-DEVICE).
--
-- Deliverables:
-- 1. device_keys table:
--    Hardware-anchored Ed25519 public keys, device architecture (arm64/x86_64), machine label, and TPM/Secure Enclave attestation metadata.
--    Tracks {device_id, tenant, public_key, algo, machine, arch, os, acceleration, status, registered_at, last_seen_at}.
--
-- 2. device_pairings table:
--    Ephemeral challenge-response pairing state for cryptographic QR and terminal enrollment.
--    Tracks {pairing_code, tenant, device_id, enrollment_nonce, status, expires_at, created_at, claimed_by_member_id}.
--
-- 3. device_journals table:
--    Durable edge sync ledger for offline-first buffered transaction reconciliation.
--    Tracks {id, tenant, device_id, task_id, seq, event_type, payload_json, signature, synced_at}.
--
-- 4. device_power_states table:
--    Hardware power management and Wake-on-Demand mesh status.
--    Tracks {device_id, tenant, power_state, battery_pct, is_charging, wol_mac_address, last_state_change}.

-- ── 1. Device Hardware Keys & Attestation ────────────────────────────────────

CREATE TABLE IF NOT EXISTS device_keys (
  device_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  public_key TEXT NOT NULL,
  algo TEXT NOT NULL DEFAULT 'Ed25519',
  machine TEXT NOT NULL,
  arch TEXT NOT NULL DEFAULT 'arm64', -- 'arm64' | 'x86_64'
  os TEXT NOT NULL DEFAULT 'darwin',  -- 'darwin' | 'linux'
  acceleration TEXT NOT NULL DEFAULT 'none', -- 'apple-metal' | 'cuda' | 'rocm' | 'none'
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'retired')),
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_keys_tenant_status
  ON device_keys(tenant, status, last_seen_at);

-- ── 2. Device Pairing Challenges (QR Handshake) ──────────────────────────────

CREATE TABLE IF NOT EXISTS device_pairings (
  pairing_code TEXT PRIMARY KEY, -- 6-8 char code or UUID
  tenant TEXT NOT NULL,
  device_id TEXT NOT NULL,
  enrollment_nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_by_member_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_pairings_lookup
  ON device_pairings(tenant, status, expires_at);

-- ── 3. Device Offline Journals & Sync Ledger ─────────────────────────────────

CREATE TABLE IF NOT EXISTS device_journals (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  device_id TEXT NOT NULL,
  task_id TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES device_keys(device_id),
  UNIQUE (tenant, device_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_device_journals_device_seq
  ON device_journals(tenant, device_id, seq);

-- ── 4. Device Power & Wake-on-Demand Mesh ────────────────────────────────────

CREATE TABLE IF NOT EXISTS device_power_states (
  device_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  power_state TEXT NOT NULL CHECK (power_state IN ('active', 'low_power', 'sleep', 'offline')),
  battery_pct INTEGER,
  is_charging INTEGER NOT NULL DEFAULT 0,
  wol_mac_address TEXT,
  last_state_change TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES device_keys(device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_power_lookup
  ON device_power_states(tenant, power_state);

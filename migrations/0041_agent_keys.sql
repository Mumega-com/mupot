-- 0041 — Ed25519 signed-attach: per-agent public keys + replay-nonce ledger.
--
-- "Agent running on mupot" cutover (Step 2b, signed variant). The runtime proves
-- identity by SIGNING the attach with a host-held Ed25519 private key; mupot stores
-- ONLY the PUBLIC key and verifies. No bearer secret is transported or placed.
--
-- Sterile: no tenant is hardcoded. Rows are written per (tenant, agent_id) with the
-- tenant supplied at registration time (env.TENANT_SLUG on this pot).

-- Public keys, one per (tenant, agent_id). pubkey = base64url Ed25519 JWK 'x' coord.
CREATE TABLE IF NOT EXISTS agent_keys (
  tenant     TEXT    NOT NULL,
  agent_id   TEXT    NOT NULL,
  pubkey     TEXT    NOT NULL,                 -- base64url x-coordinate (JWK 'x')
  algo       TEXT    NOT NULL DEFAULT 'Ed25519',
  member_id  TEXT,                             -- mupot member this key authenticates AS
                                               -- (the identity binding; set at registration,
                                               -- the Hadi-gated moment). NULL = unbound key.
  created_at INTEGER NOT NULL,                 -- unix seconds
  PRIMARY KEY (tenant, agent_id)
);

-- Single-use nonce ledger for replay protection. A signed attach is accepted at most
-- once: the (verified) nonce is burned here via INSERT OR IGNORE; a duplicate burns
-- nothing (changes=0) and the request is rejected as a replay. Rows older than the
-- signature freshness window are pruned opportunistically. nonce is the PK so the
-- uniqueness check is atomic at the storage layer.
CREATE TABLE IF NOT EXISTS agent_attach_nonces (
  nonce      TEXT    NOT NULL PRIMARY KEY,
  agent_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL                  -- unix seconds (server receipt time)
);

CREATE INDEX IF NOT EXISTS idx_attach_nonces_created ON agent_attach_nonces (created_at);

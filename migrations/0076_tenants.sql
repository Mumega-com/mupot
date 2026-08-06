-- 0076_tenants.sql — Federated Sovereign Control Plane Phase 1 registry.
--
-- Design: docs/superpowers/specs/2026-07-29-federated-sovereign-control-plane-design.md
-- Epic: #618. Phase 0 ADR landed in #629.
--
-- Additive-only central registry: metadata and secret-store REFERENCES only.
-- Zero tenant business data. Zero credentials (phase0-registry-zero-credentials).
-- broker_token_ref is a secret-store URI/reference, never a raw API token value.
-- Capability carriers (deploy-write / observe-read / break-glass) stay in the
-- vault; this table only points at them. No seed rows — empty on apply.

CREATE TABLE IF NOT EXISTS tenants (
  id                   TEXT NOT NULL PRIMARY KEY
                       CHECK (length(id) BETWEEN 1 AND 64),
  cf_account_id        TEXT NOT NULL UNIQUE
                       CHECK (
                         length(cf_account_id) = 32
                         AND cf_account_id = lower(cf_account_id)
                         AND cf_account_id NOT GLOB '*[^0-9a-f]*'
                       ),
  -- Secret-store reference only (scheme:path). Rejects bearer/JWT-shaped material.
  broker_token_ref     TEXT
                       CHECK (
                         broker_token_ref IS NULL
                         OR (
                           length(broker_token_ref) BETWEEN 3 AND 256
                           AND instr(broker_token_ref, ':') > 1
                           AND lower(broker_token_ref) NOT LIKE 'bearer %'
                           AND lower(broker_token_ref) NOT LIKE 'bearer:%'
                           AND broker_token_ref NOT LIKE 'eyJ%'
                         )
                       ),
  -- Observed worker URL metadata for health/drift. https only; app layer still
  -- revalidates connect-address before any fetch (phase1-health-target-ssrf-*).
  deployed_worker_url  TEXT
                       CHECK (
                         deployed_worker_url IS NULL
                         OR (
                           length(deployed_worker_url) BETWEEN 12 AND 2048
                           AND deployed_worker_url LIKE 'https://%'
                           AND deployed_worker_url NOT LIKE 'https://%@%'
                         )
                       ),
  health_status        TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (
                         health_status IN (
                           'unknown', 'healthy', 'degraded', 'unhealthy', 'drift'
                         )
                       ),
  last_deploy_sha      TEXT
                       CHECK (
                         last_deploy_sha IS NULL
                         OR (
                           length(last_deploy_sha) BETWEEN 7 AND 40
                           AND last_deploy_sha = lower(last_deploy_sha)
                           AND last_deploy_sha NOT GLOB '*[^0-9a-f]*'
                         )
                       )
);

CREATE INDEX IF NOT EXISTS idx_tenants_health_status
  ON tenants (health_status);

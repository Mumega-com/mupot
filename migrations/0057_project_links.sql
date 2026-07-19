-- 0057_project_links.sql — sovereign, signed project-to-project collaboration.

CREATE TABLE IF NOT EXISTS project_links (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  local_project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  local_squad_id        TEXT NOT NULL REFERENCES squads(id) ON DELETE RESTRICT,
  local_agent_id        TEXT NOT NULL,
  local_key_id          TEXT NOT NULL,
  remote_pot            TEXT NOT NULL,
  remote_project_id     TEXT NOT NULL,
  remote_link_id        TEXT NOT NULL,
  remote_agent_id       TEXT NOT NULL,
  remote_key_id         TEXT NOT NULL,
  remote_public_key     TEXT NOT NULL,
  remote_base_url       TEXT NOT NULL,
  capabilities_json     TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  evidence_origins_json TEXT NOT NULL CHECK (json_valid(evidence_origins_json) AND json_type(evidence_origins_json) = 'array'),
  state                 TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
  stale_after_seconds   INTEGER NOT NULL DEFAULT 300
                        CHECK (stale_after_seconds BETWEEN 30 AND 86400),
  last_success_at       TEXT,
  last_failure_at       TEXT,
  last_error            TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  revoked_by            TEXT,
  revoked_at            TEXT,
  UNIQUE (tenant, local_project_id, remote_pot, remote_project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_links_project
  ON project_links(tenant, local_project_id, state);

CREATE TABLE IF NOT EXISTS project_link_deliveries (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  link_id               TEXT NOT NULL REFERENCES project_links(id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  idempotency_key       TEXT NOT NULL,
  envelope_sha256       TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','failed','review')),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  claim_token           TEXT,
  claim_expires_at      TEXT,
  next_retry_at         TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (tenant, link_id, direction, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_project_link_deliveries_status
  ON project_link_deliveries(tenant, status, next_retry_at);

CREATE TABLE IF NOT EXISTS project_link_receipts (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  link_id               TEXT NOT NULL REFERENCES project_links(id) ON DELETE RESTRICT,
  local_project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  idempotency_key       TEXT NOT NULL,
  correlation_id        TEXT NOT NULL,
  envelope_sha256       TEXT NOT NULL,
  shared_receipt_sha256 TEXT NOT NULL,
  remote_pot            TEXT NOT NULL,
  remote_project_id     TEXT NOT NULL,
  source_agent_id       TEXT NOT NULL,
  action_type           TEXT NOT NULL CHECK (action_type IN ('task','evidence')),
  action_id             TEXT NOT NULL,
  evidence_sha256       TEXT,
  receipt_key_id        TEXT NOT NULL,
  receipt_signature     TEXT NOT NULL,
  delivery_claim_token  TEXT,
  status                TEXT NOT NULL DEFAULT 'accepted' CHECK (status = 'accepted'),
  created_at            TEXT NOT NULL,
  UNIQUE (tenant, link_id, direction, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_project_link_receipts_project
  ON project_link_receipts(tenant, local_project_id, created_at DESC, id DESC);

-- The receipt is the last statement in each atomic delivery batch. Re-checking
-- authority here closes the gap between application reads and the committed write.
CREATE TRIGGER IF NOT EXISTS trg_project_link_receipt_authorized
BEFORE INSERT ON project_link_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_link_not_authorized') WHERE NOT EXISTS (
    SELECT 1
      FROM project_links l
      JOIN projects p ON p.id = l.local_project_id
      JOIN project_squad_access a
        ON a.project_id = l.local_project_id AND a.squad_id = l.local_squad_id
     WHERE l.tenant = NEW.tenant
       AND l.id = NEW.link_id
       AND l.local_project_id = NEW.local_project_id
       AND l.state = 'active'
       AND p.status <> 'archived'
       AND a.access_level IN ('write', 'admin')
       AND EXISTS (
         SELECT 1 FROM json_each(l.capabilities_json)
          WHERE value = CASE NEW.action_type
            WHEN 'task' THEN 'project.task.write'
            ELSE 'project.evidence.write'
          END
       )
       AND (
         SELECT state FROM addon_installations
          WHERE tenant = NEW.tenant AND addon_key = 'project-link'
          ORDER BY installed_at DESC, id DESC LIMIT 1
       ) = 'active'
       AND (
         NEW.direction <> 'outbound'
         OR EXISTS (
           SELECT 1 FROM project_link_deliveries d
            WHERE d.tenant = NEW.tenant
              AND d.link_id = NEW.link_id
              AND d.direction = 'outbound'
              AND d.idempotency_key = NEW.idempotency_key
              AND d.envelope_sha256 = NEW.envelope_sha256
              AND d.status = 'delivered'
              AND d.claim_token = NEW.delivery_claim_token
         )
       )
  );
END;

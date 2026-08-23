-- Exact runtime seats, immutable process generations, fenced leases, and public attestations.
-- No credential value or private signing material is stored in these tables.

CREATE TABLE runtime_seats (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  seat_name TEXT NOT NULL CHECK (length(trim(seat_name)) BETWEEN 1 AND 160),
  host_id TEXT NOT NULL CHECK (length(trim(host_id)) BETWEEN 1 AND 255),
  adapter_kind TEXT NOT NULL CHECK (length(trim(adapter_kind)) BETWEEN 1 AND 120),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked')),
  current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
  current_fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (current_fencing_epoch >= 0),
  process_public_key TEXT,
  credential_fingerprint TEXT
    CHECK (
      credential_fingerprint IS NULL
      OR (
        length(credential_fingerprint) = 67
        AND substr(credential_fingerprint, 1, 3) = 'v1:'
        AND substr(credential_fingerprint, 4) = lower(substr(credential_fingerprint, 4))
        AND substr(credential_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
      )
    ),
  capabilities_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  last_heartbeat_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  CHECK (state <> 'pending' OR current_generation = 0),
  CHECK (state <> 'pending' OR current_fencing_epoch = 0),
  CHECK (state <> 'revoked' OR revoked_at IS NOT NULL),
  UNIQUE (tenant, agent_id, seat_name)
);

CREATE INDEX idx_runtime_seats_agent_state
  ON runtime_seats(tenant, agent_id, state);
CREATE INDEX idx_runtime_seats_host_state
  ON runtime_seats(tenant, host_id, state);

CREATE TABLE runtime_seat_generations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  host_id TEXT NOT NULL CHECK (length(trim(host_id)) > 0),
  process_id TEXT NOT NULL CHECK (length(trim(process_id)) > 0),
  process_uid TEXT NOT NULL CHECK (length(trim(process_uid)) > 0),
  sandbox_id TEXT NOT NULL CHECK (length(trim(sandbox_id)) > 0),
  executable_digest TEXT NOT NULL
    CHECK (
      length(executable_digest) = 64
      AND executable_digest = lower(executable_digest)
      AND executable_digest NOT GLOB '*[^0-9a-f]*'
    ),
  public_key TEXT NOT NULL CHECK (length(trim(public_key)) > 0),
  broker_attestation_digest TEXT NOT NULL
    CHECK (
      length(broker_attestation_digest) = 64
      AND broker_attestation_digest = lower(broker_attestation_digest)
      AND broker_attestation_digest NOT GLOB '*[^0-9a-f]*'
    ),
  credential_fingerprint TEXT
    CHECK (
      credential_fingerprint IS NULL
      OR (
        length(credential_fingerprint) = 67
        AND substr(credential_fingerprint, 1, 3) = 'v1:'
        AND substr(credential_fingerprint, 4) = lower(substr(credential_fingerprint, 4))
        AND substr(credential_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
      )
    ),
  started_at TEXT NOT NULL CHECK (length(trim(started_at)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, runtime_seat_id, generation)
);

CREATE TABLE runtime_seat_leases (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  consumer_id TEXT NOT NULL CHECK (length(trim(consumer_id)) > 0),
  lease_token_hash TEXT NOT NULL
    CHECK (
      length(lease_token_hash) = 64
      AND lease_token_hash = lower(lease_token_hash)
      AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','released','expired','revoked')),
  leased_at TEXT NOT NULL CHECK (length(trim(leased_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  renewed_at TEXT,
  released_at TEXT,
  UNIQUE (tenant, runtime_seat_id, fencing_epoch),
  FOREIGN KEY (tenant, runtime_seat_id, generation)
    REFERENCES runtime_seat_generations(tenant, runtime_seat_id, generation)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_runtime_seat_leases_one_active
  ON runtime_seat_leases(tenant, runtime_seat_id)
  WHERE state = 'active';
CREATE INDEX idx_runtime_seat_leases_expiry
  ON runtime_seat_leases(tenant, state, expires_at);

CREATE TABLE token_binding_attestations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel = 'workspace'),
  credential_fingerprint TEXT NOT NULL
    CHECK (
      length(credential_fingerprint) = 67
      AND substr(credential_fingerprint, 1, 3) = 'v1:'
      AND substr(credential_fingerprint, 4) = lower(substr(credential_fingerprint, 4))
      AND substr(credential_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, token_id, channel)
);

CREATE TABLE seat_attestations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  token_binding_attestation_id TEXT NOT NULL
    REFERENCES token_binding_attestations(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  seat_state TEXT NOT NULL DEFAULT 'pending' CHECK (seat_state = 'pending'),
  seat_claim_digest TEXT NOT NULL
    CHECK (
      length(seat_claim_digest) = 64
      AND seat_claim_digest = lower(seat_claim_digest)
      AND seat_claim_digest NOT GLOB '*[^0-9a-f]*'
    ),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, runtime_seat_id)
);

CREATE TRIGGER token_binding_attestations_validate_identity
BEFORE INSERT ON token_binding_attestations
WHEN NOT EXISTS (
  SELECT 1
  FROM member_tokens token
  JOIN members member
    ON member.id = token.member_id
   AND member.tenant = token.tenant
  JOIN agents agent
    ON agent.id = token.agent_id
  JOIN agent_member_bindings binding
    ON binding.tenant = token.tenant
   AND binding.agent_id = token.agent_id
   AND binding.member_id = token.member_id
  WHERE token.id = NEW.token_id
    AND token.tenant = NEW.tenant
    AND token.member_id = NEW.member_id
    AND token.agent_id = NEW.agent_id
    AND token.channel = NEW.channel
    AND token.channel = 'workspace'
    AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR token.expires_at > NEW.issued_at)
    AND token.created_at <= NEW.issued_at
    AND member.status = 'active'
    AND agent.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'token binding identity mismatch');
END;

CREATE TRIGGER seat_attestations_validate_identity
BEFORE INSERT ON seat_attestations
WHEN NOT EXISTS (
  SELECT 1
  FROM token_binding_attestations attestation
  JOIN member_tokens token
    ON token.id = attestation.token_id
   AND token.tenant = attestation.tenant
   AND token.member_id = attestation.member_id
   AND token.agent_id = attestation.agent_id
   AND token.channel = attestation.channel
  JOIN members member
    ON member.id = attestation.member_id
   AND member.tenant = attestation.tenant
  JOIN agents agent
    ON agent.id = attestation.agent_id
  JOIN runtime_seats seat
    ON seat.id = NEW.runtime_seat_id
   AND seat.tenant = attestation.tenant
   AND seat.agent_id = attestation.agent_id
  WHERE attestation.id = NEW.token_binding_attestation_id
    AND attestation.tenant = NEW.tenant
    AND attestation.member_id = NEW.member_id
    AND attestation.agent_id = NEW.agent_id
    AND attestation.channel = 'workspace'
    AND attestation.issued_at <= NEW.issued_at
    AND (attestation.expires_at IS NULL OR attestation.expires_at > NEW.issued_at)
    AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR token.expires_at > NEW.issued_at)
    AND member.status = 'active'
    AND agent.status = 'active'
    AND seat.state = 'pending'
    AND NEW.seat_state = seat.state
)
BEGIN
  SELECT RAISE(ABORT, 'seat attestation identity mismatch');
END;

CREATE TRIGGER runtime_seats_identity_immutable
BEFORE UPDATE OF id, tenant, agent_id, seat_name, host_id, adapter_kind, created_at
ON runtime_seats
BEGIN
  SELECT RAISE(ABORT, 'runtime seat identity is immutable');
END;

CREATE TRIGGER runtime_seats_generation_monotonic
BEFORE UPDATE OF current_generation ON runtime_seats
WHEN NEW.current_generation < OLD.current_generation
BEGIN
  SELECT RAISE(ABORT, 'runtime seat generation must be monotonic');
END;

CREATE TRIGGER runtime_seats_fencing_monotonic
BEFORE UPDATE OF current_fencing_epoch ON runtime_seats
WHEN NEW.current_fencing_epoch < OLD.current_fencing_epoch
BEGIN
  SELECT RAISE(ABORT, 'runtime seat fencing epoch must be monotonic');
END;

CREATE TRIGGER runtime_seats_no_delete
BEFORE DELETE ON runtime_seats
BEGIN
  SELECT RAISE(ABORT, 'runtime seats cannot be deleted');
END;

CREATE TRIGGER runtime_seat_generations_no_update
BEFORE UPDATE ON runtime_seat_generations
BEGIN
  SELECT RAISE(ABORT, 'runtime seat generations are immutable');
END;

CREATE TRIGGER runtime_seat_generations_no_delete
BEFORE DELETE ON runtime_seat_generations
BEGIN
  SELECT RAISE(ABORT, 'runtime seat generations are immutable');
END;

CREATE TRIGGER runtime_seat_leases_require_current_generation
BEFORE INSERT ON runtime_seat_leases
WHEN NEW.generation > 0
 AND NEW.fencing_epoch > 0
 AND NOT EXISTS (
  SELECT 1
  FROM runtime_seats seat
  JOIN runtime_seat_generations generation
    ON generation.tenant = seat.tenant
   AND generation.runtime_seat_id = seat.id
   AND generation.generation = NEW.generation
  WHERE seat.id = NEW.runtime_seat_id
    AND seat.tenant = NEW.tenant
    AND seat.state = 'active'
    AND seat.current_generation = NEW.generation
    AND NEW.fencing_epoch > seat.current_fencing_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'runtime seat generation is not current and active');
END;

CREATE TRIGGER runtime_seat_leases_monotonic_insert
BEFORE INSERT ON runtime_seat_leases
WHEN EXISTS (
  SELECT 1
  FROM runtime_seat_leases
  WHERE tenant = NEW.tenant
    AND runtime_seat_id = NEW.runtime_seat_id
    AND fencing_epoch >= NEW.fencing_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'runtime seat fencing epoch must be positive and monotonic');
END;

CREATE TRIGGER runtime_seat_leases_identity_immutable
BEFORE UPDATE OF id, tenant, runtime_seat_id, generation, fencing_epoch,
  consumer_id, lease_token_hash, leased_at
ON runtime_seat_leases
BEGIN
  SELECT RAISE(ABORT, 'runtime seat lease identity is immutable');
END;

CREATE TRIGGER runtime_seat_leases_valid_transition
BEFORE UPDATE OF state ON runtime_seat_leases
WHEN OLD.state <> 'active' OR NEW.state NOT IN ('released','expired','revoked')
BEGIN
  SELECT RAISE(ABORT, 'runtime seat lease transition is invalid');
END;

CREATE TRIGGER runtime_seat_leases_active_renewal_only
BEFORE UPDATE OF expires_at, renewed_at ON runtime_seat_leases
WHEN OLD.state <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'only active runtime seat leases can renew');
END;

CREATE TRIGGER runtime_seat_leases_no_delete
BEFORE DELETE ON runtime_seat_leases
BEGIN
  SELECT RAISE(ABORT, 'runtime seat leases cannot be deleted');
END;

CREATE TRIGGER token_binding_attestations_no_update
BEFORE UPDATE ON token_binding_attestations
BEGIN
  SELECT RAISE(ABORT, 'token binding attestations are immutable');
END;

CREATE TRIGGER token_binding_attestations_no_delete
BEFORE DELETE ON token_binding_attestations
BEGIN
  SELECT RAISE(ABORT, 'token binding attestations are immutable');
END;

CREATE TRIGGER seat_attestations_no_update
BEFORE UPDATE ON seat_attestations
BEGIN
  SELECT RAISE(ABORT, 'seat attestations are immutable');
END;

CREATE TRIGGER seat_attestations_no_delete
BEFORE DELETE ON seat_attestations
BEGIN
  SELECT RAISE(ABORT, 'seat attestations are immutable');
END;

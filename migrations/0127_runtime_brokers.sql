-- Flight 3 runtime brokers, signer proof-of-possession, and immutable activation facts.
-- Public keys, digests, identifiers, and signatures only. Private keys and bearer values
-- are deliberately absent.

-- A zero-row guard target for compare-and-swap batches. A caller places
-- `INSERT INTO flight_spine_cas_abort(must_be_zero)
--  SELECT 1 WHERE changes() <> <expected>` immediately after its guarded DML.
-- A mismatched row count violates the CHECK and rolls back the whole D1 batch.
CREATE TABLE flight_spine_cas_abort (
  must_be_zero INTEGER NOT NULL CHECK (must_be_zero = 0)
);

CREATE TABLE runtime_signing_challenges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requested_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  requested_by_credential_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (domain IN (
    'mupot-runtime-broker-register:v1',
    'mupot-delivery-authority-register:v1',
    'mupot-runtime-signer-register:v1',
    'mupot-runtime-generation-runtime-proof:v1',
    'mupot-runtime-generation-activate:v1',
    'mupot-fenced-delivery-lease:v1',
    'mupot-fenced-delivery-evidence:v1'
  )),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'broker','ingress','adapter','runtime','provider_verifier'
  )),
  authority_id TEXT,
  resource_id TEXT NOT NULL CHECK (length(trim(resource_id)) BETWEEN 1 AND 255),
  nonce TEXT NOT NULL CHECK (length(trim(nonce)) BETWEEN 16 AND 255),
  signable_payload_template TEXT NOT NULL
    CHECK (length(signable_payload_template) BETWEEN 1 AND 8000),
  signable_payload_digest TEXT NOT NULL
    CHECK (
      length(signable_payload_digest) = 64
      AND signable_payload_digest = lower(signable_payload_digest)
      AND signable_payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  consumed_at TEXT,
  consumed_request_digest TEXT
    CHECK (
      consumed_request_digest IS NULL
      OR (
        length(consumed_request_digest) = 64
        AND consumed_request_digest = lower(consumed_request_digest)
        AND consumed_request_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (
    (consumed_at IS NULL AND consumed_request_digest IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_request_digest IS NOT NULL)
  ),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  CHECK (julianday(expires_at) <= julianday(issued_at, '+60 seconds')),
  UNIQUE (tenant, domain, nonce)
);

CREATE UNIQUE INDEX idx_runtime_signing_challenges_one_live
  ON runtime_signing_challenges(
    tenant, domain, authority_kind, ifnull(authority_id, ''), resource_id
  )
  WHERE consumed_at IS NULL;

CREATE TABLE runtime_brokers (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  host_id TEXT NOT NULL CHECK (length(trim(host_id)) BETWEEN 1 AND 255),
  public_key TEXT NOT NULL CHECK (length(trim(public_key)) BETWEEN 1 AND 4000),
  key_fingerprint TEXT NOT NULL
    CHECK (
      length(key_fingerprint) = 67
      AND substr(key_fingerprint, 1, 3) = 'v1:'
      AND substr(key_fingerprint, 4) = lower(substr(key_fingerprint, 4))
      AND substr(key_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  registration_digest TEXT NOT NULL
    CHECK (
      length(registration_digest) = 64
      AND registration_digest = lower(registration_digest)
      AND registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  registered_at TEXT NOT NULL CHECK (length(trim(registered_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (state <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (julianday(expires_at) > julianday(registered_at)),
  UNIQUE (tenant, key_fingerprint),
  UNIQUE (tenant, registration_digest)
);

CREATE UNIQUE INDEX idx_runtime_brokers_one_active_host
  ON runtime_brokers(tenant, host_id)
  WHERE state = 'active';

CREATE TABLE runtime_delivery_authorities (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  broker_id TEXT NOT NULL REFERENCES runtime_brokers(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'ingress','adapter','provider_verifier'
  )),
  public_key TEXT NOT NULL CHECK (length(trim(public_key)) BETWEEN 1 AND 4000),
  key_fingerprint TEXT NOT NULL
    CHECK (
      length(key_fingerprint) = 67
      AND substr(key_fingerprint, 1, 3) = 'v1:'
      AND substr(key_fingerprint, 4) = lower(substr(key_fingerprint, 4))
      AND substr(key_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  proof_of_possession_digest TEXT NOT NULL
    CHECK (
      length(proof_of_possession_digest) = 64
      AND proof_of_possession_digest = lower(proof_of_possession_digest)
      AND proof_of_possession_digest NOT GLOB '*[^0-9a-f]*'
    ),
  proof_of_possession_signature TEXT NOT NULL
    CHECK (length(trim(proof_of_possession_signature)) BETWEEN 1 AND 8000),
  canonical_payload TEXT NOT NULL
    CHECK (length(canonical_payload) BETWEEN 1 AND 8000),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  registration_digest TEXT NOT NULL
    CHECK (
      length(registration_digest) = 64
      AND registration_digest = lower(registration_digest)
      AND registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (state <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  UNIQUE (tenant, runtime_seat_id, generation, authority_kind),
  UNIQUE (tenant, key_fingerprint),
  UNIQUE (tenant, registration_digest)
);

CREATE TABLE runtime_signer_registrations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  broker_id TEXT NOT NULL REFERENCES runtime_brokers(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  signing_public_key TEXT NOT NULL
    CHECK (length(trim(signing_public_key)) BETWEEN 1 AND 4000),
  encryption_public_key TEXT NOT NULL
    CHECK (length(trim(encryption_public_key)) BETWEEN 1 AND 8000),
  signing_key_fingerprint TEXT NOT NULL
    CHECK (
      length(signing_key_fingerprint) = 67
      AND substr(signing_key_fingerprint, 1, 3) = 'v1:'
      AND substr(signing_key_fingerprint, 4) = lower(substr(signing_key_fingerprint, 4))
      AND substr(signing_key_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  encryption_key_fingerprint TEXT NOT NULL
    CHECK (
      length(encryption_key_fingerprint) = 67
      AND substr(encryption_key_fingerprint, 1, 3) = 'v1:'
      AND substr(encryption_key_fingerprint, 4) = lower(substr(encryption_key_fingerprint, 4))
      AND substr(encryption_key_fingerprint, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  proof_of_possession_digest TEXT NOT NULL
    CHECK (
      length(proof_of_possession_digest) = 64
      AND proof_of_possession_digest = lower(proof_of_possession_digest)
      AND proof_of_possession_digest NOT GLOB '*[^0-9a-f]*'
    ),
  proof_of_possession_signature TEXT NOT NULL
    CHECK (length(trim(proof_of_possession_signature)) BETWEEN 1 AND 8000),
  canonical_payload TEXT NOT NULL
    CHECK (length(canonical_payload) BETWEEN 1 AND 8000),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  registration_digest TEXT NOT NULL
    CHECK (
      length(registration_digest) = 64
      AND registration_digest = lower(registration_digest)
      AND registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (signing_key_fingerprint <> encryption_key_fingerprint),
  CHECK (state <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  UNIQUE (tenant, runtime_seat_id, generation),
  UNIQUE (tenant, signing_key_fingerprint),
  UNIQUE (tenant, encryption_key_fingerprint),
  UNIQUE (tenant, registration_digest)
);

CREATE TABLE runtime_signed_request_replays (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN (
    'mupot-runtime-broker-register:v1',
    'mupot-delivery-authority-register:v1',
    'mupot-runtime-signer-register:v1',
    'mupot-runtime-generation-runtime-proof:v1',
    'mupot-runtime-generation-activate:v1',
    'mupot-fenced-delivery-lease:v1',
    'mupot-fenced-delivery-evidence:v1'
  )),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'broker','ingress','adapter','runtime','provider_verifier'
  )),
  authority_id TEXT,
  nonce TEXT NOT NULL CHECK (length(trim(nonce)) BETWEEN 16 AND 255),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  canonical_payload_digest TEXT NOT NULL
    CHECK (
      length(canonical_payload_digest) = 64
      AND canonical_payload_digest = lower(canonical_payload_digest)
      AND canonical_payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  result_kind TEXT NOT NULL CHECK (length(trim(result_kind)) BETWEEN 1 AND 120),
  result_id TEXT NOT NULL CHECK (length(trim(result_id)) BETWEEN 1 AND 255),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  CHECK (julianday(expires_at) <= julianday(issued_at, '+60 seconds')),
  UNIQUE (tenant, domain, nonce),
  UNIQUE (tenant, challenge_id)
);

CREATE TABLE runtime_broker_attestations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  broker_id TEXT NOT NULL REFERENCES runtime_brokers(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  host_id TEXT NOT NULL CHECK (length(trim(host_id)) > 0),
  process_id TEXT NOT NULL CHECK (length(trim(process_id)) > 0),
  launcher_process_id TEXT NOT NULL CHECK (length(trim(launcher_process_id)) > 0),
  broker_uid TEXT NOT NULL CHECK (length(trim(broker_uid)) > 0),
  adapter_uid TEXT NOT NULL CHECK (length(trim(adapter_uid)) > 0),
  provider_verifier_uid TEXT NOT NULL CHECK (length(trim(provider_verifier_uid)) > 0),
  runtime_uid TEXT NOT NULL CHECK (length(trim(runtime_uid)) > 0),
  sandbox_id TEXT NOT NULL CHECK (length(trim(sandbox_id)) > 0),
  mount_namespace_id TEXT NOT NULL CHECK (length(trim(mount_namespace_id)) > 0),
  user_namespace_id TEXT NOT NULL CHECK (length(trim(user_namespace_id)) > 0),
  cgroup_id TEXT NOT NULL CHECK (length(trim(cgroup_id)) > 0),
  executable_digest TEXT NOT NULL
    CHECK (
      length(executable_digest) = 64
      AND executable_digest = lower(executable_digest)
      AND executable_digest NOT GLOB '*[^0-9a-f]*'
    ),
  ingress_authority_registration_id TEXT NOT NULL
    REFERENCES runtime_delivery_authorities(id) ON DELETE RESTRICT,
  ingress_authority_registration_digest TEXT NOT NULL
    CHECK (
      length(ingress_authority_registration_digest) = 64
      AND ingress_authority_registration_digest =
        lower(ingress_authority_registration_digest)
      AND ingress_authority_registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  adapter_authority_registration_id TEXT NOT NULL
    REFERENCES runtime_delivery_authorities(id) ON DELETE RESTRICT,
  adapter_authority_registration_digest TEXT NOT NULL
    CHECK (
      length(adapter_authority_registration_digest) = 64
      AND adapter_authority_registration_digest =
        lower(adapter_authority_registration_digest)
      AND adapter_authority_registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  provider_verifier_authority_registration_id TEXT NOT NULL
    REFERENCES runtime_delivery_authorities(id) ON DELETE RESTRICT,
  provider_verifier_authority_registration_digest TEXT NOT NULL
    CHECK (
      length(provider_verifier_authority_registration_digest) = 64
      AND provider_verifier_authority_registration_digest =
        lower(provider_verifier_authority_registration_digest)
      AND provider_verifier_authority_registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_signer_registration_id TEXT NOT NULL
    REFERENCES runtime_signer_registrations(id) ON DELETE RESTRICT,
  runtime_signer_registration_digest TEXT NOT NULL
    CHECK (
      length(runtime_signer_registration_digest) = 64
      AND runtime_signer_registration_digest = lower(runtime_signer_registration_digest)
      AND runtime_signer_registration_digest NOT GLOB '*[^0-9a-f]*'
    ),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  challenge_nonce_digest TEXT NOT NULL
    CHECK (
      length(challenge_nonce_digest) = 64
      AND challenge_nonce_digest = lower(challenge_nonce_digest)
      AND challenge_nonce_digest NOT GLOB '*[^0-9a-f]*'
    ),
  challenge_signature TEXT NOT NULL CHECK (length(trim(challenge_signature)) > 0),
  launcher_capability_digest TEXT NOT NULL
    CHECK (
      length(launcher_capability_digest) = 64
      AND launcher_capability_digest = lower(launcher_capability_digest)
      AND launcher_capability_digest NOT GLOB '*[^0-9a-f]*'
    ),
  launcher_seccomp_digest TEXT NOT NULL
    CHECK (
      length(launcher_seccomp_digest) = 64
      AND launcher_seccomp_digest = lower(launcher_seccomp_digest)
      AND launcher_seccomp_digest NOT GLOB '*[^0-9a-f]*'
    ),
  launcher_service_policy_digest TEXT NOT NULL
    CHECK (
      length(launcher_service_policy_digest) = 64
      AND launcher_service_policy_digest = lower(launcher_service_policy_digest)
      AND launcher_service_policy_digest NOT GLOB '*[^0-9a-f]*'
    ),
  post_exec_no_new_privs INTEGER NOT NULL CHECK (post_exec_no_new_privs = 1),
  post_exec_effective_capabilities TEXT NOT NULL
    CHECK (post_exec_effective_capabilities = '0000000000000000'),
  post_exec_seccomp_mode INTEGER NOT NULL CHECK (post_exec_seccomp_mode = 2),
  broker_runtime_namespace_visible INTEGER NOT NULL
    CHECK (broker_runtime_namespace_visible = 0),
  adapter_runtime_namespace_visible INTEGER NOT NULL
    CHECK (adapter_runtime_namespace_visible = 0),
  launcher_runtime_namespace_visible_after_exec INTEGER NOT NULL
    CHECK (launcher_runtime_namespace_visible_after_exec = 0),
  canonical_payload_digest TEXT NOT NULL
    CHECK (
      length(canonical_payload_digest) = 64
      AND canonical_payload_digest = lower(canonical_payload_digest)
      AND canonical_payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  signature TEXT NOT NULL CHECK (length(trim(signature)) > 0),
  signed_at TEXT NOT NULL CHECK (length(trim(signed_at)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (
    broker_uid <> adapter_uid
    AND broker_uid <> provider_verifier_uid
    AND broker_uid <> runtime_uid
    AND adapter_uid <> provider_verifier_uid
    AND adapter_uid <> runtime_uid
    AND provider_verifier_uid <> runtime_uid
  ),
  UNIQUE (tenant, runtime_seat_id, generation),
  UNIQUE (tenant, canonical_payload_digest)
);

CREATE TRIGGER runtime_signing_challenges_identity_immutable
BEFORE UPDATE OF id, tenant, requested_by_agent_id, requested_by_member_id,
  requested_by_credential_id, domain, authority_kind,
  authority_id, resource_id, nonce, signable_payload_template,
  signable_payload_digest, issued_at, expires_at, created_at
ON runtime_signing_challenges
BEGIN
  SELECT RAISE(ABORT, 'runtime signing challenge is immutable');
END;

CREATE TRIGGER runtime_signing_challenges_consume_once
BEFORE UPDATE OF consumed_at, consumed_request_digest ON runtime_signing_challenges
WHEN OLD.consumed_at IS NOT NULL
  OR NEW.consumed_at IS NULL
  OR NEW.consumed_request_digest IS NULL
BEGIN
  SELECT RAISE(ABORT, 'runtime signing challenge consumption is invalid');
END;

CREATE TRIGGER runtime_signing_challenges_no_delete
BEFORE DELETE ON runtime_signing_challenges
BEGIN
  SELECT RAISE(ABORT, 'runtime signing challenge is immutable');
END;

CREATE TRIGGER runtime_brokers_identity_immutable
BEFORE UPDATE OF id, tenant, agent_id, member_id, credential_id, host_id,
  public_key, key_fingerprint, registration_digest, challenge_id,
  registered_at, expires_at, created_at
ON runtime_brokers
BEGIN
  SELECT RAISE(ABORT, 'runtime broker is immutable');
END;

CREATE TRIGGER runtime_brokers_lifecycle
BEFORE UPDATE OF state, revoked_at ON runtime_brokers
WHEN OLD.state <> 'active' OR NEW.state <> 'revoked' OR NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'runtime broker transition is invalid');
END;

CREATE TRIGGER runtime_brokers_no_delete
BEFORE DELETE ON runtime_brokers
BEGIN
  SELECT RAISE(ABORT, 'runtime broker is immutable');
END;

CREATE TRIGGER runtime_delivery_authorities_identity_immutable
BEFORE UPDATE OF id, tenant, broker_id, runtime_seat_id, generation,
  authority_kind, public_key, key_fingerprint, proof_of_possession_digest,
  proof_of_possession_signature, canonical_payload, challenge_id,
  registration_digest, issued_at, expires_at, created_at
ON runtime_delivery_authorities
BEGIN
  SELECT RAISE(ABORT, 'runtime delivery authority is immutable');
END;

CREATE TRIGGER runtime_delivery_authorities_lifecycle
BEFORE UPDATE OF state, revoked_at ON runtime_delivery_authorities
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('active','revoked'))
  OR (OLD.state = 'active' AND NEW.state = 'revoked')
)
OR (NEW.state = 'revoked' AND NEW.revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runtime delivery authority transition is invalid');
END;

CREATE TRIGGER runtime_delivery_authorities_no_delete
BEFORE DELETE ON runtime_delivery_authorities
BEGIN
  SELECT RAISE(ABORT, 'runtime delivery authority is immutable');
END;

CREATE TRIGGER runtime_signer_registrations_identity_immutable
BEFORE UPDATE OF id, tenant, broker_id, runtime_seat_id, generation, signing_public_key,
  encryption_public_key, signing_key_fingerprint, encryption_key_fingerprint,
  proof_of_possession_digest, proof_of_possession_signature, canonical_payload,
  challenge_id, registration_digest, issued_at, expires_at, created_at
ON runtime_signer_registrations
BEGIN
  SELECT RAISE(ABORT, 'runtime signer registration is immutable');
END;

CREATE TRIGGER runtime_signer_registrations_lifecycle
BEFORE UPDATE OF state, revoked_at ON runtime_signer_registrations
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('active','revoked'))
  OR (OLD.state = 'active' AND NEW.state = 'revoked')
)
OR (NEW.state = 'revoked' AND NEW.revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runtime signer transition is invalid');
END;

CREATE TRIGGER runtime_signer_registrations_no_delete
BEFORE DELETE ON runtime_signer_registrations
BEGIN
  SELECT RAISE(ABORT, 'runtime signer registration is immutable');
END;

CREATE TRIGGER runtime_signed_request_replays_no_update
BEFORE UPDATE ON runtime_signed_request_replays
BEGIN
  SELECT RAISE(ABORT, 'signed request replay is immutable');
END;

CREATE TRIGGER runtime_signed_request_replays_no_delete
BEFORE DELETE ON runtime_signed_request_replays
BEGIN
  SELECT RAISE(ABORT, 'signed request replay is immutable');
END;

CREATE TRIGGER runtime_broker_attestations_no_update
BEFORE UPDATE ON runtime_broker_attestations
BEGIN
  SELECT RAISE(ABORT, 'runtime broker attestation is immutable');
END;

CREATE TRIGGER runtime_broker_attestations_validate_registrations
BEFORE INSERT ON runtime_broker_attestations
WHEN NOT EXISTS (
  SELECT 1
    FROM runtime_brokers broker
    JOIN runtime_seats seat
      ON seat.id = NEW.runtime_seat_id
     AND seat.tenant = broker.tenant
    JOIN runtime_delivery_authorities ingress
      ON ingress.id = NEW.ingress_authority_registration_id
     AND ingress.tenant = broker.tenant
     AND ingress.broker_id = broker.id
     AND ingress.runtime_seat_id = seat.id
     AND ingress.generation = NEW.generation
     AND ingress.authority_kind = 'ingress'
    JOIN runtime_delivery_authorities adapter
      ON adapter.id = NEW.adapter_authority_registration_id
     AND adapter.tenant = broker.tenant
     AND adapter.broker_id = broker.id
     AND adapter.runtime_seat_id = seat.id
     AND adapter.generation = NEW.generation
     AND adapter.authority_kind = 'adapter'
    JOIN runtime_delivery_authorities provider
      ON provider.id = NEW.provider_verifier_authority_registration_id
     AND provider.tenant = broker.tenant
     AND provider.broker_id = broker.id
     AND provider.runtime_seat_id = seat.id
     AND provider.generation = NEW.generation
     AND provider.authority_kind = 'provider_verifier'
    JOIN runtime_signer_registrations signer
      ON signer.id = NEW.runtime_signer_registration_id
     AND signer.tenant = broker.tenant
     AND signer.broker_id = broker.id
     AND signer.runtime_seat_id = seat.id
     AND signer.generation = NEW.generation
    JOIN runtime_signing_challenges challenge
      ON challenge.id = NEW.challenge_id
     AND challenge.tenant = broker.tenant
     AND challenge.domain = 'mupot-runtime-generation-activate:v1'
     AND challenge.authority_kind = 'broker'
     AND challenge.authority_id = broker.id
   WHERE broker.id = NEW.broker_id
     AND broker.tenant = NEW.tenant
     AND broker.host_id = NEW.host_id
     AND broker.state = 'active'
     AND seat.host_id = NEW.host_id
     AND ingress.registration_digest =
       NEW.ingress_authority_registration_digest
     AND adapter.registration_digest =
       NEW.adapter_authority_registration_digest
     AND provider.registration_digest =
       NEW.provider_verifier_authority_registration_digest
     AND signer.registration_digest = NEW.runtime_signer_registration_digest
     AND ingress.state = 'active'
     AND adapter.state = 'active'
     AND provider.state = 'active'
     AND signer.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'runtime broker attestation registration mismatch');
END;

CREATE TRIGGER runtime_broker_attestations_no_delete
BEFORE DELETE ON runtime_broker_attestations
BEGIN
  SELECT RAISE(ABORT, 'runtime broker attestation is immutable');
END;

CREATE TRIGGER runtime_delivery_authorities_key_separation
BEFORE INSERT ON runtime_delivery_authorities
WHEN EXISTS (
  SELECT 1 FROM runtime_brokers
   WHERE tenant = NEW.tenant AND key_fingerprint = NEW.key_fingerprint
)
OR EXISTS (
  SELECT 1 FROM runtime_signer_registrations
   WHERE tenant = NEW.tenant
     AND NEW.key_fingerprint IN (
       signing_key_fingerprint, encryption_key_fingerprint
     )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime authority key must be distinct');
END;

CREATE TRIGGER runtime_brokers_key_separation
BEFORE INSERT ON runtime_brokers
WHEN EXISTS (
  SELECT 1 FROM runtime_delivery_authorities
   WHERE tenant = NEW.tenant AND key_fingerprint = NEW.key_fingerprint
)
OR EXISTS (
  SELECT 1 FROM runtime_signer_registrations
   WHERE tenant = NEW.tenant
     AND NEW.key_fingerprint IN (
       signing_key_fingerprint, encryption_key_fingerprint
     )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime broker key must be distinct');
END;

CREATE TRIGGER runtime_signer_registrations_key_separation
BEFORE INSERT ON runtime_signer_registrations
WHEN EXISTS (
  SELECT 1 FROM runtime_brokers
   WHERE tenant = NEW.tenant
     AND key_fingerprint IN (
       NEW.signing_key_fingerprint, NEW.encryption_key_fingerprint
     )
)
OR EXISTS (
  SELECT 1 FROM runtime_delivery_authorities
   WHERE tenant = NEW.tenant
     AND key_fingerprint IN (
       NEW.signing_key_fingerprint, NEW.encryption_key_fingerprint
     )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime signer keys must be distinct');
END;

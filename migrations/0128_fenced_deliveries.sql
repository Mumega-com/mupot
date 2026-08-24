-- Flight 3 exact-seat fenced deliveries and encrypted local-envelope ingress receipts.
-- D1 stores only opaque references, public facts, signatures, and immutable digests.

CREATE TABLE encrypted_envelope_ingress_authorizations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  recipient_encryption_key_id TEXT NOT NULL
    REFERENCES runtime_signer_registrations(id) ON DELETE RESTRICT,
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_input_digest TEXT NOT NULL
    CHECK (
      length(runtime_input_digest) = 64
      AND runtime_input_digest = lower(runtime_input_digest)
      AND runtime_input_digest NOT GLOB '*[^0-9a-f]*'
    ),
  maximum_bytes INTEGER NOT NULL CHECK (maximum_bytes BETWEEN 1 AND 65536),
  upload_nonce TEXT NOT NULL CHECK (length(trim(upload_nonce)) BETWEEN 16 AND 255),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 255),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  consumed_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  CHECK (julianday(expires_at) <= julianday(issued_at, '+60 seconds')),
  UNIQUE (tenant, upload_nonce),
  UNIQUE (tenant, source_agent_id, idempotency_key)
);

CREATE TABLE host_envelope_ingress_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  authorization_id TEXT NOT NULL
    REFERENCES encrypted_envelope_ingress_authorizations(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  recipient_encryption_key_id TEXT NOT NULL
    REFERENCES runtime_signer_registrations(id) ON DELETE RESTRICT,
  envelope_ref TEXT NOT NULL
    CHECK (
      length(envelope_ref) = 86
      AND substr(envelope_ref, 1, 22) = 'local-envelope:sha256:'
      AND substr(envelope_ref, 23) = lower(substr(envelope_ref, 23))
      AND substr(envelope_ref, 23) NOT GLOB '*[^0-9a-f]*'
    ),
  ciphertext_digest TEXT NOT NULL
    CHECK (
      length(ciphertext_digest) = 64
      AND ciphertext_digest = lower(ciphertext_digest)
      AND ciphertext_digest NOT GLOB '*[^0-9a-f]*'
    ),
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_input_digest TEXT NOT NULL
    CHECK (
      length(runtime_input_digest) = 64
      AND runtime_input_digest = lower(runtime_input_digest)
      AND runtime_input_digest NOT GLOB '*[^0-9a-f]*'
    ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 65536),
  stored_at TEXT NOT NULL CHECK (length(trim(stored_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  host_authority_id TEXT NOT NULL
    REFERENCES runtime_delivery_authorities(id) ON DELETE RESTRICT,
  canonical_payload_digest TEXT NOT NULL
    CHECK (
      length(canonical_payload_digest) = 64
      AND canonical_payload_digest = lower(canonical_payload_digest)
      AND canonical_payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  signature TEXT NOT NULL CHECK (length(trim(signature)) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (julianday(expires_at) > julianday(stored_at)),
  UNIQUE (tenant, authorization_id),
  UNIQUE (tenant, envelope_ref)
);

CREATE TABLE fenced_deliveries (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  message_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE RESTRICT,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  assignment_epoch INTEGER NOT NULL CHECK (assignment_epoch > 0),
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  ingress_receipt_id TEXT NOT NULL
    REFERENCES host_envelope_ingress_receipts(id) ON DELETE RESTRICT,
  effect_key TEXT NOT NULL CHECK (length(trim(effect_key)) BETWEEN 1 AND 255),
  envelope_ref TEXT NOT NULL CHECK (length(trim(envelope_ref)) > 0),
  ciphertext_digest TEXT NOT NULL
    CHECK (
      length(ciphertext_digest) = 64
      AND ciphertext_digest = lower(ciphertext_digest)
      AND ciphertext_digest NOT GLOB '*[^0-9a-f]*'
    ),
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_input_digest TEXT NOT NULL
    CHECK (
      length(runtime_input_digest) = 64
      AND runtime_input_digest = lower(runtime_input_digest)
      AND runtime_input_digest NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL CHECK (state IN (
    'accepted','leased','host_persisted','effect_intent','provider_observed',
    'runtime_injected','runtime_consumed','runtime_acked','expired',
    'recovery_reserved','source_acked','blocked'
  )),
  active_attempt_id TEXT,
  active_attempt_number INTEGER NOT NULL DEFAULT 0
    CHECK (active_attempt_number BETWEEN 0 AND 3),
  current_fencing_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (current_fencing_epoch >= 0),
  accepted_at TEXT NOT NULL CHECK (length(trim(accepted_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  source_acked_at TEXT,
  CHECK (
    (active_attempt_id IS NULL AND active_attempt_number = 0 AND current_fencing_epoch = 0)
    OR (
      active_attempt_id IS NOT NULL
      AND active_attempt_number BETWEEN 1 AND 3
      AND current_fencing_epoch > 0
    )
  ),
  CHECK (state <> 'source_acked' OR source_acked_at IS NOT NULL),
  UNIQUE (tenant, message_id),
  UNIQUE (tenant, source_agent_id, effect_key),
  UNIQUE (tenant, ingress_receipt_id)
);

ALTER TABLE agent_messages
  ADD COLUMN fenced_delivery_id TEXT REFERENCES fenced_deliveries(id) ON DELETE RESTRICT;

CREATE INDEX idx_agent_messages_fenced_delivery
  ON agent_messages(tenant, fenced_delivery_id)
  WHERE fenced_delivery_id IS NOT NULL;

CREATE TABLE fenced_delivery_attempts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES fenced_deliveries(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  attempt_nonce TEXT NOT NULL CHECK (length(trim(attempt_nonce)) BETWEEN 1 AND 255),
  generation INTEGER NOT NULL CHECK (generation > 0),
  prior_fencing_epoch INTEGER NOT NULL CHECK (prior_fencing_epoch >= 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > prior_fencing_epoch),
  runtime_seat_lease_id TEXT NOT NULL
    REFERENCES runtime_seat_leases(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'leased','expired','blocked','recovery_reserved','completed','stale'
  )),
  leased_at TEXT NOT NULL CHECK (length(trim(leased_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  retry_not_before TEXT NOT NULL CHECK (length(trim(retry_not_before)) > 0),
  ended_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (attempt_number > 1 OR prior_fencing_epoch = 0),
  CHECK (julianday(expires_at) > julianday(leased_at)),
  UNIQUE (tenant, delivery_id, attempt_number),
  UNIQUE (tenant, delivery_id, attempt_nonce),
  UNIQUE (tenant, delivery_id, fencing_epoch),
  UNIQUE (tenant, runtime_seat_lease_id)
);

CREATE UNIQUE INDEX idx_fenced_delivery_attempts_one_active
  ON fenced_delivery_attempts(tenant, delivery_id)
  WHERE state IN ('leased','recovery_reserved');

CREATE TABLE fenced_delivery_recovery_reservations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES fenced_deliveries(id) ON DELETE RESTRICT,
  prior_attempt_id TEXT NOT NULL
    REFERENCES fenced_delivery_attempts(id) ON DELETE RESTRICT,
  prior_attempt_number INTEGER NOT NULL CHECK (prior_attempt_number BETWEEN 1 AND 2),
  prior_fencing_epoch INTEGER NOT NULL CHECK (prior_fencing_epoch > 0),
  next_attempt_number INTEGER NOT NULL CHECK (next_attempt_number BETWEEN 2 AND 3),
  broker_id TEXT NOT NULL REFERENCES runtime_brokers(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL CHECK (length(trim(consumer_id)) BETWEEN 1 AND 255),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 255),
  reservation_nonce TEXT NOT NULL CHECK (length(trim(reservation_nonce)) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed','expired')),
  reserved_at TEXT NOT NULL CHECK (length(trim(reserved_at)) > 0),
  retry_not_before TEXT NOT NULL CHECK (length(trim(retry_not_before)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  consumed_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (next_attempt_number = prior_attempt_number + 1),
  CHECK (julianday(expires_at) > julianday(reserved_at)),
  CHECK (state <> 'consumed' OR consumed_at IS NOT NULL),
  UNIQUE (tenant, delivery_id, prior_attempt_id),
  UNIQUE (tenant, broker_id, idempotency_key),
  UNIQUE (tenant, reservation_nonce)
);

CREATE UNIQUE INDEX idx_fenced_delivery_recovery_one_open
  ON fenced_delivery_recovery_reservations(tenant, delivery_id)
  WHERE state = 'reserved';

CREATE TABLE fenced_delivery_evidence (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES fenced_deliveries(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES fenced_delivery_attempts(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'broker','ingress','adapter','runtime','provider_verifier'
  )),
  authority_id TEXT NOT NULL CHECK (length(trim(authority_id)) BETWEEN 1 AND 255),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'host.persisted','effect.intent','provider.observed','provider.reconciled',
    'runtime.injected','runtime.consumed','runtime.ack'
  )),
  message_id TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
  runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  assignment_epoch INTEGER NOT NULL CHECK (assignment_epoch > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  effect_key TEXT NOT NULL CHECK (length(trim(effect_key)) BETWEEN 1 AND 255),
  payload_digest TEXT NOT NULL,
  ciphertext_digest TEXT NOT NULL,
  runtime_input_digest TEXT NOT NULL,
  provider_effect_id TEXT,
  occurred_at TEXT NOT NULL CHECK (length(trim(occurred_at)) > 0),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  nonce TEXT NOT NULL CHECK (length(trim(nonce)) BETWEEN 1 AND 255),
  challenge_id TEXT NOT NULL REFERENCES runtime_signing_challenges(id) ON DELETE RESTRICT,
  canonical_payload_digest TEXT NOT NULL,
  signature TEXT NOT NULL CHECK (length(trim(signature)) BETWEEN 1 AND 4000),
  execution_receipt_id TEXT NOT NULL
    REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (
    length(payload_digest) = 64
    AND payload_digest = lower(payload_digest)
    AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(ciphertext_digest) = 64
    AND ciphertext_digest = lower(ciphertext_digest)
    AND ciphertext_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(runtime_input_digest) = 64
    AND runtime_input_digest = lower(runtime_input_digest)
    AND runtime_input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(canonical_payload_digest) = 64
    AND canonical_payload_digest = lower(canonical_payload_digest)
    AND canonical_payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (julianday(expires_at) > julianday(issued_at)),
  UNIQUE (tenant, authority_kind, authority_id, nonce),
  UNIQUE (tenant, challenge_id),
  UNIQUE (tenant, execution_receipt_id),
  UNIQUE (tenant, delivery_id, attempt_id, evidence_type)
);

CREATE UNIQUE INDEX idx_fenced_delivery_evidence_one_provider_result
  ON fenced_delivery_evidence(tenant, delivery_id, attempt_id)
  WHERE evidence_type IN ('provider.observed','provider.reconciled');

CREATE TRIGGER encrypted_envelope_ingress_authorizations_identity_immutable
BEFORE UPDATE OF id, tenant, source_agent_id, runtime_seat_id, generation,
  recipient_encryption_key_id, payload_digest, runtime_input_digest,
  maximum_bytes, upload_nonce, idempotency_key, issued_at, expires_at, created_at
ON encrypted_envelope_ingress_authorizations
BEGIN
  SELECT RAISE(ABORT, 'encrypted envelope ingress authorization is immutable');
END;

CREATE TRIGGER encrypted_envelope_ingress_authorizations_consume_once
BEFORE UPDATE OF consumed_at ON encrypted_envelope_ingress_authorizations
WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'encrypted envelope ingress consumption is invalid');
END;

CREATE TRIGGER encrypted_envelope_ingress_authorizations_no_delete
BEFORE DELETE ON encrypted_envelope_ingress_authorizations
BEGIN
  SELECT RAISE(ABORT, 'encrypted envelope ingress authorization is immutable');
END;

CREATE TRIGGER host_envelope_ingress_receipts_validate
BEFORE INSERT ON host_envelope_ingress_receipts
WHEN NOT EXISTS (
  SELECT 1
    FROM encrypted_envelope_ingress_authorizations authorization
    JOIN runtime_signer_registrations signer
      ON signer.id = authorization.recipient_encryption_key_id
     AND signer.tenant = authorization.tenant
     AND signer.runtime_seat_id = authorization.runtime_seat_id
     AND signer.generation = authorization.generation
    JOIN runtime_delivery_authorities ingress
      ON ingress.id = NEW.host_authority_id
     AND ingress.tenant = authorization.tenant
     AND ingress.runtime_seat_id = authorization.runtime_seat_id
     AND ingress.generation = authorization.generation
     AND ingress.authority_kind = 'ingress'
   WHERE authorization.id = NEW.authorization_id
     AND authorization.tenant = NEW.tenant
     AND authorization.runtime_seat_id = NEW.runtime_seat_id
     AND authorization.generation = NEW.generation
     AND authorization.recipient_encryption_key_id = NEW.recipient_encryption_key_id
     AND authorization.payload_digest = NEW.payload_digest
     AND authorization.runtime_input_digest = NEW.runtime_input_digest
     AND NEW.byte_length <= authorization.maximum_bytes
     AND signer.state = 'active'
     AND ingress.state = 'active'
     AND julianday(NEW.stored_at) >= julianday(authorization.issued_at)
     AND julianday(NEW.stored_at) < julianday(authorization.expires_at)
     AND julianday(NEW.expires_at) > julianday(NEW.stored_at)
)
BEGIN
  SELECT RAISE(ABORT, 'encrypted envelope ingress receipt mismatch');
END;

CREATE TRIGGER host_envelope_ingress_receipts_no_update
BEFORE UPDATE ON host_envelope_ingress_receipts
BEGIN
  SELECT RAISE(ABORT, 'host envelope ingress receipt is immutable');
END;

CREATE TRIGGER host_envelope_ingress_receipts_no_delete
BEFORE DELETE ON host_envelope_ingress_receipts
BEGIN
  SELECT RAISE(ABORT, 'host envelope ingress receipt is immutable');
END;

CREATE TRIGGER fenced_deliveries_validate_ingress
BEFORE INSERT ON fenced_deliveries
WHEN NEW.state <> 'accepted'
OR NEW.active_attempt_id IS NOT NULL
OR NEW.active_attempt_number <> 0
OR NEW.current_fencing_epoch <> 0
OR NEW.source_acked_at IS NOT NULL
OR NOT EXISTS (
  SELECT 1
    FROM host_envelope_ingress_receipts ingress
    JOIN runtime_seats seat
      ON seat.id = ingress.runtime_seat_id
     AND seat.tenant = ingress.tenant
   WHERE ingress.id = NEW.ingress_receipt_id
     AND ingress.tenant = NEW.tenant
     AND ingress.runtime_seat_id = NEW.runtime_seat_id
     AND ingress.generation = NEW.generation
     AND ingress.envelope_ref = NEW.envelope_ref
     AND ingress.ciphertext_digest = NEW.ciphertext_digest
     AND ingress.payload_digest = NEW.payload_digest
     AND ingress.runtime_input_digest = NEW.runtime_input_digest
     AND seat.state = 'active'
     AND seat.current_generation = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery ingress mismatch');
END;

CREATE TRIGGER fenced_deliveries_identity_immutable
BEFORE UPDATE OF id, tenant, message_id, source_agent_id, source_member_id,
  objective_id, flight_id, task_id, assignment_epoch, runtime_seat_id,
  generation, ingress_receipt_id, effect_key, envelope_ref,
  ciphertext_digest, payload_digest, runtime_input_digest, accepted_at
ON fenced_deliveries
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery identity and digests are immutable');
END;

CREATE TRIGGER fenced_deliveries_state_transition
BEFORE UPDATE OF state ON fenced_deliveries
WHEN NOT (
  (OLD.state = 'accepted' AND NEW.state IN ('leased','blocked'))
  OR (OLD.state = 'leased' AND NEW.state IN ('host_persisted','expired','blocked'))
  OR (OLD.state = 'host_persisted' AND NEW.state IN ('effect_intent','blocked'))
  OR (OLD.state = 'effect_intent' AND NEW.state IN ('provider_observed','blocked'))
  OR (OLD.state = 'provider_observed' AND NEW.state IN ('runtime_injected','blocked'))
  OR (OLD.state = 'runtime_injected' AND NEW.state IN ('runtime_consumed','blocked'))
  OR (OLD.state = 'runtime_consumed' AND NEW.state IN ('runtime_acked','blocked'))
  OR (OLD.state = 'runtime_acked' AND NEW.state = 'source_acked')
  OR (OLD.state IN ('expired','blocked') AND NEW.state = 'recovery_reserved')
  OR (OLD.state = 'recovery_reserved' AND NEW.state IN ('leased','blocked'))
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery state transition is invalid');
END;

CREATE TRIGGER fenced_deliveries_source_ack_requires_chain
BEFORE UPDATE OF state ON fenced_deliveries
WHEN NEW.state = 'source_acked'
AND (
  NEW.source_acked_at IS NULL
  OR OLD.state <> 'runtime_acked'
  OR NOT EXISTS (
    SELECT 1
      FROM fenced_delivery_attempts attempt
     WHERE attempt.id = OLD.active_attempt_id
       AND attempt.tenant = OLD.tenant
       AND attempt.delivery_id = OLD.id
       AND attempt.attempt_number = OLD.active_attempt_number
       AND attempt.generation = OLD.generation
       AND attempt.fencing_epoch = OLD.current_fencing_epoch
  )
  OR EXISTS (
    SELECT required.type
      FROM (
        SELECT 'host.persisted' AS type
        UNION ALL SELECT 'effect.intent'
        UNION ALL SELECT 'provider.result'
        UNION ALL SELECT 'runtime.injected'
        UNION ALL SELECT 'runtime.consumed'
        UNION ALL SELECT 'runtime.ack'
      ) required
     WHERE NOT EXISTS (
       SELECT 1
         FROM fenced_delivery_evidence evidence
        WHERE evidence.tenant = OLD.tenant
          AND evidence.delivery_id = OLD.id
          AND evidence.attempt_id = OLD.active_attempt_id
          AND evidence.attempt_number = OLD.active_attempt_number
          AND evidence.runtime_seat_id = OLD.runtime_seat_id
          AND evidence.generation = OLD.generation
          AND evidence.assignment_epoch = OLD.assignment_epoch
          AND evidence.fencing_epoch = OLD.current_fencing_epoch
          AND evidence.effect_key = OLD.effect_key
          AND evidence.payload_digest = OLD.payload_digest
          AND evidence.ciphertext_digest = OLD.ciphertext_digest
          AND evidence.runtime_input_digest = OLD.runtime_input_digest
          AND (
            evidence.evidence_type = required.type
            OR (
              required.type = 'provider.result'
              AND evidence.evidence_type IN ('provider.observed','provider.reconciled')
            )
          )
     )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery source ack requires complete evidence');
END;

CREATE TRIGGER fenced_deliveries_no_delete
BEFORE DELETE ON fenced_deliveries
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery is immutable');
END;

CREATE TRIGGER agent_messages_proof_exact_seat_insert
BEFORE INSERT ON agent_messages
WHEN NEW.fenced_delivery_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
    FROM fenced_deliveries delivery
    JOIN runtime_seats seat
      ON seat.id = delivery.runtime_seat_id
     AND seat.tenant = delivery.tenant
   WHERE delivery.id = NEW.fenced_delivery_id
     AND delivery.tenant = NEW.tenant
     AND delivery.message_id = NEW.id
     AND NEW.target_seat = seat.id
     AND NEW.to_agent = seat.agent_id
     AND json_valid(NEW.body)
     AND json_extract(NEW.body, '$.schema') = 'mupot-proof-ref:v1'
     AND json_extract(NEW.body, '$.delivery_id') = delivery.id
     AND json_extract(NEW.body, '$.envelope_ref') = delivery.envelope_ref
     AND json_extract(NEW.body, '$.ciphertext_digest') = delivery.ciphertext_digest
     AND json_extract(NEW.body, '$.payload_digest') = delivery.payload_digest
     AND json_extract(NEW.body, '$.runtime_input_digest') = delivery.runtime_input_digest
     AND length(NEW.body) <= 1000
)
BEGIN
  SELECT RAISE(ABORT, 'proof delivery requires exact runtime seat');
END;

CREATE TRIGGER agent_messages_proof_identity_immutable
BEFORE UPDATE OF tenant, to_agent, from_agent, from_member, kind, body,
  request_id, in_reply_to, project_id, target_seat, fenced_delivery_id
ON agent_messages
WHEN OLD.fenced_delivery_id IS NOT NULL OR NEW.fenced_delivery_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'proof message identity is immutable');
END;

CREATE TRIGGER agent_messages_proof_read_at_terminal
BEFORE UPDATE OF read_at ON agent_messages
WHEN OLD.fenced_delivery_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
    FROM fenced_deliveries delivery
   WHERE delivery.id = OLD.fenced_delivery_id
     AND delivery.tenant = OLD.tenant
     AND delivery.message_id = OLD.id
     AND delivery.state = 'source_acked'
     AND delivery.source_acked_at = NEW.read_at
)
BEGIN
  SELECT RAISE(ABORT, 'proof delivery requires exact source ack');
END;

CREATE TRIGGER fenced_delivery_attempts_validate
BEFORE INSERT ON fenced_delivery_attempts
WHEN NEW.state <> 'leased'
OR NOT EXISTS (
  SELECT 1
    FROM fenced_deliveries delivery
    JOIN runtime_seat_leases lease
      ON lease.id = NEW.runtime_seat_lease_id
     AND lease.tenant = delivery.tenant
     AND lease.runtime_seat_id = delivery.runtime_seat_id
     AND lease.generation = delivery.generation
     AND lease.fencing_epoch = NEW.fencing_epoch
   WHERE delivery.id = NEW.delivery_id
     AND delivery.tenant = NEW.tenant
     AND NEW.generation = delivery.generation
     AND lease.state = 'active'
)
OR (
  NEW.attempt_number = 1
  AND NEW.prior_fencing_epoch <> 0
)
OR (
  NEW.attempt_number > 1
  AND NOT EXISTS (
    SELECT 1
      FROM fenced_delivery_recovery_reservations reservation
     WHERE reservation.tenant = NEW.tenant
       AND reservation.delivery_id = NEW.delivery_id
       AND reservation.next_attempt_number = NEW.attempt_number
       AND reservation.prior_fencing_epoch = NEW.prior_fencing_epoch
       AND reservation.state = 'consumed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery attempt is not authorized');
END;

CREATE TRIGGER fenced_delivery_attempts_identity_immutable
BEFORE UPDATE OF id, tenant, delivery_id, attempt_number, attempt_nonce,
  generation, prior_fencing_epoch, fencing_epoch, runtime_seat_lease_id,
  leased_at, expires_at, retry_not_before, created_at
ON fenced_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery attempt is immutable');
END;

CREATE TRIGGER fenced_delivery_attempts_state_transition
BEFORE UPDATE OF state, ended_at ON fenced_delivery_attempts
WHEN NOT (
  (OLD.state = 'leased' AND NEW.state IN (
    'expired','blocked','completed','stale'
  ))
  OR (OLD.state IN ('expired','blocked') AND NEW.state = 'recovery_reserved')
  OR (OLD.state = 'recovery_reserved' AND NEW.state IN ('stale','expired'))
)
OR (NEW.state <> 'leased' AND NEW.ended_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery attempt transition is invalid');
END;

CREATE TRIGGER fenced_delivery_attempts_no_delete
BEFORE DELETE ON fenced_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery attempt is immutable');
END;

CREATE TRIGGER fenced_delivery_recovery_reservations_validate
BEFORE INSERT ON fenced_delivery_recovery_reservations
WHEN NEW.state <> 'reserved'
OR NOT EXISTS (
  SELECT 1
    FROM fenced_delivery_attempts attempt
   WHERE attempt.id = NEW.prior_attempt_id
     AND attempt.tenant = NEW.tenant
     AND attempt.delivery_id = NEW.delivery_id
     AND attempt.attempt_number = NEW.prior_attempt_number
     AND attempt.fencing_epoch = NEW.prior_fencing_epoch
     AND attempt.state IN ('expired','blocked')
     AND attempt.ended_at IS NOT NULL
     AND (
       (
         NEW.next_attempt_number = 2
         AND julianday(NEW.reserved_at) >= julianday(attempt.ended_at, '+5 seconds')
       )
       OR (
         NEW.next_attempt_number = 3
         AND julianday(NEW.reserved_at) >= julianday(attempt.ended_at, '+15 seconds')
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery recovery backoff or prior attempt mismatch');
END;

CREATE TRIGGER fenced_delivery_recovery_reservations_identity_immutable
BEFORE UPDATE OF id, tenant, delivery_id, prior_attempt_id,
  prior_attempt_number, prior_fencing_epoch, next_attempt_number, broker_id,
  consumer_id, idempotency_key, reservation_nonce, reserved_at,
  retry_not_before, expires_at, created_at
ON fenced_delivery_recovery_reservations
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery recovery reservation is immutable');
END;

CREATE TRIGGER fenced_delivery_recovery_reservations_lifecycle
BEFORE UPDATE OF state, consumed_at ON fenced_delivery_recovery_reservations
WHEN OLD.state <> 'reserved'
OR NEW.state NOT IN ('consumed','expired')
OR (NEW.state = 'consumed' AND NEW.consumed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery recovery reservation transition is invalid');
END;

CREATE TRIGGER fenced_delivery_recovery_reservations_no_delete
BEFORE DELETE ON fenced_delivery_recovery_reservations
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery recovery reservation is immutable');
END;

CREATE TRIGGER fenced_delivery_evidence_validate
BEFORE INSERT ON fenced_delivery_evidence
WHEN NOT EXISTS (
  SELECT 1
    FROM fenced_deliveries delivery
    JOIN fenced_delivery_attempts attempt
      ON attempt.id = NEW.attempt_id
     AND attempt.tenant = delivery.tenant
     AND attempt.delivery_id = delivery.id
   WHERE delivery.id = NEW.delivery_id
     AND delivery.tenant = NEW.tenant
     AND delivery.active_attempt_id = NEW.attempt_id
     AND delivery.active_attempt_number = NEW.attempt_number
     AND delivery.runtime_seat_id = NEW.runtime_seat_id
     AND delivery.generation = NEW.generation
     AND delivery.assignment_epoch = NEW.assignment_epoch
     AND delivery.current_fencing_epoch = NEW.fencing_epoch
     AND delivery.message_id = NEW.message_id
     AND delivery.effect_key = NEW.effect_key
     AND delivery.payload_digest = NEW.payload_digest
     AND delivery.ciphertext_digest = NEW.ciphertext_digest
     AND delivery.runtime_input_digest = NEW.runtime_input_digest
     AND attempt.attempt_number = NEW.attempt_number
     AND attempt.generation = NEW.generation
     AND attempt.fencing_epoch = NEW.fencing_epoch
     AND attempt.state NOT IN ('expired','blocked','recovery_reserved','stale')
)
OR NOT EXISTS (
  SELECT 1
    FROM runtime_signing_challenges challenge
   WHERE challenge.id = NEW.challenge_id
     AND challenge.tenant = NEW.tenant
     AND challenge.domain = 'mupot-fenced-delivery-evidence:v1'
     AND challenge.authority_kind = NEW.authority_kind
     AND challenge.authority_id = NEW.authority_id
)
OR NOT EXISTS (
  SELECT 1
    FROM execution_receipts receipt
   WHERE receipt.id = NEW.execution_receipt_id
     AND receipt.tenant = NEW.tenant
     AND receipt.type = NEW.evidence_type
     AND receipt.seat_id = NEW.runtime_seat_id
     AND receipt.seat_generation = NEW.generation
     AND receipt.message_id = NEW.message_id
     AND receipt.assignment_epoch = NEW.assignment_epoch
     AND receipt.fencing_epoch = NEW.fencing_epoch
)
OR NOT (
  (
    NEW.authority_kind = 'broker'
    AND NEW.evidence_type = 'host.persisted'
    AND EXISTS (
      SELECT 1 FROM runtime_brokers broker
       WHERE broker.id = NEW.authority_id
         AND broker.tenant = NEW.tenant
         AND broker.state = 'active'
    )
  )
  OR (
    NEW.authority_kind = 'adapter'
    AND NEW.evidence_type IN ('effect.intent','runtime.injected')
    AND EXISTS (
      SELECT 1 FROM runtime_delivery_authorities authority
       WHERE authority.id = NEW.authority_id
         AND authority.tenant = NEW.tenant
         AND authority.runtime_seat_id = NEW.runtime_seat_id
         AND authority.generation = NEW.generation
         AND authority.authority_kind = 'adapter'
         AND authority.state = 'active'
    )
  )
  OR (
    NEW.authority_kind = 'provider_verifier'
    AND NEW.evidence_type IN ('provider.observed','provider.reconciled')
    AND EXISTS (
      SELECT 1 FROM runtime_delivery_authorities authority
       WHERE authority.id = NEW.authority_id
         AND authority.tenant = NEW.tenant
         AND authority.runtime_seat_id = NEW.runtime_seat_id
         AND authority.generation = NEW.generation
         AND authority.authority_kind = 'provider_verifier'
         AND authority.state = 'active'
    )
  )
  OR (
    NEW.authority_kind = 'runtime'
    AND NEW.evidence_type IN ('runtime.consumed','runtime.ack')
    AND EXISTS (
      SELECT 1 FROM runtime_signer_registrations signer
       WHERE signer.id = NEW.authority_id
         AND signer.tenant = NEW.tenant
         AND signer.runtime_seat_id = NEW.runtime_seat_id
         AND signer.generation = NEW.generation
         AND signer.state = 'active'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery evidence mismatch or stale attempt');
END;

CREATE TRIGGER fenced_delivery_evidence_no_update
BEFORE UPDATE ON fenced_delivery_evidence
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery evidence is immutable');
END;

CREATE TRIGGER fenced_delivery_evidence_no_delete
BEFORE DELETE ON fenced_delivery_evidence
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery evidence is immutable');
END;

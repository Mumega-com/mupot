-- Preserve whether an enrolment link was minted before any passkey existed.
-- A revoked credential remains history; stale first-enrol links cannot become
-- a second session-only registration after another credential lands.
ALTER TABLE passkey_enrolment_tokens
  ADD COLUMN requires_prior_passkey INTEGER NOT NULL DEFAULT 0
  CHECK (requires_prior_passkey IN (0, 1));

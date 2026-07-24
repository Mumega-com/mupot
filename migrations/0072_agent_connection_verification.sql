-- 0072_agent_connection_verification.sql — bounded verification attempts.
--
-- Challenge plaintext is never stored. This counter limits online guesses
-- against the stored SHA-256 challenge digest and is monotonic by trigger.

ALTER TABLE agent_connection_receipts
  ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER agent_connection_verification_attempts_insert
BEFORE INSERT ON agent_connection_receipts
WHEN NEW.verification_attempts < 0 OR NEW.verification_attempts > 5
BEGIN
  SELECT RAISE(ABORT, 'invalid_verification_attempts');
END;

CREATE TRIGGER agent_connection_verification_attempts_update
BEFORE UPDATE OF verification_attempts ON agent_connection_receipts
WHEN NEW.verification_attempts < OLD.verification_attempts
  OR NEW.verification_attempts > 5
BEGIN
  SELECT RAISE(ABORT, 'invalid_verification_attempts');
END;

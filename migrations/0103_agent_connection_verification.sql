-- 0103_agent_connection_verification.sql — bounded verification attempts.
--
-- Challenge plaintext is never stored. This counter limits online guesses
-- against the stored SHA-256 challenge digest and is monotonic by trigger.
--
-- Renumbered 0072 -> 0102 -> 0103 (kasra-git, 2026-08-14): origin/main's migration head had
-- moved to 0101 by the time this PR was gated (#847 review finding, mupot#853). Per
-- check-migration-numbering.mjs / #729: a migration numbered at or below the
-- merge-target head merges green and NEVER RUNS — wrangler applies only files
-- sorting above the applied head. 0102 was free on main at first check but was claimed minutes later by PR #841 (240e1831, 0102_secret_env.sql, still unmerged); 0103 is free as of this push.

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

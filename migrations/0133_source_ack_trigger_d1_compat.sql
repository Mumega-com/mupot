-- Rebuild the source-ACK evidence-chain trigger without a compound SELECT.
--
-- Migration 0128 originally synthesized six required evidence classes with
-- UNION ALL. Local D1 rejects that trigger with `too many terms in compound
-- SELECT`, so fresh installs could not materialize the committed schema. The
-- corrected 0128 keeps fresh installs viable; this above-head migration makes
-- databases that already recorded 0128 converge on the same trigger body.

DROP TRIGGER IF EXISTS fenced_deliveries_source_ack_requires_chain;

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
  OR (
    SELECT COUNT(DISTINCT CASE
      WHEN evidence.evidence_type IN ('provider.observed','provider.reconciled')
        THEN 'provider.result'
      ELSE evidence.evidence_type
    END)
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
       AND evidence.envelope_digest = OLD.envelope_digest
       AND evidence.runtime_input_digest = OLD.runtime_input_digest
       AND evidence.evidence_type IN (
         'host.persisted',
         'effect.intent',
         'provider.observed',
         'provider.reconciled',
         'runtime.injected',
         'runtime.consumed',
         'runtime.ack'
       )
  ) <> 6
)
BEGIN
  SELECT RAISE(ABORT, 'fenced delivery source ack requires complete evidence');
END;

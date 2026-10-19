-- 0240_admission_attach_code.sql — mupot#2054. A pending seat admission carries a short human code that the asking chat
-- shows its human and the /connections card repeats, so "Admit" can be tied to the chat that asked. Additive; NULL on
-- every pre-existing row (legacy: Admit works without a code). A label, not a credential.
ALTER TABLE agent_seat_admissions ADD COLUMN attach_code TEXT;

-- The code never changes once set (it is what the human matched on the card). Additive: a new trigger only.
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_attach_code_immutable
BEFORE UPDATE OF attach_code ON agent_seat_admissions
FOR EACH ROW
WHEN OLD.attach_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_attach_code_immutable');
END;

-- The chat an admission is bound to never changes either (the approval belongs to the chat that asked). New trigger only.
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_requested_seat_immutable
BEFORE UPDATE OF requested_seat_id ON agent_seat_admissions
FOR EACH ROW
WHEN OLD.requested_seat_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_requested_seat_immutable');
END;

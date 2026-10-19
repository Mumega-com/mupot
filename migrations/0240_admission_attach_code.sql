-- 0240_admission_attach_code.sql — mupot#2054. A pending seat admission carries a short human code that the asking chat
-- shows its human and the /connections card repeats, so "Admit" can be tied to the chat that asked. Additive; NULL on
-- every pre-existing row (legacy: Admit works without a code). A label, not a credential.
ALTER TABLE agent_seat_admissions ADD COLUMN attach_code TEXT;

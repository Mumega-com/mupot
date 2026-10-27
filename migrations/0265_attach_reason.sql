-- #2229: preserve legacy/direct-human admissions; new seat_attach asks require a reason.
-- 0264 is already occupied on main. Production head was not checked (offline build).
ALTER TABLE agent_seat_admissions ADD COLUMN reason TEXT
  CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 280);

CREATE TRIGGER agent_seat_admissions_reason_immutable
BEFORE UPDATE OF reason ON agent_seat_admissions
WHEN NEW.reason IS NOT OLD.reason
BEGIN
  SELECT RAISE(ABORT, 'admission reason is immutable');
END;

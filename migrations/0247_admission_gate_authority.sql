-- 0247_admission_gate_authority.sql — an ATTACHED agent session may exercise its bound agent's gate capability
-- (task_verdict) when the admission opts in. Hadi (owner, 2026-10-19): reviewing is agent work; human approval is a
-- different thing and stays out of this.
--
-- WHY A NEW COLUMN AND NOT A RELAXED `gates` CHECK. 0220 fixed `gates INTEGER CHECK (gates = 0)`. SQLite cannot alter a
-- CHECK, so relaxing it means DROP TABLE agent_seat_admissions. That table is the PARENT of agent_seat_attachments
-- (admission_id ... ON DELETE RESTRICT) and attachments are no-delete by trigger, so the rebuild would fail on any pot that
-- already holds an attachment (RESTRICT is checked immediately; same trap 0202 documents for harnesses). `gates` therefore
-- stays frozen at 0 forever (legacy, never read as authority) and `gate_authority` is the opt-in:
--   0 = the attached seat holds NO gate authority (every existing row, the DEFAULT)
--   1 = the attached seat may pass the gate check AS ITS BOUND AGENT, only while the attachment, the admission and the
--       agent are live AND the agent itself holds a live gate_grants row for the capability (hasActiveGateGrant), and
--       with every verdict-independence rule intact (src/auth/attached-gate.ts, src/tasks/index.ts).
-- Decided exactly once, at the human's decision (pending -> live) or at insert for a dashboard admission that is born live;
-- never changed afterwards (changing it takes a new admission: revoke + a new tap), like `ceiling`.
-- Additive: no existing row, index or trigger is touched.
ALTER TABLE agent_seat_admissions ADD COLUMN gate_authority INTEGER NOT NULL DEFAULT 0 CHECK (gate_authority IN (0, 1));

CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_gate_authority_immutable
BEFORE UPDATE OF gate_authority ON agent_seat_admissions
FOR EACH ROW
WHEN NEW.gate_authority IS NOT OLD.gate_authority AND OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_gate_authority_immutable');
END;

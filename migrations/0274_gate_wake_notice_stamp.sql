-- Delivery evidence is nullable: legacy text alone cannot prove a delivery in this episode.
ALTER TABLE tasks ADD COLUMN gate_wake_notice_at TEXT;

-- Also invalidate same-second re-entry and the existing review-clock carry/bounce case.
-- This does not alter the approval clock, task status, verdicts or claim budget.
CREATE TRIGGER tasks_gate_wake_notice_review_reset
AFTER UPDATE OF status ON tasks
WHEN NEW.status='review' AND OLD.status<>'review'
BEGIN
  UPDATE tasks SET gate_wake_notice_at=NULL WHERE id=NEW.id;
END;

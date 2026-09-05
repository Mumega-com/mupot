-- A runtime-consumed receipt is valid only while the exact source delivery is
-- still unread and held by the same live lease attempt. The application also
-- guards the task UPDATE; this trigger is the transaction-local backstop that
-- aborts the whole D1 batch if the delivery changes between preflight and
-- receipt insertion.

CREATE TRIGGER task_dispatch_runtime_consumed_requires_live_delivery
BEFORE INSERT ON task_dispatch_runtime_receipts
WHEN NEW.stage = 'runtime_consumed'
BEGIN
  SELECT RAISE(ABORT, 'task_dispatch_runtime_delivery_stale')
   WHERE NOT EXISTS (
     SELECT 1
       FROM agent_messages message
       JOIN tasks task ON task.id = NEW.task_id
      WHERE message.id = NEW.message_id
        AND message.tenant = NEW.tenant
        AND message.to_agent = NEW.runtime_address
        AND message.from_agent = 'mupot-dispatch'
        AND message.request_id = 'dispatch-inbox:' || NEW.dispatch_receipt_id
        AND message.read_at IS NULL
        AND message.delivery_attempts = NEW.attempt
        AND message.lease_expires_at IS NOT NULL
        AND julianday(message.lease_expires_at) > julianday(NEW.created_at)
        AND message.dead_lettered_at IS NULL
        AND task.status = 'in_progress'
        AND task.execution_receipt_id = NEW.dispatch_receipt_id
        AND task.assignee_agent_id = NEW.agent_id
   );
END;

-- A failed dispatch is terminal for its receipt identity. The application
-- guards the task transition; this trigger is the transaction-local backstop
-- that prevents a zero-row task update from being followed by a completed
-- receipt insert after an operator reopens the task.

CREATE TRIGGER task_dispatch_runtime_completed_requires_no_failed
BEFORE INSERT ON task_dispatch_runtime_receipts
WHEN NEW.stage = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'task_dispatch_runtime_failed_terminal')
   WHERE EXISTS (
     SELECT 1
       FROM task_dispatch_runtime_receipts failed
      WHERE failed.tenant = NEW.tenant
        AND failed.dispatch_receipt_id = NEW.dispatch_receipt_id
        AND failed.stage = 'failed'
   );
END;

-- A completed dispatch is terminal in the opposite direction as well. This
-- protects the append-only receipt table if a future D1 batch implementation
-- accepts a zero-row task update and continues to later statements.

CREATE TRIGGER task_dispatch_runtime_failed_requires_no_completed
BEFORE INSERT ON task_dispatch_runtime_receipts
WHEN NEW.stage = 'failed'
BEGIN
  SELECT RAISE(ABORT, 'task_dispatch_runtime_completed_terminal')
   WHERE EXISTS (
     SELECT 1
       FROM task_dispatch_runtime_receipts completed
      WHERE completed.tenant = NEW.tenant
        AND completed.dispatch_receipt_id = NEW.dispatch_receipt_id
        AND completed.stage = 'completed'
   );
END;

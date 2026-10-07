-- mupot#1723 / #1721 — in-Worker dispatch receipts need their own terminal disposition.
--
-- A task_dispatch that routes 'in_worker' (src/bus/consumer.ts, resolveDispatchDeliveryMode)
-- never creates an agent_messages row and never has a runtime credential, so it can never
-- write a task_dispatch_runtime_receipts row (message_id / credential_id are NOT NULL, FK'd).
-- Before this column set, such a receipt was consumed but NEVER settled: when the in-Worker
-- run ended without a verified artifact (task blocked) the dispatch stayed "in flight" forever,
-- task_dispatch refused task_not_dispatchable, and the operator repair
-- task_dispatch_lease_reset(terminate:true) refused too (no message to load).
--
-- Additive, nullable, no backfill: NULL = not settled on the dispatch row (either still in
-- flight, or message-backed and settled through task_dispatch_runtime_receipts as before).
-- hasInFlightDispatchReceipt / inFlightDispatchReceiptExistsSql treat settled_at IS NOT NULL
-- as terminal alongside a terminal runtime receipt.
ALTER TABLE task_dispatch_receipts ADD COLUMN settled_stage TEXT
  CHECK (settled_stage IS NULL OR settled_stage IN ('completed', 'failed', 'reset_terminated'));
ALTER TABLE task_dispatch_receipts ADD COLUMN settled_at TEXT;
ALTER TABLE task_dispatch_receipts ADD COLUMN settled_reason TEXT;

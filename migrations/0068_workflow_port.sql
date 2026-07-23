-- mupot — Module Kernel Port 5: workflow adapters + gated external acts.
--
-- Design: docs/architecture/mupot-module-kernel.md §2 (Workflow port).
-- Cloudflare Workflows remain the DEFAULT adapter (existing TASK_WORKFLOW +
-- workflow_receipts). n8n / zapier / make are optional adapters behind the SAME
-- port. Outbound = gated act → receipt; external managers never hold the approval.
--
-- workflow_acts: pending external side-effects (trigger n8n/zapier/make webhook).
-- Mirrors outbound_acts (0013) iron doctrine:
--   1. Starts 'pending'. Moves to 'sent' ONLY through runApprovedWorkflowActs(),
--      which re-reads task_verdicts independently before every external call.
--   2. 'sending' is a claim state (pending→sending atomic) so Workflow/step retry
--      cannot double-fire an external webhook.
--   3. receipt_id points at workflow_receipts.id written after a successful run
--      (observability + project evidence; same table CF pipeline already uses).

CREATE TABLE IF NOT EXISTS workflow_acts (
  id          TEXT NOT NULL PRIMARY KEY,
  task_id     TEXT NOT NULL,
  adapter     TEXT NOT NULL
                   CHECK(adapter IN ('cf', 'n8n', 'zapier', 'make')),
  payload     TEXT NOT NULL,              -- JSON (no secrets; webhook URL is env-or-payload)
  status      TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'refused')),
  verdict_id  TEXT,
  receipt_id  TEXT,                       -- workflow_receipts.id when status='sent'
  detail      TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_acts_task_status
  ON workflow_acts (task_id, status);

-- 0258 board two-way (Linear first): task<->board-item links, the write-back idempotency ledger,
-- the inbound webhook delivery ledger, and append-only inbound observations.
--
-- Numbering: 0256 is taken by PR #2184 (signed webhook doorbell); 0257 is left free for S2 (repo-aware github).
-- No secret is stored in any of these tables. The credential stays in the vault connector.

-- Which board item a mupot task is bound to. Written by the import paths (sync + webhook), never from a verdict surface.
CREATE TABLE IF NOT EXISTS board_item_links (
  tenant         TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  item_native_id TEXT NOT NULL,   -- the provider's stable id (Linear issue uuid)
  item_ref       TEXT NOT NULL,   -- human handle (Linear identifier, e.g. ENG-12)
  created_at     TEXT NOT NULL,
  PRIMARY KEY (tenant, task_id),
  UNIQUE (tenant, provider, item_native_id)
);

-- One row per (task, transition receipt, action): the outbound write is claimed here BEFORE it is sent.
-- transition_key embeds the receipt id (submitted:<submission id>, approved:<verdict id>, rejected:<verdict id>), so a
-- resubmission after a rejection is a new transition while a redelivered event for the same receipt is a no-op.
CREATE TABLE IF NOT EXISTS board_writeback_ledger (
  tenant         TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('status', 'comment')),
  provider       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 1,
  detail         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant, task_id, transition_key, action)
);
CREATE INDEX IF NOT EXISTS idx_board_writeback_ledger_failed
  ON board_writeback_ledger (tenant, status, updated_at) WHERE status <> 'done';

-- Inbound webhook delivery ledger (replay guard), same shape as github_webhook_deliveries.
CREATE TABLE IF NOT EXISTS board_webhook_deliveries (
  tenant      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (tenant, provider, delivery_id)
);

-- What the board said happened to a linked item. A note, never a verdict: nothing reads this to change a task status.
CREATE TABLE IF NOT EXISTS board_inbound_observations (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant         TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  item_native_id TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  observed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_inbound_observations_task
  ON board_inbound_observations (tenant, task_id, observed_at DESC);

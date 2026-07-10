-- 0045 — durable GitHub webhook delivery replay ledger.
--
-- GitHub can redeliver a signed webhook concurrently or long after an initial
-- attempt. KV get-then-put is not atomic, so it cannot provide a replay guard
-- for a work-creating event. D1's primary key makes claiming a delivery an
-- atomic, tenant-scoped operation. The handler returns 503 on ledger failure so
-- GitHub retries safely rather than processing an untracked delivery.

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  tenant      TEXT    NOT NULL,
  delivery_id TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (tenant, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_received
  ON github_webhook_deliveries (tenant, received_at);

-- Execution meter: per-(tenant, agent, window) dispatch + token counters.
--
-- Purpose: enforce a daily cap on execute-mode model calls before self-serve
-- tenants are enabled (issue #4). Prevents economic DoS from looped dispatch.
--
-- Design choices:
--
--   window_key  = '<tenant>:<agent_id>:<YYYY-MM-DD>' (UTC date).
--                 A new day automatically starts a fresh window — no TTL or
--                 background job needed; the UPSERT in checkAndReserve handles it.
--
--   count       = number of execute cycles started this window.
--   tokens      = tokens _spent_ this window (accumulated after each cycle via
--                 recordTokens; count is incremented before the model call to
--                 act as a pre-flight reservation even if tokens are not yet known).
--
--   Race note (documented in meter.ts): D1 does not support true serialisable
--   transactions from a Worker (each prepare().run() is its own implicit tx).
--   Two concurrent dispatches can both read count=N below the cap and both
--   increment, letting up to (parallelism - 1) extra cycles through at the
--   window boundary. This is acceptable: the cap is a soft economic governor,
--   not a hard security gate. A one-at-a-time DO serialises the alarm path;
--   HTTP dispatch concurrency is bounded by the member RBAC gate above it.
--
--   The table is append-insert-on-first-use per window_key; rows are tiny
--   (~80 bytes each) so daily compaction is not needed at current scale.

CREATE TABLE IF NOT EXISTS execution_meter (
  id           TEXT NOT NULL PRIMARY KEY,   -- random UUID; one row per window_key
  window_key   TEXT NOT NULL UNIQUE,        -- '<tenant>:<agent_id>:<YYYY-MM-DD>'
  count        INTEGER NOT NULL DEFAULT 0,  -- dispatches started in this window
  tokens       INTEGER NOT NULL DEFAULT 0,  -- tokens spent (accumulated post-cycle)
  window_start TEXT NOT NULL                -- ISO-8601 of window creation (debug)
);

CREATE INDEX IF NOT EXISTS idx_execution_meter_window ON execution_meter (window_key);

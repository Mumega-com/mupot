-- 0109_flight_reap_receipts.sql — durable audit receipts for governed flight reaps.
--
-- WHY A NEW TABLE INSTEAD OF WIDENING flight_event_outbox's CHECK (the #1132 premise).
--
-- reapStalledFlight writes its receipt as event_type='flight.reaped' into flight_event_outbox,
-- whose 0046 constraint is `CHECK (event_type = 'flight.landed')`. The INSERT therefore THROWS on
-- every reap, is swallowed by a catch, and the call returns transitioned:true / receipt:false — a
-- reaped flight with no audit trail. #1132 proposed widening that CHECK. Two findings say not to:
--
--   1. THE REBUILD IS THE RISK, NOT THE CONSTRAINT. SQLite cannot ALTER a CHECK, so widening means
--      create-copy-drop-rename. flight_event_outbox carries TWO indexes
--      (idx_flight_event_outbox_pending 0046, idx_flight_event_outbox_evidence_keyset 0059), a
--      project_id column added later, and SIX trigger definitions across 0059 and 0069 — where
--      0069 REDEFINES two of 0059's, so the live definitions are 0069's, not the ones the earlier
--      file appears to establish. A rebuild must reproduce all of that exactly on a live table.
--      That is a "never blind-apply" shape.
--
--   2. WIDENING WOULD PRODUCE A FALSE RECEIPT, WHICH IS WORSE THAN THE SILENCE IT FIXES.
--      deliverFlightLandedEvent (src/flight/service.ts) SELECTs `WHERE tenant AND flight_id AND
--      delivered_at IS NULL` with NO event_type filter, emits a HARDCODED `type:'flight.landed'`,
--      and UPDATEs delivered_at with NO event_type filter. flushFlightEventOutbox iterates
--      undelivered rows and passes only flight_id. So the moment a 'flight.reaped' row became
--      insertable, the flusher would pick it up and ANNOUNCE A REAP AS A LANDING on the bus, then
--      mark it delivered. A stalled flight would be broadcast as a successful landing.
--
-- A reap is not a landing. It is the system giving up on a flight, and its consumer is an auditor,
-- not the landing pipeline. Separating the surfaces makes the two structurally unconfusable: a
-- reap receipt cannot be mis-delivered as a landing because it is not in the delivery queue at all.
--
-- Purely additive — CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No rebuild, no data movement,
-- no change to the landing path, and nothing here can fail an existing write.

CREATE TABLE IF NOT EXISTS flight_reap_receipts (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  flight_id         TEXT NOT NULL,

  -- Status the flight held immediately before the reap ('preflight' | 'running' | 'sleeping').
  -- 'waiting' is absent by design: a human review gate is NEVER auto-reaped (a slow human is not
  -- a dead flight), and the watchdog escalates instead. If a 'waiting' row ever appears here, the
  -- hard invariant has been broken and this constraint is the alarm.
  previous_status   TEXT NOT NULL CHECK (previous_status IN ('preflight', 'running', 'sleeping')),

  -- Who triggered it. 'system' is the scheduled watchdog; member/agent are operator-triggered
  -- reaps through the MCP tool. The 0046 outbox omitted 'system' entirely, which is the second
  -- reason its CHECK rejected watchdog writes.
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent', 'system')),
  actor_id          TEXT NOT NULL,

  -- Operator-facing reason, and the predicate's own machine reason. Kept separate so a human
  -- explanation can never be mistaken for the evaluation that actually fired.
  reap_reason       TEXT NOT NULL,
  predicate_reason  TEXT NOT NULL,

  -- The evidence the decision rested on: how old the flight was, and the threshold applied.
  -- Recording both makes a wrong reap diagnosable without re-deriving the predicate.
  age_ms            INTEGER,
  timeout_ms        INTEGER,

  payload           TEXT NOT NULL CHECK (json_valid(payload)),
  created_at        TEXT NOT NULL,

  -- One receipt per reap. A flight can only be reaped once (the UPDATE that transitions it is
  -- guarded on a non-terminal status), so a duplicate here means a double-reap and should be
  -- rejected rather than silently recorded twice.
  UNIQUE (tenant, flight_id)
);

-- Audit read pattern: "what has been reaped lately, newest first", tenant-scoped.
CREATE INDEX IF NOT EXISTS idx_flight_reap_receipts_recent
  ON flight_reap_receipts (tenant, created_at DESC);

-- Lookup by flight, for "why did this flight die?".
CREATE INDEX IF NOT EXISTS idx_flight_reap_receipts_flight
  ON flight_reap_receipts (tenant, flight_id);

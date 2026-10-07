-- 0194_flight_cancel_receipts.sql — mupot#1730: lead/admin early close of a flight (flight_cancel).
--
-- WHY A NEW TABLE, AND WHY NO NEW flights.status VALUE
--
-- flights.status carries CHECK (status IN ('preflight','held','running','waiting','sleeping',
-- 'landed','failed')) (0017, rebuilt by 0172). Widening it means create-copy-drop-rename on a table
-- with project triggers (0055/0069/0059), 0172's waiting triggers and many dependents: a
-- "never blind-apply" rebuild. flight_cancel therefore ends the flight as 'failed' with
-- gate_reason 'cancelled_by_lead: <reason>' (distinct from watchdog_reap:), and the authoritative,
-- machine-readable record that it was a CANCEL lives here.
--
-- flight_reap_receipts (0109) cannot hold it: its previous_status CHECK excludes 'waiting', and
-- a cancel is legal from waiting. flight_event_outbox is a landing delivery queue (0109 explains
-- why a non-landing row there would be announced as a landing).
--
-- Additive only: CREATE TABLE / INDEX IF NOT EXISTS. No cost column is invented: cost_metered is
-- recorded as read from the flight, and flights.cost_micro_usd is never touched by a cancel.
CREATE TABLE IF NOT EXISTS flight_cancel_receipts (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  flight_id       TEXT NOT NULL,
  previous_status TEXT NOT NULL CHECK (previous_status IN ('preflight', 'running', 'waiting', 'sleeping')),
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent')),
  actor_id        TEXT NOT NULL,
  cancel_reason   TEXT NOT NULL,
  cost_metered    INTEGER NOT NULL CHECK (cost_metered IN (0, 1)),
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  created_at      TEXT NOT NULL,
  -- A flight leaves its non-terminal states once, so one cancel receipt per flight.
  UNIQUE (tenant, flight_id)
);

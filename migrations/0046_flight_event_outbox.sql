-- Durable terminal-flight events. Landing and outbox insertion share one D1 batch;
-- Queue delivery may then retry without reopening the terminal flight.
CREATE TABLE IF NOT EXISTS flight_event_outbox (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  flight_id     TEXT NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type = 'flight.landed'),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent')),
  actor_id      TEXT NOT NULL,
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  consumed_at   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  UNIQUE (tenant, flight_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_flight_event_outbox_pending
  ON flight_event_outbox (tenant, delivered_at, created_at);

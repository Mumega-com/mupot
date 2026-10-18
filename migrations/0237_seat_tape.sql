-- 0237_seat_tape.sql -- admission by observation, P0 (SHADOW ONLY; flag ADMISSION_TAPE, default off).
-- Design: agents/kasra/docs/design-admission-by-observation-20261018.md (b), (c).
--
-- seat_tape: one row per scored window of a seat's tool calls. APPEND-ONLY (BEFORE UPDATE / BEFORE DELETE
-- triggers RAISE, in the style of agent_access_receipts 0187 and task_verdicts 0008) and hash-chained per
-- seat: row_hash = sha256(prev_hash | canonical row fields); the first row of a seat has prev_hash ''.
-- UNIQUE (seat_id, prev_hash) means two writers racing on the same chain head cannot both link to it.
-- The tape holds scores and arg-SHAPE signals only, never raw argument values.
--
-- seat_tape_window: the rolling in-progress window per seat (shape-only events as JSON). Plain mutable
-- scratch state for P0 (no Durable Object yet); it is not part of the record.
--
-- agent_seats.admission_status: nullable, NULL = no status (every existing seat). P0 never writes it.
-- agent_seats_immutable (0199) guards identity columns only, so a later phase can update this one.
--
-- CREATE / ADD COLUMN only: no existing table is rebuilt.

CREATE TABLE IF NOT EXISTS seat_tape (
  id             TEXT PRIMARY KEY NOT NULL,
  seat_id        TEXT NOT NULL,
  member_id      TEXT NOT NULL,
  window_start   TEXT NOT NULL,
  window_end     TEXT NOT NULL,
  event_count    INTEGER NOT NULL CHECK (event_count >= 0),
  score          INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  signals        TEXT NOT NULL CHECK (json_valid(signals)),
  status_before  TEXT CHECK (status_before IS NULL OR status_before IN ('observed','trusted','held')),
  status_after   TEXT CHECK (status_after IS NULL OR status_after IN ('observed','trusted','held')),
  would_hold     INTEGER NOT NULL CHECK (would_hold IN (0,1)),
  prev_hash      TEXT NOT NULL,
  row_hash       TEXT NOT NULL CHECK (length(row_hash) = 64),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_tape_chain ON seat_tape (seat_id, prev_hash);
CREATE INDEX IF NOT EXISTS idx_seat_tape_seat_time ON seat_tape (seat_id, window_end DESC);

CREATE TRIGGER IF NOT EXISTS seat_tape_no_update
BEFORE UPDATE ON seat_tape
BEGIN
  SELECT RAISE(ABORT, 'seat_tape is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS seat_tape_no_delete
BEFORE DELETE ON seat_tape
BEGIN
  SELECT RAISE(ABORT, 'seat_tape is append-only: DELETE is forbidden');
END;

CREATE TABLE IF NOT EXISTS seat_tape_window (
  seat_id     TEXT PRIMARY KEY NOT NULL,
  events_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE agent_seats ADD COLUMN admission_status TEXT
  CHECK (admission_status IS NULL OR admission_status IN ('observed','trusted','held'));

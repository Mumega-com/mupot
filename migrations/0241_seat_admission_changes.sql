-- 0241_seat_admission_changes.sql -- #2060: audit of HUMAN hold/release/return on an observed seat.
-- One row per applied transition of agent_seats.admission_status made by the seat's own human on the dashboard
-- (Connections > Observed chats). APPEND-ONLY (UPDATE/DELETE triggers RAISE). Written in the SAME D1 batch as the status UPDATE.
-- CREATE only: no existing table is rebuilt.

CREATE TABLE IF NOT EXISTS seat_admission_changes (
  id          TEXT PRIMARY KEY NOT NULL,
  tenant      TEXT NOT NULL,
  seat_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('hold','release','return')),
  from_status TEXT NOT NULL CHECK (from_status IN ('observed','trusted','held')),
  to_status   TEXT NOT NULL CHECK (to_status IN ('observed','trusted','held')),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_seat_admission_changes_seat ON seat_admission_changes (seat_id, at DESC);

CREATE TRIGGER IF NOT EXISTS seat_admission_changes_no_update
BEFORE UPDATE ON seat_admission_changes
BEGIN
  SELECT RAISE(ABORT, 'seat_admission_changes is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS seat_admission_changes_no_delete
BEFORE DELETE ON seat_admission_changes
BEGIN
  SELECT RAISE(ABORT, 'seat_admission_changes is append-only: DELETE is forbidden');
END;

-- 0172_flight_waiting_and_dispatch_idempotency.sql — mupot#1540.
--
-- NOT APPLIED BY THIS BUILD. Migrations are applied manually by an operator
-- (`wrangler d1 migrations apply`). This header describes the file as authored.
--
-- Three defects, one migration:
--
-- A. NOTHING EVER SET flights.status = 'waiting'.
--    src/flight/watchdog.ts promises a 'waiting' flight (tasks parked at a human/gate
--    review) is NEVER reaped and escalates at 24h — but no code path wrote 'waiting'.
--    A flight stayed 'running' while its tasks sat in review, and the 60-minute running
--    stall timeout reaped it (prod 2026-09-25: 944e37cb, 12b602c2 reaped at ~62 min; the
--    gate approved both tasks hours later and the flights could no longer land).
--
--    The transition is driven HERE, by a trigger on tasks.status, not by any one
--    application call site. There are ~50 `UPDATE tasks` sites across src/ (task_update,
--    task_verdict, the verdict HTTP twin, verdict reversal, the runtime-receipt
--    completed→review path, IM/origin verdicts, workflows …). Hooking each one is the
--    "fix the class on one branch, leave the brick on the other" failure. A trigger is
--    the one choke point every present and future writer passes through, and it runs
--    inside the SAME statement as the task write, so the flight transition and its
--    receipt commit (or roll back) atomically with the task status change that caused
--    it. The transition is receipted (flight_status_transitions), never inferred.
--
--    Semantics ("gate-parked" set = review, approved, done):
--      running → waiting  when EVERY task in meta.task_ids exists and is in the parked
--                         set AND at least one is still at the gate (review/approved).
--                         An all-'done' flight with no gate hop is simply ready to land
--                         and keeps the running clock (unchanged behaviour).
--      waiting → running  when ANY task in meta.task_ids leaves the parked set (a
--                         reject, a reopen, a missing task). resumed_at restarts the
--                         running stall clock, so a flight that waited 5h at a gate is
--                         not reaped the instant it is sent back for rework.
--      waiting → landed   (round 2, gate P0) when EVERY task is 'done' and every gated
--                         task's latest verdict is 'approved' — the SAME task predicate
--                         landGovernedFlight enforces (routine control flights excluded).
--                         A SYSTEM LAND: score NULL (a system land is not a coherence
--                         measurement and must never read as throughput), cost as
--                         recorded, gate_reason 'auto_landed_all_tasks_done', receipted in
--                         flight_status_transitions with that cause. Without this, 'done'
--                         being terminal meant an approved-and-closed flight that nobody
--                         landed stayed 'waiting' FOREVER: unreapable, re-escalated every
--                         sweep, holding scan slots and routine skip-overlap pins.
--                         It only ever fires from 'waiting', i.e. after the flight crossed
--                         a gate; an ungated all-'done' running flight is still the
--                         executor's to land (or the 60m reaper's). It deliberately writes
--                         NO flight_event_outbox row: that table's actor_kind admits only
--                         member|agent, and attributing a system land to the executor would
--                         be a forged actor. The transition receipt is the audit record.
--
--    ROUTINE CONTROL FLIGHTS ARE OUT OF SCOPE of every transition here (round 2): a flight
--    that is some routine_run's flight_id has an owner that already lands it with its own
--    receipt (src/routines/actions.ts completeControlTask → landControlFlight, which
--    REQUIRES the flight.landed outbox row) and whose pin semantics are #1369's. Auto-
--    landing it between those two calls made landControlFlight throw (caught by
--    tests/routine-actions.test.ts). Such a flight behaves exactly as on main.
--
--    Performance (round 2, gate P1-1): tasks carries no tenant column, so the triggers
--    cannot scope by tenant; they scope by flight status instead, through
--    idx_flights_status below — an in-air-status lookup instead of a scan of every flight.
--
--    The trigger must NEVER abort a task write. Every json_* read goes through the
--    CASE WHEN json_valid(...) guard (json_each on malformed JSON raises), and it only
--    touches v1-governed flights.
--
-- B. (no schema change — meta.timeout_ms is validated in src/flight/meta.ts and
--    src/flight/meta-sql.ts.)
--
-- C. DUPLICATE BOOKING. A redelivered booker turn re-dispatched flights for tasks whose
--    flight had already LANDED (prod 454dcfd0, 121ff12e). flight_dispatch now refuses
--    that unless an explicit, receipted override is passed (flight_redispatch_receipts),
--    and accepts an optional client_request_id idempotency key: a retried dispatch with
--    the same key returns the ORIGINAL flight. The key is unique per
--    (tenant, dispatching agent) — scoped to the dispatcher so one agent can neither
--    collide with nor read back another agent's flight by guessing its key.
--
-- Backfill: running v1 flights whose tasks are ALREADY all parked move to waiting now,
-- each with a 'migration_backfill' transition receipt. Flights the watchdog already
-- reaped (status 'failed') are NOT revived — a terminal flight stays terminal; the
-- "late land of a reaped flight" suggestion on #1540 is a separate governed surface.
--
-- Additive: three nullable columns, one partial unique index, two append-only receipt
-- tables, two triggers on tasks. On an empty database this leaves zero rows (the
-- test-harness DDL cache depends on that — tests/helpers-migrations.test.ts).

ALTER TABLE flights ADD COLUMN waiting_since INTEGER;      -- Unix ms; set on → waiting
ALTER TABLE flights ADD COLUMN resumed_at INTEGER;         -- Unix ms; set on waiting → running
ALTER TABLE flights ADD COLUMN client_request_id TEXT;     -- dispatcher-supplied idempotency key
ALTER TABLE flights ADD COLUMN escalated_at INTEGER;       -- Unix ms the watchdog escalated this wait; once per wait

-- The triggers select flights by status only (tasks has no tenant); without this every task
-- status change scanned the whole flights table (gate P1-1: SCAN f, ~185x at 24k flights).
CREATE INDEX IF NOT EXISTS idx_flights_status ON flights (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flights_client_request_id
  ON flights (tenant, dispatched_by_agent_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ── A: receipts for every running⇄waiting transition ────────────────────────────
CREATE TABLE IF NOT EXISTS flight_status_transitions (
  id                     TEXT PRIMARY KEY,
  tenant                 TEXT NOT NULL,
  flight_id              TEXT NOT NULL,
  from_status            TEXT NOT NULL CHECK (from_status IN ('running', 'waiting')),
  to_status              TEXT NOT NULL CHECK (to_status IN ('running', 'waiting', 'landed')),
  cause                  TEXT NOT NULL CHECK (cause IN ('task_status', 'migration_backfill', 'auto_landed_all_tasks_done')),
  cause_task_id          TEXT,
  cause_task_from_status TEXT,
  cause_task_to_status   TEXT,
  created_at             INTEGER NOT NULL,
  CHECK (from_status <> to_status)
);

CREATE INDEX IF NOT EXISTS idx_flight_status_transitions_flight
  ON flight_status_transitions (tenant, flight_id, created_at);

CREATE TRIGGER IF NOT EXISTS flight_status_transitions_no_update
BEFORE UPDATE ON flight_status_transitions
BEGIN
  SELECT RAISE(ABORT, 'flight_status_transitions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS flight_status_transitions_no_delete
BEFORE DELETE ON flight_status_transitions
BEGIN
  SELECT RAISE(ABORT, 'flight_status_transitions is append-only');
END;

-- ── C: receipts for an explicit re-dispatch of already-landed task ids ──────────
CREATE TABLE IF NOT EXISTS flight_redispatch_receipts (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  flight_id         TEXT NOT NULL,           -- the NEW flight the override authorised (same batch as its INSERT)
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent')),
  actor_id          TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  landed_flight_ids TEXT NOT NULL,           -- JSON array: landed flights overridden (may be [])
  task_ids          TEXT NOT NULL,           -- JSON array: task ids already landed / done / approved
  created_at        INTEGER NOT NULL,
  UNIQUE (tenant, flight_id)
);

CREATE TRIGGER IF NOT EXISTS flight_redispatch_receipts_no_update
BEFORE UPDATE ON flight_redispatch_receipts
BEGIN
  SELECT RAISE(ABORT, 'flight_redispatch_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS flight_redispatch_receipts_no_delete
BEFORE DELETE ON flight_redispatch_receipts
BEGIN
  SELECT RAISE(ABORT, 'flight_redispatch_receipts is append-only');
END;

-- ── A: the transition triggers ──────────────────────────────────────────────────
-- Receipt INSERT first, flight UPDATE second, both on the identical predicate: once the
-- UPDATE runs the predicate no longer matches (status changed), so the order matters.
CREATE TRIGGER IF NOT EXISTS flights_enter_waiting_on_task_status
AFTER UPDATE OF status ON tasks
WHEN OLD.status IS NOT NEW.status
 AND NEW.status IN ('review', 'approved', 'done')
BEGIN
  INSERT INTO flight_status_transitions
    (id, tenant, flight_id, from_status, to_status, cause,
     cause_task_id, cause_task_from_status, cause_task_to_status, created_at)
  SELECT lower(hex(randomblob(16))), f.tenant, f.id, 'running', 'waiting', 'task_status',
         NEW.id, OLD.status, NEW.status, unixepoch('now') * 1000
    FROM flights f
   WHERE f.status = 'running'
     AND json_extract(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.flight_id = f.id AND rr.tenant = f.tenant)
     AND json_type(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
         LEFT JOIN tasks t ON t.id = ref.value
        WHERE t.id IS NULL OR t.status NOT IN ('review', 'approved', 'done')
     )
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
         JOIN tasks t ON t.id = ref.value
        WHERE t.status IN ('review', 'approved')
     );

  UPDATE flights
     SET status = 'waiting',
         waiting_since = unixepoch('now') * 1000
   WHERE status = 'running'
     AND json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.flight_id = flights.id AND rr.tenant = flights.tenant)
     AND json_type(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
         LEFT JOIN tasks t ON t.id = ref.value
        WHERE t.id IS NULL OR t.status NOT IN ('review', 'approved', 'done')
     )
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
         JOIN tasks t ON t.id = ref.value
        WHERE t.status IN ('review', 'approved')
     );
END;

CREATE TRIGGER IF NOT EXISTS flights_leave_waiting_on_task_status
AFTER UPDATE OF status ON tasks
WHEN OLD.status IS NOT NEW.status
 AND NEW.status NOT IN ('review', 'approved', 'done')
BEGIN
  INSERT INTO flight_status_transitions
    (id, tenant, flight_id, from_status, to_status, cause,
     cause_task_id, cause_task_from_status, cause_task_to_status, created_at)
  SELECT lower(hex(randomblob(16))), f.tenant, f.id, 'waiting', 'running', 'task_status',
         NEW.id, OLD.status, NEW.status, unixepoch('now') * 1000
    FROM flights f
   WHERE f.status = 'waiting'
     AND json_extract(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND json_type(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     );

  UPDATE flights
     SET status = 'running',
         waiting_since = NULL,
         escalated_at = NULL,
         resumed_at = unixepoch('now') * 1000
   WHERE status = 'waiting'
     AND json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND json_type(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     );
END;

-- ── A (round 2, gate P0): the exit from 'waiting' when the gated work is finished ─────
-- Same task predicate as landGovernedFlight (src/flight/service.ts) — task exists, matches
-- the flight's project, is 'done', and if gated its LATEST verdict is 'approved'. A routine
-- CONTROL flight is never auto-landed: its routine lands it with a receipt (see header).
-- Nothing here can land a flight whose work the gate did not approve.
CREATE TRIGGER IF NOT EXISTS flights_auto_land_on_task_done
AFTER UPDATE OF status ON tasks
WHEN OLD.status IS NOT NEW.status
 AND NEW.status = 'done'
BEGIN
  INSERT INTO flight_status_transitions
    (id, tenant, flight_id, from_status, to_status, cause,
     cause_task_id, cause_task_from_status, cause_task_to_status, created_at)
  SELECT lower(hex(randomblob(16))), f.tenant, f.id, 'waiting', 'landed', 'auto_landed_all_tasks_done',
         NEW.id, OLD.status, NEW.status, unixepoch('now') * 1000
    FROM flights f
   WHERE f.status = 'waiting'
     AND json_extract(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND json_type(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
         LEFT JOIN tasks t ON t.id = ref.value
        WHERE t.id IS NULL
           OR (f.project_id IS NOT NULL AND t.project_id IS NOT f.project_id)
           OR t.status <> 'done'
           OR (
             t.gate_owner IS NOT NULL
             AND COALESCE((
               SELECT v.verdict FROM task_verdicts v
                WHERE v.task_id = t.id
                ORDER BY v.decided_at DESC, v.id DESC
                LIMIT 1
             ), '') <> 'approved'
           )
     )
     AND NOT EXISTS (
       SELECT 1 FROM routine_runs rr
        WHERE rr.flight_id = f.id AND rr.tenant = f.tenant
     );

  UPDATE flights
     SET status = 'landed',
         score = NULL,
         gate_reason = 'auto_landed_all_tasks_done',
         ended_at = unixepoch('now') * 1000
   WHERE status = 'waiting'
     AND json_extract(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
     AND json_type(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') = 'array'
     AND EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
        WHERE ref.value = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(flights.meta) THEN flights.meta ELSE '{}' END, '$.task_ids') ref
         LEFT JOIN tasks t ON t.id = ref.value
        WHERE t.id IS NULL
           OR (flights.project_id IS NOT NULL AND t.project_id IS NOT flights.project_id)
           OR t.status <> 'done'
           OR (
             t.gate_owner IS NOT NULL
             AND COALESCE((
               SELECT v.verdict FROM task_verdicts v
                WHERE v.task_id = t.id
                ORDER BY v.decided_at DESC, v.id DESC
                LIMIT 1
             ), '') <> 'approved'
           )
     )
     AND NOT EXISTS (
       SELECT 1 FROM routine_runs rr
        WHERE rr.flight_id = flights.id AND rr.tenant = flights.tenant
     );
END;

-- ── Backfill: running flights already parked at a gate ──────────────────────────
INSERT INTO flight_status_transitions
  (id, tenant, flight_id, from_status, to_status, cause, created_at)
SELECT lower(hex(randomblob(16))), f.tenant, f.id, 'running', 'waiting', 'migration_backfill',
       unixepoch('now') * 1000
  FROM flights f
 WHERE f.status = 'running'
   AND json_extract(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
   AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.flight_id = f.id AND rr.tenant = f.tenant)
   AND json_type(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') = 'array'
   AND NOT EXISTS (
     SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
       LEFT JOIN tasks t ON t.id = ref.value
      WHERE t.id IS NULL OR t.status NOT IN ('review', 'approved', 'done')
   )
   AND EXISTS (
     SELECT 1 FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
       JOIN tasks t ON t.id = ref.value
      WHERE t.status IN ('review', 'approved')
   );

UPDATE flights
   SET status = 'waiting',
       waiting_since = unixepoch('now') * 1000
 WHERE id IN (
   SELECT flight_id FROM flight_status_transitions
    WHERE cause = 'migration_backfill' AND to_status = 'waiting'
 )
   AND status = 'running';

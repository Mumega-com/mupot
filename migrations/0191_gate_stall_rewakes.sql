-- 0191_gate_stall_rewakes.sql — durable claim ledger for the gate-stall watchdog (mupot#1705).
--
-- WHY: a task parked in 'review' with a live gate_owner and no verdict was never re-woken; the
-- unattended loop stalled silently (task d9f6b672, ~7.5h). The maintenance sweep
-- (src/gates/stall-watchdog.ts) re-sends the gate wake, at most once per threshold window and at
-- most N times per review episode. This table is that bound, recorded durably.
--
-- One row per task. review_since is the tasks.updated_at the claim was made against: a task that
-- re-enters review (or is otherwise touched) carries a different updated_at, which starts a new
-- episode with a fresh budget. The claim is a single atomic UPSERT…WHERE (never read-compare-write),
-- so concurrent sweeps cannot both win.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code — the Needs You approvals query
-- (src/attention/service.ts) reads this table.
--
-- CREATE-only; touches no existing table. No FK: the row is a bookkeeping ledger and must never
-- block a task delete or be cascaded by one.

CREATE TABLE IF NOT EXISTS gate_stall_rewakes (
  task_id        TEXT NOT NULL PRIMARY KEY,
  review_since   TEXT NOT NULL,                 -- tasks.updated_at observed at claim time
  rewake_count   INTEGER NOT NULL DEFAULT 0,      -- claims (attempts) this episode; bounds the cap
  delivered_count INTEGER NOT NULL DEFAULT 0,     -- re-wakes that actually reached a holder (delivered|partial); the only count shown to humans
  last_rewake_at TEXT NOT NULL,                 -- ISO-8601
  last_outcome   TEXT                           -- GateWakeOutcome.status of the last re-wake
);

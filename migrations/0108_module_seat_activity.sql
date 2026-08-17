-- 0108_module_seat_activity.sql — what a seat is DOING, alongside whether it is REACHABLE.
--
-- mupot#1117. module_registry already answers "is this module reachable?" via
-- status + last_heartbeat (staleness read-derived, never written — see
-- src/registry/service.ts effectiveStatus). It cannot answer "what is it doing
-- right now?", and on 2026-08-16 that gap cost an entire evening: services read
-- `active` while crash-looping 21 times in 3 minutes, a wedged watcher was
-- indistinguishable from a quiet one, and a seat that had been blocked for
-- fifty minutes looked exactly like a seat mid-task.
--
-- Reachability and activity are ORTHOGONAL axes. A seat can be reachable and
-- wedged; reachable and resting; unreachable with a stale 'working' as its last
-- word. Collapsing them into one field is what produced every false-green we
-- catalogued that night.
--
-- THE CONTRACT IS NOT INVENTED HERE. prime-agent already ships a built-in
-- reporter (dist/core/extensions/builtin/herdr-agent-state.js) that emits
-- exactly working|idle|blocked with a message and a MONOTONIC seq, and releases
-- cleanly on quit. These columns are that same contract, given a home that
-- aggregates across hosts instead of one per-machine socket. Adopting the
-- existing wire shape means prime-agent seats report with no new integration.
--
-- NAMING, deliberately: the column is `activity`, NOT `status`. `status` on this
-- table already means reachability (online/offline), and the word "idle" means
-- OPPOSITE things in the two vocabularies — a derived-stale presence "idle"
-- means "we have not heard from it", while an agent-reported "idle" means
-- "healthy, resting, nothing to do". Two axes, two names, no overload.

-- working | idle | blocked | done. NULL = this seat has NEVER reported activity
-- (an unreported seat is not the same as an idle one, and must not read as idle).
-- Values are validated in code (src/registry/service.ts ACTIVITY_STATES) rather
-- than by a CHECK constraint: SQLite cannot add a CHECK via ALTER TABLE ADD
-- COLUMN, and rebuilding this table to gain one is not worth the migration risk.
ALTER TABLE module_registry ADD COLUMN activity TEXT;

-- Why it is blocked / what it is working on. Only meaningful alongside `activity`.
-- A blocked seat that cannot say what it is blocked ON is barely more useful than
-- no signal at all, which is why the reporter carries this field.
ALTER TABLE module_registry ADD COLUMN activity_message TEXT;

-- Monotonic per-seat sequence. Reports carrying a seq <= the stored one are
-- SILENTLY IGNORED for the activity fields (the heartbeat itself still lands).
-- This is herdr's own guard, and it exists because reports race: a session that
-- resumes, forks, or reloads can emit out of order, and a late 'working' landing
-- after a 'done' would pin the seat as busy forever.
ALTER TABLE module_registry ADD COLUMN activity_seq INTEGER NOT NULL DEFAULT 0;

-- When `activity` last CHANGED — not when it was last re-asserted. This is the
-- column that makes wedge detection possible: a seat re-sending 'working' every
-- 30 seconds for an hour has a fresh heartbeat and a fresh report, and only a
-- transition timestamp reveals it has not actually moved. Distinguishing
-- "re-asserted" from "changed" is the whole point; do not update this on every
-- report.
ALTER TABLE module_registry ADD COLUMN activity_at TEXT;

-- When an activity report was last ACCEPTED — distinct from activity_at (last CHANGE) and
-- from last_heartbeat (reachability, which advances even for a REJECTED report).
--
-- Without this, a rejected-seq storm is invisible. Loom's #1118 gate scenario: process A
-- reports seq 100 then crashes; an old clone keeps emitting seq 99 every 90 seconds. The
-- row stays 'online' forever because the heartbeat always lands, activity stays frozen at
-- A's last value because every report loses the seq comparison, and NOTHING tells an
-- operator that every current report is being thrown away. That is split-brain presented
-- as health.
--
-- With all three timestamps a reader can separate the cases: last_heartbeat fresh +
-- activity_report_at stale means reports are arriving and being REJECTED; both stale means
-- the seat went quiet; activity_report_at fresh + activity_at old means it is genuinely
-- holding one state (a long turn, or a wedge).
ALTER TABLE module_registry ADD COLUMN activity_report_at TEXT;

-- Find wedged/blocked seats without scanning the tenant: the dashboard's
-- "who needs attention" query orders by how long a seat has held one activity.
CREATE INDEX IF NOT EXISTS idx_module_registry_activity
  ON module_registry(tenant, activity, activity_at);

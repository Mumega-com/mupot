-- 0163_fleet_agents_presence_mode.sql — poll-mode presence for external runners (mupot#1494).
--
-- Additive only, no backfill: every existing row keeps presence_mode='' and
-- presence_ttl_sec=NULL, so src/fleet/registry.ts's derivePresence keeps reading the ONE global
-- presenceTtlSec(env) window for every row this migration doesn't touch — resident/signed-attach
-- semantics are completely unchanged.
--
-- Why this is needed: a polling runner (cron, an external orchestrator, a laptop that wakes
-- every N minutes — no resident heartbeat daemon) has no way to stay inside the global
-- presence_ttl_sec window without polling far more often than its own cadence justifies, so
-- task_dispatch's liveness check never saw it as live and it could never receive dispatched
-- work (see the issue's "Runner onboarding is not smooth" report). check_in accepts
-- presence_mode:'poll' + poll_interval_sec, computes a per-row TTL
-- (max(180, 2*poll_interval_sec) — see pollPresenceTtlSec) and stores it here; last_reported_at
-- is then refreshed on every subsequent authenticated call that agent makes
-- (touchPollFleetPresence), so a faithfully-polling runner reads as continuously live on its
-- own declared cadence.
ALTER TABLE fleet_agents ADD COLUMN presence_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE fleet_agents ADD COLUMN presence_ttl_sec INTEGER;

-- Second half of #1494: task_dispatch's routing decision (src/bus/consumer.ts routeEvent,
-- 'agent.wake' case) must "never silently" fall back to the in-Worker executor — record which
-- route was actually taken, durably, on the SAME receipt row a caller/operator already reads
-- for dispatch state. Additive, nullable, no backfill: a NULL here just means "dispatched before
-- this migration" (or an event still mid-flight), not a distinct third route.
ALTER TABLE task_dispatch_receipts ADD COLUMN delivered_via TEXT
  CHECK (delivered_via IS NULL OR delivered_via IN ('inbox', 'in_worker'));

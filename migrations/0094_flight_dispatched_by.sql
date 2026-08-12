-- 0094_flight_dispatched_by.sql — record WHO DISPATCHED a flight, distinct from
-- WHO FLIES IT (mupot flight_dispatch executor-delegation defect).
--
-- THE DEFECT: flight_dispatch (src/mcp/index.ts) always set flight.agent =
-- auth.boundAgentId — the caller's own bound agent. There was no way to dispatch
-- a flight whose EXECUTOR is a different agent than the dispatcher. A member who
-- wanted agent B to do the work had to dispatch under their OWN seat (flight.agent
-- = dispatcher) then hand the work to B out-of-band (a manual task_update), which
-- left the flight record PERMANENTLY WRONG about who actually did the work —
-- flight.agent said the dispatcher, forever, no matter who executed.
--
-- THE FIX makes flight.agent mean what its column comment always said ("who
-- flies") — the EXECUTOR — and adds this column to keep the DISPATCHER
-- honestly recoverable too. Both facts must survive in the record; neither may
-- be inferred by overwriting the other. See src/mcp/index.ts's flight_dispatch
-- (executor_agent_id param + the lead-on-executor's-squad authz gate, mirroring
-- wake_agent's "make another agent act" precedent) and src/flight/service.ts's
-- createFlight (dispatched_by_agent_id column).
--
-- BACKFILL: every row that predates this migration was dispatched under the
-- old always-self semantics — dispatcher WAS the executor, no exceptions (the
-- delegation path did not exist before this migration). Backfilling
-- dispatched_by_agent_id = agent for those rows is therefore a true historical
-- fact, not a fabrication. New rows always pass this column explicitly from
-- application code (src/flight/service.ts#createFlight defaults it to f.agent
-- when the caller does not separately specify a dispatcher, e.g. schedule/cron
-- dispatch has no distinct human-delegator identity) — the '' DEFAULT below
-- exists only to satisfy SQLite's ADD COLUMN NOT NULL requirement on the
-- pre-existing rows and is never relied on afterward.
--
-- Same ALTER-TABLE-ADD-COLUMN-NOT-NULL-DEFAULT shape as 0093
-- (org_kind_home_exemption.sql) — verified there against node:sqlite that SQLite
-- backfills every existing row to the DEFAULT at ALTER time, which is what lets
-- the UPDATE below see '' on every old row.

ALTER TABLE flights ADD COLUMN dispatched_by_agent_id TEXT NOT NULL DEFAULT '';

UPDATE flights SET dispatched_by_agent_id = agent WHERE dispatched_by_agent_id = '';

-- Read-path index: "what has agent X dispatched (to others)" / audit queries.
CREATE INDEX IF NOT EXISTS idx_flights_dispatched_by ON flights(tenant, dispatched_by_agent_id);

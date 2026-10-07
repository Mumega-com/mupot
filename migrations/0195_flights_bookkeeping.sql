-- 0195_flights_bookkeeping.sql — mupot#1762. Deploy (projects/deploy.ts) and Studio (dashboard/studio.ts)
-- create unexecuted bookkeeping flights: they sit in 'preflight' with a NULL budget, have no lifecycle, and
-- are only ever closed by the watchdog / cancelFlight / flight_reap_stalled. bookkeeping=1 marks them so the
-- flight-clearance HOLD read (listIntersectingLiveFlights) cannot be blocked by a flight that will never
-- execute. SERVER-SET ONLY: createFlight writes it solely from its internal CreateFlightOptions (never from
-- NewFlight / meta / REST / MCP input), and no UPDATE path touches it. Additive, no backfill: DEFAULT 0 keeps
-- every existing flight a real, HOLD-able flight.
ALTER TABLE flights ADD COLUMN bookkeeping INTEGER NOT NULL DEFAULT 0 CHECK (bookkeeping IN (0,1));

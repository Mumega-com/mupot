-- 0267_flight_harness_model.sql — a landed flight names the harness and model that flew it.
--
-- Brief P3 (v0.33 "Proof in", criterion 2, Hadi 2026-10-29): the flights table records
-- who flew and what it cost, but never WHAT harness/model executed, so a landed receipt
-- cannot prove criterion 2 ("10 agents across 3 harnesses on flights").
--
-- Source of truth is SERVER-DERIVED: the land path reads the executing agent's
-- fleet_agents row (runtime -> harness, model) and writes it here. A caller-supplied
-- value may CLAIM but never override (see src/flight/service.ts landGovernedFlight).
-- NULL means "no fleet row existed at land time" — the honest value, rendered 'unknown'
-- at the read seam, never fabricated. Additive only; no backfill (out of scope).
ALTER TABLE flights ADD COLUMN harness TEXT;
ALTER TABLE flights ADD COLUMN model TEXT;

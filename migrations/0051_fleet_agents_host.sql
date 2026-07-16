-- 0051_fleet_agents_host.sql — self-reported HOST signal on fleet_agents (#21 slice 2).
--
-- The panel/radar can't detect where an agent physically runs (it sees a token, not a
-- machine) — there is no hostname signal anywhere in presence/registry today (see the
-- "honest gaps" note in src/dashboard/radar-view.ts from slice 1). Each agent runtime now
-- SELF-REPORTS its own hostname in the fleet report / attach payload; this column is the
-- storage for that string.
--
-- host is UNTRUSTED, agent-controlled, DISPLAY-ONLY: never used for auth/routing/tenant
-- isolation decisions — same "display cache, not authority" posture as the rest of this
-- table (see 0035_fleet_agents.sql header). Length-capped (64 chars) and HTML-escaped on
-- render (src/dashboard/radar-view.ts).
--
-- Additive-only, matches the existing NOT NULL DEFAULT '' column style already used
-- throughout this table (display, runtime, lifecycle, ...). Empty string = unknown/not
-- yet reported — no backfill needed, no table recreate.

ALTER TABLE fleet_agents ADD COLUMN host TEXT NOT NULL DEFAULT '';

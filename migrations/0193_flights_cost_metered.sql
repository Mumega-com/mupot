-- 0193_flights_cost_metered.sql — mupot#1732. A flight whose executor has no spend meter
-- (e.g. a Codex cloud agent) must land honestly: cost_metered=0 means "never measured",
-- distinct from a measured cost of 0. cost_micro_usd stays 0 on such rows (NOT NULL
-- column); readers must treat cost_metered=0 as cost unknown, not zero.
-- Additive, no backfill: every existing row is metered (DEFAULT 1).
ALTER TABLE flights ADD COLUMN cost_metered INTEGER NOT NULL DEFAULT 1 CHECK (cost_metered IN (0,1));

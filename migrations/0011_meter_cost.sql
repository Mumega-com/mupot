-- Cost metering (issue #15): dollar spend on top of the token counters.
--
-- Two surfaces need a cost number:
--   1. The work-unit card's Burn gauge ($X/hr) — derived from per-(agent, day)
--      spend in execution_meter. So execution_meter gains a cost column.
--   2. The observatory's per-task cost chip — so the tasks row gains a cost column
--      stamped at execution time.
--
-- UNIT: micro-USD (millionths of a dollar), stored as an INTEGER.
--   Why not cents? A single small Workers-AI call costs a fraction of one cent;
--   integer cents would round every cycle to 0 and the gauge would read empty.
--   micro-USD keeps the value integer-exact while preserving sub-cent resolution.
--   Conversion: dollars = cost_micro_usd / 1_000_000.
--   Derivation (see src/agents/cost.ts): cost_micro_usd = round(tokens * rate),
--   where rate is the model's blended USD-per-1M-token price (so tokens * rate is
--   already in micro-USD).
--
-- These are ESTIMATES. The token figure itself is the conservative EXECUTE_MAX_TOKENS
-- bound until the model port surfaces real usage; the rate is a blended per-model
-- constant. The number is an honest order-of-magnitude burn signal, not an invoice.

ALTER TABLE execution_meter ADD COLUMN cost_micro_usd INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks ADD COLUMN cost_micro_usd INTEGER NOT NULL DEFAULT 0;

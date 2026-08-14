-- 0102_execution_meter_cache_split.sql — cache-aware metering columns on execution_meter.
--
-- Why: recordTokens billed a flat estimate (EXECUTE_MAX_TOKENS) at a blended rate,
-- overstating loop cost ~100x for DeepSeek (cache-hit tokens billed at full input
-- price). The meter now records the cache split so the bill reflects reality and
-- the budget meter stops blocking early. Columns are additive; existing rows keep
-- working (defaults 0 = "cache not measured").
--
-- Slots: main head 0099; 0100 claimed by secret_env (PR branch), 0101 by
-- 0101_module_registry_model.sql (G-3 convergence flight). 0102 is the free slot.

ALTER TABLE execution_meter ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_meter ADD COLUMN cache_miss_tokens  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_meter ADD COLUMN output_tokens      INTEGER NOT NULL DEFAULT 0;

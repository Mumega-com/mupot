-- 0020_field_source.sql — field-state provenance (the hybrid fallback brain, v0.20).
--
-- agent_field rows now carry WHO measured them:
--   'mind'         — pushed inbound by the external brain (SOS/sovereign fork), as before.
--   'pot_fallback' — measured by the pot's own minimal fallback brain (src/brain/), which
--                    runs only when no fresh mind push exists and never overwrites one.
--
-- Provenance keeps the never-fork-the-brain rule honest in hybrid mode: orient can tell
-- an agent whether its field half is the mind's measure or the pot's local approximation,
-- and the fallback's writes are guarded so a waking mind always reclaims the row.

ALTER TABLE agent_field ADD COLUMN source TEXT NOT NULL DEFAULT 'mind';

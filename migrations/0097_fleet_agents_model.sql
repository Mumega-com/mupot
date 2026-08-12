-- 0097_fleet_agents_model.sql — runtime-reported model on fleet_agents (harness-native-mupot, lane A).
--
-- The harness checkin (POST /api/fleet/attach with runtime='pi' + model) reports the seat's
-- ACTUAL runtime model on session start + model change. fleet_agents.model is the
-- runtime-truth copy; agents.model (the identity record the dashboard reads) is updated by
-- the same upsert — one truth, two writes, so the Fleet Activity view shows live models.
-- model is untrusted display metadata (reported-truth, never canonical authority until a
-- future profile/policy lock exists — gate-protocol v2 Appendix A discipline).
ALTER TABLE fleet_agents ADD COLUMN model TEXT;

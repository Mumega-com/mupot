-- 0131_seven_axis_presence.sql — 7-axis multi-harness seat declaration.
--
-- Presence was already unique per (tenant, member_id, label) after 0119, so
-- distinct seats coexist. This migration adds the remaining seat-identity
-- axes so a check_in can declare harness, machine, model, provider, effort,
-- and the leased flight without collapsing siblings.
--
-- Non-breaking ALTER TABLE ADD COLUMN. Existing rows keep NULL / 'unknown'
-- defaults; writers COALESCE so a heartbeat that omits an axis does not wipe
-- a previously declared value.

ALTER TABLE presence ADD COLUMN harness TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE presence ADD COLUMN machine TEXT;
ALTER TABLE presence ADD COLUMN model TEXT;
ALTER TABLE presence ADD COLUMN provider TEXT;
ALTER TABLE presence ADD COLUMN effort TEXT;
ALTER TABLE presence ADD COLUMN flight_id TEXT;

CREATE INDEX IF NOT EXISTS idx_presence_tenant_harness ON presence(tenant, harness);
CREATE INDEX IF NOT EXISTS idx_presence_tenant_flight ON presence(tenant, flight_id);

-- 0161_member_home_provisioning_receipts.sql — audit trail for
-- createHomeForMember calls triggered by a bound member's first IM contact
-- (FP-01 Slice 2 v2, successor to PR #1488, mupot-plugin PR #19 v2 contract
-- §2f(a) point 3 + Athena's design ruling: "AUDITED — write the creation to
-- a NAMED existing ledger ... name it in the PR body and test the row.").
-- NOT applied by this build — branch/schema only, exactly like
-- 0143/0144/0147/0148/0157/0158/0159/0160 before it; a human applies it.
--
-- WHY A NEW TABLE, NOT AN EXISTING RECEIPT LEDGER
--
-- The same audit already done for 0157's own header (createHomeForMember's
-- 'repaired' disposition, mupot#1472) applies here too: no existing table
-- fits without stretching its meaning.
--   * agent_audit (0086) — agent_id NOT NULL; this event has no agent, only
--     a member acting under their own standing.
--   * membership_receipts (0115) — target_agent_id NOT NULL, scoped to
--     squad_member_add/remove on an AGENT; createHomeForMember writes a
--     squads row + a MEMBER capability row, a different shape entirely.
--   * door_receipts (0107) — door_id NOT NULL, scoped to the onboarding-door
--     self-service consent flow, a deliberately DIFFERENT authority path
--     (see 0157's own header for the same ruling applied to the
--     project_access grant chain).
--   * project_access_grant_receipts (0157/0160) — scoped to project access
--     grants and re-intake authorizations; a home squad is not a project
--     grant, and cramming a third, unrelated `kind` into that table would
--     repeat exactly the "stretch an existing table to cover a shape it was
--     not designed for" mistake 0157's header explicitly rejected for
--     door_receipts/membership_receipts.
-- A fourth, purpose-built table is narrower than stretching any of these.
--
-- SHAPE follows the SAME append-only receipt idiom as 0086/0115/0157:
--   * TEXT id (UUID), no AUTOINCREMENT surrogate.
--   * NO foreign key to members/squads — same reasoning as 0086/0115/0157:
--     a member or squad retirement must never cascade-erase the record of
--     how a home was provisioned.
--   * disposition mirrors createHomeForMember's own CreateHomeForMemberOk
--     union ('created' | 'existing') plus 'failed' for the honest case
--     where provisioning did not succeed on this attempt (memberIntakeEnvelope
--     never fabricates a home_squad_id when this is 'failed' — see
--     src/im/index.ts).
--   * append-only, enforced by trigger, not convention.

CREATE TABLE IF NOT EXISTS member_home_provisioning_receipts (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant       TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  squad_id     TEXT,                          -- the home squad id; NULL when disposition = 'failed'
  channel      TEXT NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram')),
  disposition  TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_member_home_provisioning_receipts_member
  ON member_home_provisioning_receipts(member_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS member_home_provisioning_receipts_no_update
  BEFORE UPDATE ON member_home_provisioning_receipts
BEGIN
  SELECT RAISE(ABORT, 'member_home_provisioning_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS member_home_provisioning_receipts_no_delete
  BEFORE DELETE ON member_home_provisioning_receipts
BEGIN
  SELECT RAISE(ABORT, 'member_home_provisioning_receipts is append-only');
END;

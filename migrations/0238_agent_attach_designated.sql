-- 0238_agent_attach_designated.sql -- seat_attach: attach only to owner-designated agents (flag SEAT_ATTACH_DESIGNATED, default off).
-- Audit: agents/kasra/docs/audit-seat-attach-and-codex-path-20261018.md section 5.
--
-- agents.attach_designated_member_id: the ONE human an agent is designated attachable for. NULL (every existing agent)
-- = not attachable once SEAT_ATTACH_DESIGNATED is on. Written ONLY through the owner door (authorizeOwnerMemberChange
-- with the self-target waiver removed: org-scope floor + target-rank ceiling), by update_agent / the dashboard, and
-- audited by the agent_audit row updateAgentProfile writes in the same batch. Nothing reads it while the flag is off.
-- The read side is ONE predicate (src/members/seat-attach.ts attachDesignatedClause) used at every attach site.
--
-- ADD COLUMN only: no table is rebuilt.
ALTER TABLE agents ADD COLUMN attach_designated_member_id TEXT REFERENCES members(id);

-- Un-designating (or re-pointing) ends everything the old designation authorised, so re-designating the same human can never
-- revive a dormant attachment or admission without a NEW passkey. LIVE admissions of the old designee are revoked (the existing
-- agent_seat_admissions_revoke_attachments trigger then detaches every attachment and revokes its token); PENDING ones are denied.
-- Reads additionally re-check the designation (attachDesignatedClause), so this is the tidy-up that makes revival impossible.
CREATE TRIGGER IF NOT EXISTS agents_attach_designation_end
AFTER UPDATE OF attach_designated_member_id ON agents
FOR EACH ROW
WHEN OLD.attach_designated_member_id IS NOT NULL AND NEW.attach_designated_member_id IS NOT OLD.attach_designated_member_id
BEGIN
  UPDATE agent_seat_admissions
     SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by_member_id = NULL
   WHERE agent_id = OLD.id AND human_member_id = OLD.attach_designated_member_id AND status = 'live';
  UPDATE agent_seat_admissions
     SET status = 'denied', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE agent_id = OLD.id AND human_member_id = OLD.attach_designated_member_id AND status = 'pending';
END;

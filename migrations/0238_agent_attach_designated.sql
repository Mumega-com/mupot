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

-- ANY change of the designation (set null->H, re-point X->H, clear) ends every admission the agent has, for everyone: LIVE
-- admissions are revoked (the existing agent_seat_admissions_revoke_attachments trigger then detaches every attachment and revokes
-- its token) and PENDING ones are denied. So re-designating the same human, or designating someone whose approval predates the
-- designation, always needs a NEW passkey: no dormant pre-flag / pre-designation approval can revive. Reads also re-check the
-- designation (attachDesignatedClause); this is the tidy-up that makes revival impossible.
-- The trigger fires only when the column is written (the owner door); nothing writes it until the feature is used, so today's
-- attachments are untouched while no designation exists.
CREATE TRIGGER IF NOT EXISTS agents_attach_designation_end
AFTER UPDATE OF attach_designated_member_id ON agents
FOR EACH ROW
WHEN NEW.attach_designated_member_id IS NOT OLD.attach_designated_member_id
BEGIN
  UPDATE agent_seat_admissions
     SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by_member_id = NULL
   WHERE agent_id = OLD.id AND status = 'live';
  UPDATE agent_seat_admissions
     SET status = 'denied', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE agent_id = OLD.id AND status = 'pending';
END;

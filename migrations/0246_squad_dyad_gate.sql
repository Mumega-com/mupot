-- 0246 squad dyad pair: an APPROVED, PINNED two-agent review pairing for a squad.
--
-- When dyad_agent_a / dyad_agent_b are set (always together), a task_create in that squad by
-- one of the pair with NO explicit gate_owner defaults gate_owner to the other's gate
-- (gate:<peer.slug>), only if the peer is the EXCLUSIVE live holder of that capability.
-- The human is not the default code reviewer. Pinning (not "whichever two are active")
-- means roster drift never changes who the peer is. NULL/NULL = policy off, every existing
-- squad unchanged. Set/cleared only by an org owner/admin (update_squad); both agents must
-- be active members of the squad at set time and are re-checked at every use.
ALTER TABLE squads ADD COLUMN dyad_agent_a TEXT;
ALTER TABLE squads ADD COLUMN dyad_agent_b TEXT;
CREATE TRIGGER IF NOT EXISTS squads_dyad_pair_shape_ins BEFORE INSERT ON squads
WHEN (NEW.dyad_agent_a IS NULL) != (NEW.dyad_agent_b IS NULL) OR NEW.dyad_agent_a = NEW.dyad_agent_b
BEGIN SELECT RAISE(ABORT, 'dyad pair must be two distinct agents set together'); END;
CREATE TRIGGER IF NOT EXISTS squads_dyad_pair_shape_upd BEFORE UPDATE OF dyad_agent_a, dyad_agent_b ON squads
WHEN (NEW.dyad_agent_a IS NULL) != (NEW.dyad_agent_b IS NULL) OR NEW.dyad_agent_a = NEW.dyad_agent_b
BEGIN SELECT RAISE(ABORT, 'dyad pair must be two distinct agents set together'); END;

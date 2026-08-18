-- 0112_memberships_delete_receipt.sql
--
-- memberships FKs CASCADE on agent/squad delete (0001 / 0111). Receipts do
-- NOT cascade (0110). After honouring input.capability, a surviving add
-- receipt would ASSERT that authority is still live once the membership row
-- is gone — a false positive, worse than the original silent gap.
--
-- SQLite fires AFTER DELETE on the child when CASCADE deletes it, provided
-- foreign_keys is ON. D1 cannot turn foreign_keys OFF inside a migration
-- transaction (PRAGMA is a documented no-op); CASCADE therefore fires on D1
-- the same way it fires here. Verified against node:sqlite with
-- PRAGMA foreign_keys=ON: DELETE parent → child gone AND this trigger wrote
-- a removal receipt. Fallback (transactional revoke, no cascade) is not
-- required.
--
-- Covers cascade and direct DELETE identically. Application-level remove
-- receipts still record the operator; this trigger records the row death
-- itself as actor 'system:cascade'. Two remove rows on a tool-path delete
-- is the acceptable cost of a trail that cannot be bypassed in application
-- code.

CREATE TRIGGER memberships_write_removal_receipt
AFTER DELETE ON memberships
BEGIN
  INSERT INTO membership_receipts (
    id, tenant, actor_member_id, actor_bound_agent_id, target_agent_id,
    squad_id, action, capability, prior_capability, result
  )
  VALUES (
    'cascade-' || OLD.id,
    COALESCE(
      (SELECT tenant FROM agent_member_bindings WHERE agent_id = OLD.agent_id LIMIT 1),
      (SELECT tenant FROM members WHERE tenant IS NOT NULL LIMIT 1),
      'system'
    ),
    'system:cascade',
    NULL,
    OLD.agent_id,
    OLD.squad_id,
    'remove',
    NULL,
    OLD.capability,
    'removed'
  );
END;

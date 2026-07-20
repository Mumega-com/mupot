-- Scheduled identity integrity check for
-- docs/architecture/identity-access-fix-map.md Phase 0.
-- Read-only SQLite detection queries. A nonzero result set on any query is a
-- durability finding that needs human cleanup (not auto-fixed here).

-- AMBIGUOUS AGENTS: nonzero rows mean one agent_id is bound (via live tokens)
-- to more than one active member — agent identity is ambiguous.
SELECT
  t.agent_id,
  COUNT(DISTINCT t.member_id) AS count
FROM member_tokens AS t
JOIN members AS m ON m.id = t.member_id
WHERE t.revoked_at IS NULL
  AND t.agent_id IS NOT NULL
  AND m.status = 'active'
GROUP BY t.agent_id
HAVING COUNT(DISTINCT t.member_id) > 1;

-- ESCALATION-GUARD VIOLATIONS: nonzero rows mean a member with email IS NULL
-- holds org-scope admin or owner — mint escalation guard was bypassed.
SELECT
  c.member_id,
  c.capability
FROM capabilities AS c
JOIN members AS m ON m.id = c.member_id
WHERE m.email IS NULL
  AND c.scope_type = 'org'
  AND c.capability IN ('admin', 'owner');

-- ORPHAN TOKENS: nonzero rows mean member_tokens.agent_id does not match any
-- agents.id — dangling agent binding (app-layer only; no DB FK).
SELECT
  t.id,
  t.agent_id
FROM member_tokens AS t
WHERE t.agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agents AS a
    WHERE a.id = t.agent_id
  );

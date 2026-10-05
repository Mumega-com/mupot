-- mupot#1646 — READ-ONLY detection of department-scope grants / unredeemed invites that
-- target a member's home department (kind='home'). Run against prod D1 by a human:
--   npx wrangler d1 execute <db> --remote --file scripts/detect-home-department-grants.sql
-- Any row returned is a bad grant. Cleanup is a SEPARATE, human-approved step; this file
-- never writes.

-- 1. standing department-scope grants on a home department (the exploit's end state)
SELECT c.id AS capability_id, c.member_id, c.capability, c.scope_id AS department_id, d.slug, c.created_at
  FROM capabilities c
  JOIN departments d ON d.id = c.scope_id
 WHERE c.scope_type = 'department' AND d.kind = 'home';

-- 2. same, for departments that merely LOOK like homes but are kind != 'home' (slug-prefix drift)
SELECT c.id AS capability_id, c.member_id, c.scope_id AS department_id, d.slug, d.kind
  FROM capabilities c
  JOIN departments d ON d.id = c.scope_id
 WHERE c.scope_type = 'department' AND d.kind != 'home' AND d.slug LIKE 'dept-home-%';

-- 3. department grants whose department contains a home squad but is not itself kind='home'
SELECT DISTINCT c.id AS capability_id, c.member_id, c.scope_id AS department_id, s.id AS home_squad_id
  FROM capabilities c
  JOIN squads s ON s.department_id = c.scope_id AND s.kind = 'home'
  JOIN departments d ON d.id = c.scope_id
 WHERE c.scope_type = 'department' AND d.kind != 'home';

-- 4. unredeemed invites already aimed at a home department (now refused at redemption)
SELECT i.id AS invite_id, i.email, i.capability, i.department_id, i.invited_by, i.created_at
  FROM invites i
  JOIN departments d ON d.id = i.department_id
 WHERE d.kind = 'home' AND i.accepted_at IS NULL;

-- 5. already-redeemed invites onto a home department (accepted_at set, member_id minted)
SELECT i.id AS invite_id, i.email, i.member_id, i.capability, i.department_id, i.accepted_at
  FROM invites i
  JOIN departments d ON d.id = i.department_id
 WHERE d.kind = 'home' AND i.accepted_at IS NOT NULL;

-- 0245 — backfill each active seat agent's OWN lane gate (gate:<its own slug>), the same grant the mint path
-- gives (src/members/service.ts) and seat_select now gives at creation (src/members/seat-select.ts).
-- Before this, an agent created by seat_select could never hold the gate of a task routed to its own lane.
-- SCOPE: capability is exactly 'gate:' || that agent's slug, principal is that agent. No other gate, no member
-- principal, nothing for inactive agents. Idempotent (INSERT OR IGNORE on UNIQUE(capability, principal_type, principal_id)).
-- A fresh DB has no agent_seats rows, so this writes nothing there (gate_grants stays empty after migrations).
INSERT OR IGNORE INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
SELECT lower(hex(randomblob(16))), 'gate:' || a.slug, 'agent', a.id, 'system:backfill-0245', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM agents a
 WHERE a.status = 'active'
   AND a.id IN (SELECT agent_id FROM agent_seats)
   AND a.slug IS NOT NULL AND a.slug <> '';

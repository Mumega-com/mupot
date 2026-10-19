-- 0245 — backfill each seat agent's OWN lane gate (gate:<its own slug>), the same grant the mint path
-- gives (src/members/service.ts) and seat_select now gives at creation (src/members/seat-select.ts).
-- Before this, an agent created by seat_select could never hold the gate of a task routed to its own lane.
-- SCOPE (tight on purpose): only SERVER-DERIVED slugs. A seat agent's slug is 'seat-' || first 12 chars of its
-- seat's key_hash (src/members/seat-select.ts); an agent renamed to anything else (e.g. 'hadi') gets NOTHING.
-- Capability is exactly 'gate:' || that slug, principal is that agent. Skips archived agents, inactive agents and
-- retired seats; paused agents ARE included (hasActiveGateGrant refuses them at check time anyway).
-- INSERT OR IGNORE on UNIQUE(capability, principal_type, principal_id): idempotent, never replaces an existing row.
-- A fresh DB has no agent_seats rows, so this writes nothing (gate_grants stays empty after migrations).
INSERT OR IGNORE INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
SELECT DISTINCT lower(hex(randomblob(16))), 'gate:' || a.slug, 'agent', a.id, 'system:backfill-0245', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM agent_seats s
  JOIN agents a ON a.id = s.agent_id
 WHERE s.retired_at IS NULL
   AND a.status IN ('active', 'paused')
   AND a.archived_at IS NULL
   AND a.slug = 'seat-' || substr(s.key_hash, 1, 12);

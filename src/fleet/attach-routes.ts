// Fleet agent self-attach / self-detach routes — Step 2a of "agent running on mupot".
//
// These routes let an agent's runtime report ITSELF as running or stopped, bound to its
// mupot identity. Distinct from the daemon /report path (daemon bulk-reports all agents
// it can see). Here the agent calls in directly, authenticated by its own member-token.
//
// Keystone security property: member_id is ALWAYS derived from the bearer token (auth-
// server-side). A body member_id is silently discarded. An agent can ONLY attach or
// detach ITS OWN row — cross-agent stop is structurally impossible (detach WHERE
// member_id = <auth member>).
//
// POST /api/fleet/attach  — upsert fleet_agents status='running', member=auth-resolved.
// POST /api/fleet/detach  — SET status='stopped' WHERE tenant + agent_id + member_id=auth.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { getAgentView } from './registry'

// Regex re-declared locally (same rule as registry.ts AGENT_ID_RE) — no shared export
// needed; keeping validation explicit here avoids coupling to the daemon-report path.
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const VALID_TYPES = new Set(['builder', 'reviewer', 'weaver', 'brain', 'comms', 'generic'])

// Attach runtimes include 'hermes' (standalone Hermes agent runtime, absent from the
// daemon-report set which uses 'hermes-cron' for cron-only Hermes).
const VALID_RUNTIMES = new Set([
  'codex', 'claude-code', 'nous', 'hermes', 'hermes-cron',
  'systemd-user', 'tmux', 'python',
])

const VALID_LIFECYCLES = new Set(['on_demand', 'always_on'])

export const fleetAttachApp = new Hono<{ Bindings: Env }>()

// ── POST /api/fleet/attach ────────────────────────────────────────────────────────

fleetAttachApp.post('/attach', async (c) => {
  // 1. Auth — any active member bearer; 401 on missing/invalid (no auth oracle).
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  // 2. Parse body.
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request', detail: 'invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'bad_request', detail: 'body must be an object' }, 400)
  }
  const b = body as Record<string, unknown>

  // 3. Validate fields.
  if (typeof b.agent_id !== 'string' || !AGENT_ID_RE.test(b.agent_id)) {
    return c.json({ error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }, 400)
  }
  const agentId = b.agent_id

  if (typeof b.type !== 'string' || !VALID_TYPES.has(b.type)) {
    return c.json({ error: 'bad_request', detail: `type: must be one of ${[...VALID_TYPES].join('|')}` }, 400)
  }
  const agentType = b.type

  if (typeof b.runtime !== 'string' || !VALID_RUNTIMES.has(b.runtime)) {
    return c.json({ error: 'bad_request', detail: `runtime: must be one of ${[...VALID_RUNTIMES].join('|')}` }, 400)
  }
  const runtime = b.runtime

  // lifecycle is optional; defaults to 'on_demand'.
  let lifecycle = 'on_demand'
  if (b.lifecycle !== undefined) {
    if (typeof b.lifecycle !== 'string' || !VALID_LIFECYCLES.has(b.lifecycle)) {
      return c.json({ error: 'bad_request', detail: `lifecycle: must be on_demand|always_on or omitted` }, 400)
    }
    lifecycle = b.lifecycle
  }

  // 4. Security: member_id is auth-derived — NEVER from the body.
  //    Any b.member_id present in the request is discarded here. The upsert
  //    always uses id.memberId (the resolved, server-side identity).
  const memberId = id.memberId

  // 5. Upsert — reuses the ON CONFLICT shape from reportFleetAgents.
  //    display + squads + provider_contract are left as defaults on INSERT and NOT
  //    overwritten on UPDATE (agent doesn't supply them via self-attach; preserve any
  //    value the daemon has already populated).
  await c.env.DB.prepare(
    `INSERT INTO fleet_agents
          (agent_id, tenant, display, runtime, squads, lifecycle, provider_contract,
           status, reported_by, agent_type, member_id, last_reported_at, updated_at)
     VALUES (?1, ?2, '', ?3, '[]', ?4, NULL, 'running', ?5, ?6, ?7, datetime('now'), datetime('now'))
     ON CONFLICT(tenant, agent_id) DO UPDATE SET
          runtime          = excluded.runtime,
          lifecycle        = excluded.lifecycle,
          status           = 'running',
          reported_by      = excluded.reported_by,
          agent_type       = excluded.agent_type,
          member_id        = excluded.member_id,
          last_reported_at = excluded.last_reported_at,
          updated_at       = excluded.updated_at`,
  )
    .bind(agentId, c.env.TENANT_SLUG, runtime, lifecycle, memberId, agentType, memberId)
    .run()

  // 6. Boot-ack: return the full getAgentView row so the runtime confirms its identity,
  //    type, and capabilities as mupot sees them after the upsert.
  const views = await getAgentView(c.env)
  const agent = views.find((v) => v.agent_id === agentId) ?? null

  return c.json({ ok: true, agent })
})

// ── POST /api/fleet/detach ────────────────────────────────────────────────────────

fleetAttachApp.post('/detach', async (c) => {
  // 1. Auth.
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  // 2. Parse body.
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request', detail: 'invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'bad_request', detail: 'body must be an object' }, 400)
  }
  const b = body as Record<string, unknown>

  if (typeof b.agent_id !== 'string' || !AGENT_ID_RE.test(b.agent_id)) {
    return c.json({ error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }, 400)
  }
  const agentId = b.agent_id

  // 3. Ownership-gated update. The WHERE member_id = ?3 clause is the security primitive:
  //    an agent can only stop its own row. If agent_id exists but is owned by a different
  //    member, meta.changes = 0 → 404 (indistinguishable from unknown agent, by design).
  const result = await c.env.DB.prepare(
    `UPDATE fleet_agents
        SET status           = 'stopped',
            last_reported_at = datetime('now'),
            updated_at       = datetime('now')
      WHERE tenant    = ?1
        AND agent_id  = ?2
        AND member_id = ?3`,
  )
    .bind(c.env.TENANT_SLUG, agentId, id.memberId)
    .run()

  const changes = (result.meta as { changes?: number }).changes ?? 0
  if (changes === 0) {
    // Deliberately ambiguous: unknown agent OR wrong owner → same 404 shape.
    // No auth oracle: we don't tell the caller which case applied.
    return c.json({ error: 'not_found_or_not_owner' }, 404)
  }

  return c.json({ ok: true })
})

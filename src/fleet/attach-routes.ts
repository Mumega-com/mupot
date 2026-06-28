// Fleet agent self-attach / self-detach routes — Step 2a of "agent running on mupot".
//
// These routes let an agent's runtime report ITSELF as running or stopped, bound to its
// mupot identity. Distinct from the daemon /report path (daemon bulk-reports all agents
// it can see). Here the agent calls in directly, authenticated by its own member-token.
//
// Security properties:
//   - member_id is ALWAYS derived from the bearer token (never from the body).
//   - BLOCK-1 fix (strong): the token's boundAgentId MUST equal the requested agent_id.
//     A token bound to 'loom' can only attach/detach agent_id='loom'. A pure member
//     token (boundAgentId=null) cannot attach at all. This is race-free: no TOFU
//     first-claim window exists because agent identity is pinned inside the token itself,
//     not derived from row ownership. Step 2b mint will encode agent_id directly in the
//     token to enforce this at issuance time.
//   - Request bodies are capped at 8 KB before parsing (WARN-1 fix, anti-DoS).
//   - Detach uses an additional member_id WHERE clause as defense-in-depth.
//
// POST /api/fleet/attach  — upsert fleet_agents status='running', member=auth-resolved.
// POST /api/fleet/detach  — SET status='stopped' WHERE tenant + agent_id + member_id=auth.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { getAgentView } from './registry'

// ── constants ─────────────────────────────────────────────────────────────────────

// Regex re-declared locally (same rule as registry.ts AGENT_ID_RE) — keeps validation
// explicit and avoids coupling to the daemon-report path.
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const VALID_TYPES = new Set(['builder', 'reviewer', 'weaver', 'brain', 'comms', 'generic'])

// Attach runtimes include 'hermes' (standalone Hermes agent runtime, absent from the
// daemon-report set which uses 'hermes-cron' for cron-only Hermes).
const VALID_RUNTIMES = new Set([
  'codex', 'claude-code', 'nous', 'hermes', 'hermes-cron',
  'systemd-user', 'tmux', 'python',
])

const VALID_LIFECYCLES = new Set(['on_demand', 'always_on'])

// Attach/detach bodies are tiny (agent_id + a few fields). 8 KB is generous.
const MAX_BODY_BYTES = 8 * 1024

// ── helpers ───────────────────────────────────────────────────────────────────────

type Parsed = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'bad_json' }

/** Read + parse a JSON body with a hard byte cap before parsing (WARN-1 fix, anti-DoS).
 *  Cap is measured on the raw ArrayBuffer — not String.length — so a multibyte body
 *  cannot slip past a lying Content-Length header. */
async function readJsonCapped(c: Context, maxBytes: number): Promise<Parsed> {
  const len = c.req.header('content-length')
  if (len && Number(len) > maxBytes) return { ok: false, reason: 'too_large' }
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' }
  if (buf.byteLength === 0) return { ok: true, value: {} }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
}

export const fleetAttachApp = new Hono<{ Bindings: Env }>()

// ── POST /api/fleet/attach ────────────────────────────────────────────────────────

fleetAttachApp.post('/attach', async (c) => {
  // 1. Auth — any active member bearer; 401 on missing/invalid (no auth oracle).
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  // 2. Parse body with byte cap (WARN-1).
  const parsed = await readJsonCapped(c, MAX_BODY_BYTES)
  if (!parsed.ok) {
    return c.json({ error: parsed.reason === 'too_large' ? 'payload_too_large' : 'bad_request' },
      parsed.reason === 'too_large' ? 413 : 400)
  }
  if (!parsed.value || typeof parsed.value !== 'object') {
    return c.json({ error: 'bad_request', detail: 'body must be an object' }, 400)
  }
  const b = parsed.value as Record<string, unknown>

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
      return c.json({ error: 'bad_request', detail: 'lifecycle: must be on_demand|always_on or omitted' }, 400)
    }
    lifecycle = b.lifecycle
  }

  // 4. BLOCK-1 fix (strong): token binding gate.
  //    The token's boundAgentId MUST match the requested agent_id. A loom-bound token can
  //    only attach agent_id='loom'. A pure member token (boundAgentId=null) cannot attach.
  //    This is race-free — no TOFU window: agent identity is pinned in the token itself.
  //    member_id (the mupot identity) is separately auth-derived from the same token.
  if (!id.boundAgentId || id.boundAgentId !== agentId) {
    return c.json({ error: 'forbidden', detail: 'token is not bound to this agent_id' }, 403)
  }

  // 5. Security: member_id is auth-derived — NEVER from the body.
  //    Any b.member_id in the request is silently discarded.
  const memberId = id.memberId

  // 6. Upsert — reuses the ON CONFLICT shape from reportFleetAgents.
  //    display + squads + provider_contract are set to defaults on INSERT and NOT
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

  // 7. Boot-ack: return the full getAgentView row so the runtime confirms its identity,
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

  // 2. Parse body with byte cap (WARN-1).
  const parsed = await readJsonCapped(c, MAX_BODY_BYTES)
  if (!parsed.ok) {
    return c.json({ error: parsed.reason === 'too_large' ? 'payload_too_large' : 'bad_request' },
      parsed.reason === 'too_large' ? 413 : 400)
  }
  if (!parsed.value || typeof parsed.value !== 'object') {
    return c.json({ error: 'bad_request', detail: 'body must be an object' }, 400)
  }
  const b = parsed.value as Record<string, unknown>

  if (typeof b.agent_id !== 'string' || !AGENT_ID_RE.test(b.agent_id)) {
    return c.json({ error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }, 400)
  }
  const agentId = b.agent_id

  // 3. BLOCK-1 fix (strong, mirroring attach): token must be bound to the target agent_id.
  if (!id.boundAgentId || id.boundAgentId !== agentId) {
    return c.json({ error: 'forbidden', detail: 'token is not bound to this agent_id' }, 403)
  }

  // 4. Ownership-gated update. The WHERE member_id = ?3 clause is defense-in-depth:
  //    if the token binding matches but the fleet row has a different member_id (e.g.,
  //    a re-keying scenario), changes=0 → 404. An agent can only stop its own row.
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
    // Row not found OR member_id mismatch (re-keying scenario). Deliberately ambiguous.
    return c.json({ error: 'not_found_or_not_owner' }, 404)
  }

  return c.json({ ok: true })
})

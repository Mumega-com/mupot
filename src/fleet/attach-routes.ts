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
import { verifySignedAttach } from './signed-attach'

// ── shared upsert ───────────────────────────────────────────────────────────────────

/** Upsert a fleet_agents row to status='running'. Shared by the bearer (/attach) and the
 *  signed (/attach-signed) paths so both produce identical registry rows. member_id is the
 *  caller-authenticated identity (token-derived for bearer; key-bound for signed). */
async function upsertRunning(
  env: Env,
  agentId: string,
  runtime: string,
  lifecycle: string,
  agentType: string,
  memberId: string | null,
): Promise<void> {
  await env.DB.prepare(
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
    .bind(agentId, env.TENANT_SLUG, runtime, lifecycle, memberId, agentType, memberId)
    .run()
}

/** True if a signed-attach public key is registered for (tenant, agent_id). Such agents
 *  MUST use /attach-signed — the bearer path refuses them (no auth downgrade). */
async function hasRegisteredKey(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM agent_keys WHERE tenant = ?1 AND agent_id = ?2`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<{ x: number }>()
  return !!row
}

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

  // 5. Downgrade block: if a signed-attach key is registered for this agent, the bearer
  //    path is CLOSED — the agent must prove identity by signature (/attach-signed). This
  //    stops a stolen/leaked bearer from substituting for the stronger key proof.
  if (await hasRegisteredKey(c.env, agentId)) {
    return c.json({ error: 'forbidden', detail: 'agent requires signed attach (/api/fleet/attach-signed)' }, 403)
  }

  // 6. Security: member_id is auth-derived — NEVER from the body.
  //    Any b.member_id in the request is silently discarded.
  const memberId = id.memberId

  // 7. Upsert (shared with the signed path). display + squads + provider_contract default
  //    on INSERT and are NOT overwritten on UPDATE (preserve any daemon-populated value).
  await upsertRunning(c.env, agentId, runtime, lifecycle, agentType, memberId)

  // 8. Boot-ack: return the full getAgentView row so the runtime confirms its identity,
  //    type, and capabilities as mupot sees them after the upsert.
  const views = await getAgentView(c.env)
  const agent = views.find((v) => v.agent_id === agentId) ?? null

  return c.json({ ok: true, agent })
})

// ── POST /api/fleet/attach-signed ──────────────────────────────────────────────────
//
// No-bearer identity proof. The runtime SIGNS a tenant-bound, time-boxed, single-use
// message with its host-held Ed25519 private key; mupot verifies against the PUBLIC key
// registered in agent_keys. No secret is transported or placed. This is the cutover path
// for "agent running on mupot" — the agent that has a registered key MUST use this route
// (the bearer /attach refuses it: see hasRegisteredKey downgrade block).
//
// Security: identity (member_id) is bound to the KEY at registration, never taken from the
// body. verifySignedAttach enforces freshness (±window), single-use (nonce burn), tenant
// binding (in the signed bytes + key lookup), and signature validity before this handler
// touches the registry.
fleetAttachApp.post('/attach-signed', async (c) => {
  // 1. Parse body with byte cap (WARN-1). No bearer auth — the signature IS the auth.
  const parsed = await readJsonCapped(c, MAX_BODY_BYTES)
  if (!parsed.ok) {
    return c.json({ error: parsed.reason === 'too_large' ? 'payload_too_large' : 'bad_request' },
      parsed.reason === 'too_large' ? 413 : 400)
  }
  if (!parsed.value || typeof parsed.value !== 'object') {
    return c.json({ error: 'bad_request', detail: 'body must be an object' }, 400)
  }
  const b = parsed.value as Record<string, unknown>

  // 2. Verify the signature (does ALL field validation, freshness, key lookup, nonce burn).
  const v = await verifySignedAttach(c.env, b, VALID_TYPES, VALID_RUNTIMES)
  if (!v.ok) return c.json({ error: v.error, detail: v.detail }, v.status as 400 | 401 | 409)

  // 3. lifecycle is optional metadata, NOT part of the signed identity assertion. Default
  //    on_demand; validate if supplied. (It does not affect who the agent IS.)
  let lifecycle = 'on_demand'
  if (b.lifecycle !== undefined) {
    if (typeof b.lifecycle !== 'string' || !VALID_LIFECYCLES.has(b.lifecycle)) {
      return c.json({ error: 'bad_request', detail: 'lifecycle: must be on_demand|always_on or omitted' }, 400)
    }
    lifecycle = b.lifecycle
  }

  // 4. Upsert — member_id is the KEY-BOUND identity (from agent_keys), never the body.
  await upsertRunning(c.env, v.agent_id, v.runtime, lifecycle, v.type, v.member_id)

  // 5. Boot-ack.
  const views = await getAgentView(c.env)
  const agent = views.find((view) => view.agent_id === v.agent_id) ?? null
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

// fleet check-in route (Flock #45) — pot-native flock presence.
//
// POST /api/fleet/checkin — an agent announces it is present. Authenticated by the
// agent's pot member-token (bearer), NOT a session. Inbound only: the agent calls
// IN to the pot, so the pot needs no egress (stays sealed). Identity is resolved
// from the token; the body only carries non-authoritative source/label.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { recordCheckin } from './presence'

export const fleetCheckinApp = new Hono<{ Bindings: Env }>()

fleetCheckinApp.post('/checkin', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  // Generic 401 — never distinguish missing vs bad token (no auth oracle).
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as { source?: unknown; label?: unknown }

  // Debounce (adversarial P2): bound D1 writes to ~1 per 30s per agent so a valid
  // token cannot thrash D1 by spamming check-ins. A rapid re-check-in within the
  // window is a cheap KV hit + no-op (presence is at most 30s stale; the active
  // window is 10m, so liveness is unaffected). Fail-open: KV down → still record.
  const dkey = `checkin:${c.env.TENANT_SLUG}:${id.memberId}`
  try {
    if (await c.env.SESSIONS.get(dkey)) {
      return c.json({ ok: true, agent: id.displayName, debounced: true })
    }
    await c.env.SESSIONS.put(dkey, '1', { expirationTtl: 30 })
  } catch {
    // KV unavailable — prefer correctness (record) over the cost guard.
  }

  await recordCheckin(c.env, id, body)
  return c.json({ ok: true, agent: id.displayName })
})

// mupot — billing admin (the WRITER of the pot's plan tier).
//
// POST /api/billing/plan — the ONLY write path for `org_settings.plan_tier`.
// HMAC-authed (BILLING_PLAN_SECRET, x-mupot-signature over the raw body, same
// constant-time pattern as the event-ingest webhook). Called machine-to-machine
// by the CENTRAL billing source (mumega Stripe webhook / marketplace fulfillment)
// on a subscription event. NEVER owner-session, NEVER self-service.
//
// Defenses (HMAC proves SOURCE only — these add audience + freshness/order):
//   - AUDIENCE: the signed body carries `tenant`; must equal this pot's
//     TENANT_SLUG (rejects cross-pot misroute/replay even if the secret is shared).
//   - REPLAY / ORDER: the signed body carries `event_id` + `effective_at`. A
//     duplicate event_id is an idempotent no-op; an `effective_at` older than the
//     last applied is rejected (a stale {tier:free} can't roll back a later
//     upgrade). Last-applied state is stored in org_settings.
//   - Verify-before-act: signature checked before parse/write; size-capped.

import { Hono } from 'hono'
import type { Env } from '../types'
import { getJSON, setJSON, setSetting } from '../dashboard/settings'
import { PLAN_TIER_KEY } from './entitlement'
import { isPotTier } from './plans'

const MAX_BODY_BYTES = 4096
/** org_settings key: last billing event applied (idempotency + ordering guard). */
const LAST_EVENT_KEY = 'billing_last_event'

interface LastEvent {
  event_id: string
  effective_at: number
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time compare of two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const billingAdminApp = new Hono<{ Bindings: Env }>()

billingAdminApp.post('/plan', async (c) => {
  const secret = c.env.BILLING_PLAN_SECRET
  if (!secret || secret.length === 0) {
    return c.json({ error: 'not_configured', detail: 'BILLING_PLAN_SECRET not set on this pot' }, 503)
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (raw.length > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }
  // AUTH: HMAC over the raw body, before any parse/write.
  const sigHeader = (c.req.header('x-mupot-signature') ?? '').toLowerCase()
  if (sigHeader.length === 0 || !timingSafeEqual(await hmacHex(secret, raw), sigHeader)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: { tenant?: unknown; tier?: unknown; event_id?: unknown; effective_at?: unknown; reason?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  // AUDIENCE: the event must be addressed to THIS pot.
  if (typeof body.tenant !== 'string' || body.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'wrong_tenant' }, 403)
  }
  if (!isPotTier(body.tier)) {
    return c.json({ error: 'invalid_tier', allowed: ['free', 'starter', 'pro', 'scale'] }, 400)
  }
  if (typeof body.event_id !== 'string' || body.event_id.length === 0) {
    return c.json({ error: 'missing_event_id' }, 400)
  }
  if (typeof body.effective_at !== 'number' || !Number.isFinite(body.effective_at)) {
    return c.json({ error: 'missing_effective_at' }, 400)
  }
  // REPLAY / ORDER guard.
  const last = await getJSON<LastEvent>(c.env, LAST_EVENT_KEY)
  if (last && last.event_id === body.event_id) {
    return c.json({ ok: true, tier: body.tier, applied: false, reason: 'duplicate_event' })
  }
  if (last && body.effective_at < last.effective_at) {
    return c.json({ ok: true, applied: false, reason: 'stale_event' })
  }
  // Apply: write the plan + record the event as last-applied.
  await setSetting(c.env, PLAN_TIER_KEY, body.tier)
  await setJSON(c.env, LAST_EVENT_KEY, { event_id: body.event_id, effective_at: body.effective_at })
  return c.json({ ok: true, tier: body.tier, applied: true })
})

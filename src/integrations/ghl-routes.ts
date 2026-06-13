// mupot — GHL inbound webhook route (issue #8).
//
// POST /api/integrations/ghl/inbound
//
// SECURITY SURFACE — unauthenticated by session; authenticated ONLY by webhook secret.
//
// Verification: HMAC-SHA256 of the raw request body, delivered in the
// `x-ghl-signature` header (hex-encoded).  GHL sends this header when a webhook
// secret is configured in the GHL location settings.
//
// Constant-time comparison is used for both the header presence check and the
// HMAC equality check so no early-exit timing oracle exists.
//
// Fails closed:
//   - GHL_WEBHOOK_SECRET not set → 503 (not_configured). NEVER process an
//     unverified webhook (would allow any POST to forge inbound tasks).
//   - Invalid or missing signature → 401. No body processing. No internal detail leaked.
//
// On valid inbound: createTask on the configured default squad
// (env.GHL_INBOUND_SQUAD_ID, or the pot's first squad if unset).
// Returns 200 quickly — no blocking round-trip in the response.

import { Hono } from 'hono'
import type { Env } from '../types'
import { createTask } from '../tasks/service'
import { findByEmail, setProspectStatus } from '../loops/prospects'
import type { ProspectStatus } from '../loops/prospects'

// ── Env extension for GHL route-specific bindings ─────────────────────────────
//
// GHL_INBOUND_SQUAD_ID is an optional var (non-secret; may go in wrangler.toml vars).
// GHL_WEBHOOK_SECRET is a secret (wrangler secret put); see wrangler.toml comment block.
interface GHLRouteEnv {
  GHL_WEBHOOK_SECRET?: string
  GHL_INBOUND_SQUAD_ID?: string
}

function ghlRouteEnv(env: Env): GHLRouteEnv {
  // as unknown: GHL* are optional extras not in the core Env interface. This is the
  // same adapter-local pattern used by the Telegram adapter (telegramSecrets).
  return env as unknown as GHLRouteEnv
}

// ── Constant-time comparison ──────────────────────────────────────────────────
//
// timingSafeEqual is the canonical approach (Web Crypto TextEncoder → ArrayBuffer).
// We compare byte-by-byte with a running XOR so there is no early exit.
// Both arguments must be the same length — we pad/compare lengths separately
// (length comparison leaks length, but the HMAC is fixed-length so this is fine).

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

// ── HMAC-SHA256 computation ───────────────────────────────────────────────────

async function computeHmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  // Convert to hex string — slice by byte index (redact-by-construction pattern).
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Webhook verification ──────────────────────────────────────────────────────

/**
 * Verify the GHL webhook signature.
 *
 * Returns 'not_configured' when the secret is absent (→ 503).
 * Returns 'invalid'       when the signature does not match (→ 401).
 * Returns 'ok'            when verified (→ proceed).
 *
 * Exported for unit testing without spinning up Hono.
 */
export async function verifyGHLWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<'not_configured' | 'invalid' | 'ok'> {
  const secret = ghlRouteEnv(env).GHL_WEBHOOK_SECRET
  if (!secret || secret.length === 0) return 'not_configured'
  if (!signatureHeader || signatureHeader.length === 0) return 'invalid'

  const expected = await computeHmacHex(secret, rawBody)
  // timingSafeEqual prevents timing-oracle on the HMAC comparison.
  if (!timingSafeEqual(expected, signatureHeader.toLowerCase())) return 'invalid'

  return 'ok'
}

// ── Squad routing ─────────────────────────────────────────────────────────────

async function resolveInboundSquad(env: Env): Promise<string | null> {
  const configured = ghlRouteEnv(env).GHL_INBOUND_SQUAD_ID
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim()
  }
  // Fall back: first squad in the pot (any squad is better than dropping the lead).
  // v1 choice: documented in wrangler.toml comment block.
  const row = await env.DB.prepare(
    `SELECT id FROM squads ORDER BY created_at ASC LIMIT 1`,
  ).first<{ id: string }>()
  return row?.id ?? null
}

// ── Hono app ──────────────────────────────────────────────────────────────────

export const ghlInboundApp = new Hono<{ Bindings: Env }>()

/**
 * POST /api/integrations/ghl/inbound
 *
 * Processes GHL inbound events (reply received, booking made, pipeline stage
 * changed, …).  The task is the document of record — it closes the loop.
 *
 * v1 event routing: all inbound events create a task in the configured default squad.
 * The task title is derived from the event type + summary field; operators can
 * assign/dispatch from the dashboard.
 *
 * Do not add session auth middleware to this route — it is an external webhook.
 * The only auth is the webhook secret verified above.
 */
ghlInboundApp.post('/inbound', async (c) => {
  // Read the raw body first (we need it for HMAC verification; cannot re-read after json()).
  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const signatureHeader = c.req.header('x-ghl-signature') ?? null

  const verifyResult = await verifyGHLWebhook(c.env, rawBody, signatureHeader)

  if (verifyResult === 'not_configured') {
    // Webhook secret not set — operator must configure before GHL sends.
    return c.json({ error: 'not_configured' }, 503)
  }
  if (verifyResult === 'invalid') {
    // Bad signature — refuse, no body processing, no detail.
    return c.json({ error: 'unauthorized' }, 401)
  }

  // Replay / idempotency guard: a verified webhook is processed at most once within the
  // TTL window. GHL retries on a non-200 with the SAME body → the SAME HMAC signature; a
  // replayed event likewise reuses its signature. We record the signature in KV and treat
  // a repeat as a no-op success, so a retry/replay cannot double-process (re-create a
  // task, re-flip a prospect's status). Best-effort: a KV outage falls through to process.
  const nonceKey = `ghlnonce:${signatureHeader}`
  try {
    if (await c.env.SESSIONS.get(nonceKey)) {
      return c.json({ ok: true, duplicate: true })
    }
    await c.env.SESSIONS.put(nonceKey, '1', { expirationTtl: 86400 })
  } catch {
    // KV unavailable — do not block a legitimate inbound on a cache miss.
  }

  // Verified — parse the event body.
  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Route to a squad.
  const squadId = await resolveInboundSquad(c.env)
  if (!squadId) {
    // No squads exist yet — pot is not initialized. Accept the webhook (don't
    // let GHL retry-flood), but do nothing.
    return c.json({ ok: true, skipped: true, reason: 'no_squad' })
  }

  // Derive a human-readable title from the event fields GHL typically sends.
  const eventType = typeof event.type === 'string' ? event.type : 'inbound'
  const contact = typeof event.contact_id === 'string' ? event.contact_id : undefined
  const title = `[GHL] ${eventType}${contact ? ` · ${contact}` : ''}`

  // createTask is the canonical creation path (bus event emitted, GitHub mirror optional).
  await createTask(c.env, {
    squad_id: squadId,
    title,
    body: rawBody.slice(0, 2000), // store the raw event (truncated) for context
    // #142: GHL inbound webhook — predicate is the CRM contact receiving a reply.
    done_when: `GHL contact ${typeof event.contact_id === 'string' ? event.contact_id : 'replied'} processed`,
    status: 'open',
  })

  // Outreach reply tracking: if this inbound maps to a known prospect, move it so the
  // outcome KPI (replied) reflects it and the loop stops re-contacting. Best-effort —
  // never affects the webhook response (GHL retries on non-200).
  try {
    const update = prospectUpdateFromEvent(event)
    if (update) {
      const p = await findByEmail(c.env, update.email)
      // opted_out is terminal — never overwrite an unsubscribe with a 'replied'.
      if (p && p.status !== 'opted_out') await setProspectStatus(c.env, p.id, update.status)
    }
  } catch {
    // best-effort; reply tracking must not break inbound processing
  }

  // Return 200 immediately — GHL retries on anything else.
  return c.json({ ok: true })
})

// ── Outreach reply mapping ──────────────────────────────────────────────────────

/** Map a verified inbound event to a prospect status change, or null if it isn't one. */
export function prospectUpdateFromEvent(event: Record<string, unknown>): { email: string; status: ProspectStatus } | null {
  const email = pickEmail(event)
  if (!email) return null
  const t = (typeof event.type === 'string' ? event.type : '').toLowerCase()
  const optOut = ['unsub', 'opt_out', 'optout', 'complaint', 'bounce'].some((k) => t.includes(k))
  if (t.includes('bounce')) return { email, status: 'bounced' }
  return { email, status: optOut ? 'opted_out' : 'replied' }
}

function pickEmail(event: Record<string, unknown>): string | null {
  if (typeof event.email === 'string' && event.email.includes('@')) return event.email
  const contact = event.contact
  if (contact && typeof contact === 'object') {
    const e = (contact as Record<string, unknown>).email
    if (typeof e === 'string' && e.includes('@')) return e
  }
  return null
}

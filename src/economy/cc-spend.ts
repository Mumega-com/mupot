// mupot — squad Anthropic spend ingest (issue #179).
//
// POST /api/economy/cc-spend — the ONLY write path for `cc_spend_daily`. Machine-to-
// machine: the server-side transcript rollup pushes the squad's REAL Claude Code
// spend (actual usage from ~/.claude transcripts, priced at real Anthropic rates).
// NEVER owner-session, NEVER self-service. This is EXTERNAL truth, separate from the
// internal burn gauge (cost.ts / meter_cost).
//
// Defenses (HMAC proves SOURCE; the rest add audience + freshness + bounds):
//   - AUTH: HMAC-SHA256 over the RAW body (x-mupot-signature), constant-time, checked
//     BEFORE any parse/write. Same pattern as billing/admin + the event webhook.
//   - AUDIENCE: the signed body carries `tenant`; must equal this pot's TENANT_SLUG
//     (rejects cross-pot misroute/replay even if a secret is shared).
//   - FRESHNESS: the body carries `generated_at` (ISO). The rollup is a FULL recompute,
//     so re-push is an idempotent UPSERT — but a row only updates when the incoming
//     generated_at >= the stored updated_at, so an out-of-order STALE push can't
//     regress a day's already-higher total.
//   - BOUNDS: body size cap + row count cap + per-field non-negative-integer validation.
//     ANY invalid row rejects the WHOLE batch (fail-closed, no partial persist).

import { Hono } from 'hono'
import type { Env } from '../types'

const MAX_BODY_BYTES = 256 * 1024 // a multi-day, multi-agent rollup — generous but bounded
const MAX_ROWS = 4096
const MODEL_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'other'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

/** A finite non-negative safe integer (token counts, micro-USD, turns). */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
}

interface SpendRow {
  date: string
  agent: string
  model_family: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  usd_micro: number
  turns: number
}

/** Validate one untrusted row → a typed SpendRow, or null (caller rejects the batch). */
function parseRow(r: unknown): SpendRow | null {
  if (typeof r !== 'object' || r === null) return null
  const o = r as Record<string, unknown>
  if (typeof o.date !== 'string' || !DATE_RE.test(o.date)) return null
  if (typeof o.agent !== 'string' || o.agent.length === 0 || o.agent.length > 64) return null
  if (typeof o.model_family !== 'string' || !MODEL_FAMILIES.has(o.model_family)) return null
  if (
    !isCount(o.input_tokens) ||
    !isCount(o.output_tokens) ||
    !isCount(o.cache_write_tokens) ||
    !isCount(o.cache_read_tokens) ||
    !isCount(o.usd_micro) ||
    !isCount(o.turns)
  ) {
    return null
  }
  return {
    date: o.date,
    agent: o.agent,
    model_family: o.model_family,
    input_tokens: o.input_tokens,
    output_tokens: o.output_tokens,
    cache_write_tokens: o.cache_write_tokens,
    cache_read_tokens: o.cache_read_tokens,
    usd_micro: o.usd_micro,
    turns: o.turns,
  }
}

export const ccSpendApp = new Hono<{ Bindings: Env }>()

ccSpendApp.post('/cc-spend', async (c) => {
  const secret = c.env.CC_SPEND_SECRET
  if (!secret || secret.length === 0) {
    return c.json({ error: 'not_configured', detail: 'CC_SPEND_SECRET not set on this pot' }, 503)
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

  let body: { tenant?: unknown; generated_at?: unknown; rows?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // AUDIENCE: the push must be addressed to THIS pot.
  if (typeof body.tenant !== 'string' || body.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'wrong_tenant' }, 403)
  }
  // FRESHNESS source: an ISO timestamp the rollup stamps at generation time.
  if (typeof body.generated_at !== 'string' || Number.isNaN(Date.parse(body.generated_at))) {
    return c.json({ error: 'missing_generated_at' }, 400)
  }
  const generatedAt = body.generated_at
  if (!Array.isArray(body.rows)) {
    return c.json({ error: 'missing_rows' }, 400)
  }
  if (body.rows.length > MAX_ROWS) {
    return c.json({ error: 'too_many_rows', max: MAX_ROWS }, 413)
  }

  // Validate EVERY row before writing ANY — fail-closed, no partial persist.
  const rows: SpendRow[] = []
  for (const r of body.rows) {
    const parsed = parseRow(r)
    if (!parsed) return c.json({ error: 'invalid_row' }, 400)
    rows.push(parsed)
  }

  // FRESHNESS-GUARDED UPSERT: a row updates only when the incoming generated_at is
  // >= the stored updated_at, so a stale/out-of-order push is an idempotent no-op
  // for that row instead of regressing an already-higher figure. Batched = atomic.
  const stmt = c.env.DB.prepare(
    `INSERT INTO cc_spend_daily
       (date, agent, model_family, input_tokens, output_tokens,
        cache_write_tokens, cache_read_tokens, usd_micro, turns, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(date, agent, model_family) DO UPDATE SET
       input_tokens       = excluded.input_tokens,
       output_tokens      = excluded.output_tokens,
       cache_write_tokens = excluded.cache_write_tokens,
       cache_read_tokens  = excluded.cache_read_tokens,
       usd_micro          = excluded.usd_micro,
       turns              = excluded.turns,
       updated_at         = excluded.updated_at
     WHERE excluded.updated_at >= cc_spend_daily.updated_at`,
  )
  const batch = rows.map((r) =>
    stmt.bind(
      r.date,
      r.agent,
      r.model_family,
      r.input_tokens,
      r.output_tokens,
      r.cache_write_tokens,
      r.cache_read_tokens,
      r.usd_micro,
      r.turns,
      generatedAt,
    ),
  )
  try {
    if (batch.length > 0) await c.env.DB.batch(batch)
  } catch {
    return c.json({ error: 'write_failed' }, 500)
  }

  return c.json({ ok: true, rows: rows.length, generated_at: generatedAt })
})

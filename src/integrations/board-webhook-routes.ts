// mupot — generic board inbound webhook: POST /api/integrations/board/:provider
//
// Provider-agnostic. The provider's registered port supplies verifyWebhook / parseWebhook / webhook; this file
// never names one. Same discipline as the GitHub receiver (integrations/github-routes.ts):
//   - body size cap BEFORE any HMAC/parse work (256 KiB),
//   - signature verified before anything else is read (fail closed: unconfigured -> 503, bad -> 401),
//   - an atomic delivery ledger (INSERT OR IGNORE) so a redelivery or replay is a no-op; a ledger outage is a
//     retryable 503, never fail-open,
//   - only bindings with a connector and a matching external_id are acted on, and an inbound event can only
//     import (UNASSIGNED, admin-squad) or leave a note. It never produces a verdict.

import { Hono } from 'hono'
import type { Env } from '../types'
import { getTaskBoardPort, isProjectBoardProvider } from '../projects/providers/registry'
import type { ProjectProviderBinding } from '../projects/providers/port'

export const BOARD_INBOUND_MAX_BODY_BYTES = 256 * 1024
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BINDINGS_PER_EVENT = 10

export const boardWebhookApp = new Hono<{ Bindings: Env }>()

type Claim = 'new' | 'duplicate' | 'unavailable'

async function claimDelivery(env: Env, provider: string, id: string): Promise<Claim> {
  const receivedAt = Date.now()
  try {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO board_webhook_deliveries (tenant, provider, delivery_id, received_at) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(env.TENANT_SLUG, provider, id, receivedAt)
      .run()
    const changes = result.meta?.changes
    if (changes === 0) return 'duplicate'
    if (changes !== 1) return 'unavailable'
    try {
      await env.DB.prepare(`DELETE FROM board_webhook_deliveries WHERE tenant = ?1 AND received_at < ?2`)
        .bind(env.TENANT_SLUG, receivedAt - DELIVERY_RETENTION_MS)
        .run()
    } catch {
      // best-effort housekeeping; the claim already stands
    }
    return 'new'
  } catch {
    return 'unavailable'
  }
}

boardWebhookApp.post('/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (!isProjectBoardProvider(provider)) return c.json({ error: 'not_found' }, 404)
  const port = getTaskBoardPort(c.env, provider)
  if (!port.capabilities.has('webhook') || !port.verifyWebhook || !port.parseWebhook || !port.webhook) {
    return c.json({ error: 'not_found' }, 404)
  }

  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BOARD_INBOUND_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413)
  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (new TextEncoder().encode(rawBody).byteLength > BOARD_INBOUND_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413)

  const verified = await port.verifyWebhook(c.env, rawBody, c.req.raw.headers)
  if (!verified.ok) {
    if (verified.reason === 'not_configured') return c.json({ error: 'not_configured' }, 503)
    return c.json({ error: 'unauthorized' }, 401) // invalid and stale look the same from outside
  }

  const claim = await claimDelivery(c.env, provider, verified.deliveryId)
  if (claim === 'duplicate') return c.json({ ok: true, duplicate: true })
  if (claim === 'unavailable') return c.json({ error: 'delivery_ledger_unavailable' }, 503)

  const parsed = port.parseWebhook(rawBody)
  if (!parsed || parsed.event.kind === 'ignored') return c.json({ ok: true, ignored: true })

  const rows = await c.env.DB.prepare(
    `SELECT project_id, provider, external_id, connector_id, meta_json, synced_at, created_at, updated_at
       FROM project_provider_bindings
      WHERE provider = ?1 AND external_id = ?2 AND connector_id IS NOT NULL
      LIMIT ?3`,
  )
    .bind(provider, parsed.bindingExternalId, MAX_BINDINGS_PER_EVENT)
    .all<ProjectProviderBinding>()

  let imported = 0
  let noted = 0
  for (const binding of rows.results ?? []) {
    try {
      const out = await port.webhook(binding, parsed.event)
      imported += out.imported ?? 0
      noted += out.noted ?? 0
    } catch {
      // one binding's failure must not drop the others; the delivery is already claimed
    }
  }
  return c.json({ ok: true, imported, noted })
})

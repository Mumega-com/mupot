// Inbound Cursor Background Agent completion webhook.
// POST /api/runtime/vendor-cloud/cursor/webhook
//
// Auth: HMAC-SHA256 via X-Webhook-Signature (sha256=<hex>), secret =
// CURSOR_WEBHOOK_SECRET. Fail-closed when secret unset.

import { Hono } from 'hono'
import type { Env } from '../../types'
import { landAtReviewIntent } from './completion-port'
import { handleCursorWebhookCompletion } from './webhook-listener'

interface CursorWebhookEnv {
  CURSOR_WEBHOOK_SECRET?: string
  CURSOR_COMPLETION_GATE_OWNER?: string
}

function cursorWebhookEnv(env: Env): CursorWebhookEnv {
  return env as unknown as CursorWebhookEnv
}

export const CURSOR_WEBHOOK_MAX_BODY_BYTES = 256 * 1024

export const vendorCloudCursorWebhookApp = new Hono<{ Bindings: Env }>()

vendorCloudCursorWebhookApp.post('/cursor/webhook', async (c) => {
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > CURSOR_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (new TextEncoder().encode(rawBody).byteLength > CURSOR_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  const signatureHeader = c.req.header('x-webhook-signature') ?? null
  const secret = cursorWebhookEnv(c.env).CURSOR_WEBHOOK_SECRET ?? null
  const result = await handleCursorWebhookCompletion(secret, rawBody, signatureHeader)

  if (!result.ok) {
    if (result.error === 'not_configured') {
      return c.json({ error: 'not_configured' }, 503)
    }
    if (result.error === 'unauthorized') {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return c.json({ error: result.error }, 400)
  }

  const gateOwner =
    cursorWebhookEnv(c.env).CURSOR_COMPLETION_GATE_OWNER?.trim() || 'gate:kasra-core'
  const land = landAtReviewIntent(result.event, gateOwner)

  // Acknowledge quickly. Task board update is driven by the attached agent
  // (claim+report) and/or an operator poll; the webhook records completion.
  return c.json({
    ok: true,
    completion: {
      vendor: result.event.vendor,
      vendorRunId: result.event.vendorRunId,
      status: result.event.status,
      summary: result.event.summary,
      branchName: result.event.branchName,
      prUrl: result.event.prUrl,
    },
    land,
  })
})

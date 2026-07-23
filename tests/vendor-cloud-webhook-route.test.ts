import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  CURSOR_WEBHOOK_MAX_BODY_BYTES,
  vendorCloudCursorWebhookApp,
} from '../src/runtime/vendor-cloud/routes'
import { cursorWebhookSignatureHeader } from '../src/runtime/vendor-cloud/webhook-signature'

function envWith(secret: string | undefined): Env {
  return {
    TENANT_SLUG: 'test',
    DB: {} as Env['DB'],
    SESSIONS: {} as Env['SESSIONS'],
    CURSOR_WEBHOOK_SECRET: secret,
    CURSOR_COMPLETION_GATE_OWNER: 'gate:kasra-core',
  } as unknown as Env
}

async function postWebhook(
  env: Env,
  rawBody: string,
  signature: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-webhook-signature'] = signature
  return vendorCloudCursorWebhookApp.request(
    'http://localhost/cursor/webhook',
    { method: 'POST', headers, body: rawBody },
    env,
  )
}

describe('POST /api/runtime/vendor-cloud/cursor/webhook', () => {
  const payload = {
    event: 'statusChange',
    timestamp: '2026-07-23T15:00:00Z',
    id: 'bc_route',
    status: 'FINISHED',
    target: { branchName: 'cursor/x', prUrl: null },
    summary: 'ok',
  }
  const rawBody = JSON.stringify(payload)

  it('returns 503 when CURSOR_WEBHOOK_SECRET is unset', async () => {
    const res = await postWebhook(envWith(undefined), rawBody, 'sha256=abc')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_configured' })
  })

  it('returns 401 on bad signature', async () => {
    const res = await postWebhook(envWith('secret'), rawBody, 'sha256=00')
    expect(res.status).toBe(401)
  })

  it('returns completion + land-at-review on valid HMAC statusChange', async () => {
    const secret = 'route_secret'
    const sig = await cursorWebhookSignatureHeader(secret, rawBody)
    const res = await postWebhook(envWith(secret), rawBody, sig)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      completion: { status: string; vendorRunId: string }
      land: { status: string; forbidden: string[] }
    }
    expect(json.ok).toBe(true)
    expect(json.completion.status).toBe('FINISHED')
    expect(json.completion.vendorRunId).toBe('bc_route')
    expect(json.land.status).toBe('review')
    expect(json.land.forbidden).toContain('self_verdict')
  })

  it('rejects oversized bodies', async () => {
    expect(CURSOR_WEBHOOK_MAX_BODY_BYTES).toBeGreaterThan(0)
    const huge = 'x'.repeat(CURSOR_WEBHOOK_MAX_BODY_BYTES + 1)
    const res = await postWebhook(envWith('secret'), huge, 'sha256=00')
    expect(res.status).toBe(413)
  })
})

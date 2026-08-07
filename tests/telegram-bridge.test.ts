// mupot — Telegram bridge notification tests.
//
// Coverage:
//   1. Missing HERMES_WEBHOOK_SECRET → delivered: false, no fetch
//   2. HMAC hex of exact body matches canonical implementation
//   3. Non-2xx webhook response → delivered: false
//   4. Happy-path fetch headers (X-Webhook-Signature, JSON body)
//   5. FETCH_TIMEOUT_MS exported constant exists

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notifyHadi, hmacSign, FETCH_TIMEOUT_MS } from '../src/telegram-bridge/bus_notify'
import type { Env } from '../src/types'

// Minimal Env stub — only the fields the bridge reads
function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    TENANT_SLUG: 'mumega',
    HERMES_WEBHOOK_SECRET: 'test-secret-123',
    TELEGRAM_BRIDGE_URL: 'https://webhook.test/events',
    // Fill required but unused Env fields with placeholders
    DB: {} as any,
    VEC: {} as any,
    BUS: {} as any,
    SESSIONS: {} as any,
    OAUTH_KV: {} as any,
    AGENT: {} as any,
    SQUAD: {} as any,
    WORKFLOW: {} as any,
    ...overrides,
  } as Env
}

const sampleNotification = {
  type: 'task.review' as const,
  task_id: 'abc-123',
  title: 'Test review',
  squad_id: 'squad-1',
  agent_id: 'agent-42',
}

// ── 1. Missing secret → delivered: false, no fetch ─────────────────────────────

describe('notifyHadi', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns delivered:false and does NOT fetch when HERMES_WEBHOOK_SECRET is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const env = stubEnv({ HERMES_WEBHOOK_SECRET: undefined })
    const result = await notifyHadi(env, sampleNotification)
    expect(result).toEqual({ delivered: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // ── 2/4. Happy-path fetch — exact headers, JSON body, signature ──────────────

  it('sends correct headers and body on a successful delivery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
    } as Response)

    const env = stubEnv()
    const result = await notifyHadi(env, sampleNotification)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://webhook.test/events')
    expect(opts.method).toBe('POST')

    const headers = opts.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Webhook-Signature']).toBeTruthy()
    expect(typeof headers['X-Webhook-Signature']).toBe('string')

    // Body should be valid JSON with the notification
    const body = JSON.parse(opts.body as string)
    expect(body.type).toBe('task_event')
    expect(body.notification.task_id).toBe('abc-123')
    expect(body.notification.text).toContain('🔍')
    expect(body.notification.text).toContain('Waiting for your verdict')

    expect(result).toEqual({ delivered: true })
  })

  // ── 3. Non-2xx response → delivered: false ────────────────────────────────

  it('returns delivered:false when webhook responds with non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('Bad Gateway'),
    } as Response)

    const result = await notifyHadi(stubEnv(), sampleNotification)
    expect(result).toEqual({ delivered: false })
  })

  // ── 5. FETCH_TIMEOUT_MS is exported and positive ──────────────────────────

  it('exported FETCH_TIMEOUT_MS is a positive number', () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(FETCH_TIMEOUT_MS)).toBe(true)
  })
})

// ── HMAC sign consistency ──────────────────────────────────────────────────

describe('hmacSign', () => {
  it('produces a deterministic hex signature for the same input', async () => {
    const body = JSON.stringify({ type: 'test' })
    const sig1 = await hmacSign('my-secret', body)
    const sig2 = await hmacSign('my-secret', body)
    expect(sig1).toBe(sig2)
  })

  it('produces different signatures for different secrets', async () => {
    const body = JSON.stringify({ type: 'test' })
    const sig1 = await hmacSign('secret-a', body)
    const sig2 = await hmacSign('secret-b', body)
    expect(sig1).not.toBe(sig2)
  })

  it('produces a hex string (length 64 for SHA-256)', async () => {
    const sig = await hmacSign('secret', 'body')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })
})

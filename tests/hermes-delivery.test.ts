// mupot — Hermes push delivery tests (mumega-com#970, delivery half).
//
// Covers:
//   1. Envelope shape — event_id/tenant/ts present, tenant is the PRODUCER's tenant (never
//      caller-controlled), NO chat/thread/body fields (the emit half deliberately excludes
//      them; see src/bus/hermes-delivery.ts file header).
//   2. Signature is computed over the EXACT bytes sent as the request body — captured from
//      the actual fetch() call, not re-derived, so a signer that diverges from the wire
//      payload cannot pass silently.
//   3. classifyDeliveryOutcome distinguishes 401/403/404/network/2xx-real/2xx-impostor —
//      never collapses to resp.ok.
//   4. not_configured short-circuits before any fetch.
//   5. network/timeout produces a distinct outcome, never throws out of the function.
//
// No env.DB is touched anywhere in this module, so these tests do not construct a D1
// double at all (real or mock) — nothing here is subject to, or needs an exemption from,
// scripts/check-test-schema-source.mjs.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildHermesEventEnvelope,
  classifyDeliveryOutcome,
  deliverMessageCreatedEvent,
  REPLAY_WINDOW_SECONDS,
  type HermesEventEnvelope,
} from '../src/bus/hermes-delivery'
import { hmacSign } from '../src/telegram-bridge/bus_notify'
import type { BusEvent, Env, MessageCreatedPayload } from '../src/types'

function sampleEvent(overrides: Partial<MessageCreatedPayload> = {}): BusEvent<MessageCreatedPayload> {
  return {
    type: 'message.created',
    tenant: 'acme-tenant',
    agent_id: 'agent-b',
    actor: { kind: 'agent', id: 'agent-a' },
    ts: '2026-08-14T12:00:00.000Z',
    payload: {
      message_id: 'msg-123',
      seq: 7,
      to_agent: 'agent-b',
      from_agent: 'agent-a',
      from_member: 'member-1',
      kind: 'note',
      request_id: 'req-1',
      in_reply_to: null,
      project_id: 'proj-1',
      created_at: '2026-08-14T12:00:00.000Z',
      ...overrides,
    },
  }
}

function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    HERMES_WEBHOOK_SECRET: 'super-secret-hex',
    HERMES_EVENTS_WEBHOOK_URL: 'https://hermes-kay.mumega.test/webhooks/mupot-events',
    ...overrides,
  } as Env
}

// ── 1. Envelope shape ───────────────────────────────────────────────────────

describe('buildHermesEventEnvelope', () => {
  it('carries event_id, tenant, and a fresh ts — the replay material', () => {
    const env = buildHermesEventEnvelope(sampleEvent(), new Date('2026-08-14T12:05:00.000Z'))
    expect(env.event_id).toBe('msg-123')
    expect(env.tenant).toBe('acme-tenant')
    expect(env.ts).toBe('2026-08-14T12:05:00.000Z')
    expect(env.event_type).toBe('message.created')
  })

  it('tenant is the BusEvent producer tenant, not anything read off the payload', () => {
    // A payload cannot carry its own tenant at all (MessageCreatedPayload has no tenant
    // field) — this pins that the envelope's tenant can ONLY come from event.tenant.
    const event = sampleEvent()
    const env = buildHermesEventEnvelope(event)
    expect(env.tenant).toBe(event.tenant)
    expect('tenant' in event.payload).toBe(false)
  })

  it('carries NO message body and NO Telegram chat/thread correlation — not in the payload type, so not invented here', () => {
    const env = buildHermesEventEnvelope(sampleEvent())
    const keys = Object.keys(env.data)
    expect(keys).not.toContain('body')
    expect(keys).not.toContain('text')
    expect(keys).not.toContain('chat_id')
    expect(keys).not.toContain('thread_id')
  })

  it('exposes the documented replay window as a positive number of seconds', () => {
    expect(REPLAY_WINDOW_SECONDS).toBeGreaterThan(0)
  })
})

// ── 2. Signature is over the exact wire bytes ───────────────────────────────

describe('deliverMessageCreatedEvent — signature construction', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('signs the exact body bytes sent, in GitHub-style X-Hub-Signature-256: sha256=<hex>', async () => {
    let capturedBody = ''
    let capturedHeaders: Record<string, string> = {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = String((init as RequestInit).body)
      capturedHeaders = (init as RequestInit).headers as Record<string, string>
      return new Response(JSON.stringify({ accepted: true, event_id: 'msg-123' }), { status: 200 })
    })

    const env = stubEnv()
    await deliverMessageCreatedEvent(env, sampleEvent())

    expect(capturedHeaders['X-Hub-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/)
    const provided = capturedHeaders['X-Hub-Signature-256'].slice('sha256='.length)
    // Independently recompute over the CAPTURED body — the actual bytes fetch() sent —
    // not over any re-derived object. This is what catches "signed the pre-serialization
    // object" (mutation b): if the signer used different bytes, this equality fails.
    const expected = await hmacSign('super-secret-hex', capturedBody)
    expect(provided).toBe(expected)

    // And the signed material is genuinely what was sent — parses back to the envelope.
    const parsedBody = JSON.parse(capturedBody) as HermesEventEnvelope
    expect(parsedBody.event_id).toBe('msg-123')
    expect(parsedBody.ts).toBeTruthy()
  })

  it('a wrong secret produces a DIFFERENT signature for the identical body', async () => {
    const body = JSON.stringify({ event_id: 'x', ts: '2026-08-14T00:00:00.000Z' })
    const sigRight = await hmacSign('correct-secret', body)
    const sigWrong = await hmacSign('wrong-secret', body)
    expect(sigRight).not.toBe(sigWrong)
  })

  it('the replay material (event_id + ts) is present INSIDE the signed bytes, not just alongside them', async () => {
    let capturedBody = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = String((init as RequestInit).body)
      return new Response(JSON.stringify({ accepted: true, event_id: 'msg-123' }), { status: 200 })
    })
    await deliverMessageCreatedEvent(stubEnv(), sampleEvent())
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>
    expect(typeof parsed.event_id).toBe('string')
    expect(typeof parsed.ts).toBe('string')
    // A dropped ts/event_id would leave replay protection at zero — pin that both fields
    // that make the window enforceable are literally inside the string that got signed.
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false)
  })
})

// ── 3. classifyDeliveryOutcome — distinct outcomes, never bare resp.ok ──────

describe('classifyDeliveryOutcome', () => {
  it('401 -> unauthorized (not a generic failure)', async () => {
    const resp = new Response('bad signature', { status: 401 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('unauthorized')
  })

  it('403 -> unauthorized', async () => {
    const resp = new Response('forbidden', { status: 403 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('unauthorized')
  })

  it('404 -> not_found (the expected state today — route not registered on Hermes yet)', async () => {
    const resp = new Response('not found', { status: 404 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('not_found')
  })

  it('a 2xx with a body that PROVES this endpoint accepted THIS event -> delivered', async () => {
    const resp = new Response(JSON.stringify({ accepted: true, event_id: 'msg-123' }), { status: 200 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('delivered')
  })

  it('a 202 with Hermes standard webhook format { status: "accepted", delivery_id: ... } -> delivered', async () => {
    const resp = new Response(JSON.stringify({ status: 'accepted', route: 'mubot-inbox', delivery_id: '1786757015484' }), { status: 202 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('delivered')
  })

  it('a 2xx from something that is NOT our endpoint (wrong/absent body) -> unexpected_response, NOT delivered', async () => {
    // This is the bare-`resp.ok` defect from bus_notify.ts, reproduced as a fixture: some
    // other server (a health check, a default nginx 200 page) answering on the hostname.
    // A `resp.ok`-only check would call this "delivered". It must not.
    const resp = new Response(JSON.stringify({ status: 'ok', platform: 'webhook' }), { status: 200 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('unexpected_response')
  })

  it('a 2xx whose body echoes a DIFFERENT event_id -> unexpected_response, NOT delivered', async () => {
    const resp = new Response(JSON.stringify({ accepted: true, event_id: 'someone-elses-event' }), { status: 200 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('unexpected_response')
  })

  it('non-JSON 200 body -> unexpected_response, not a crash', async () => {
    const resp = new Response('<html>ok</html>', { status: 200 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('unexpected_response')
  })

  it('500 -> server_error', async () => {
    const resp = new Response('boom', { status: 500 })
    const outcome = await classifyDeliveryOutcome(resp, 'msg-123')
    expect(outcome.kind).toBe('server_error')
  })
})

// ── 4/5. not_configured short-circuit + network/timeout ────────────────────

describe('deliverMessageCreatedEvent — configuration and network outcomes', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('missing HERMES_EVENTS_WEBHOOK_URL -> not_configured, no fetch attempted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const outcome = await deliverMessageCreatedEvent(stubEnv({ HERMES_EVENTS_WEBHOOK_URL: undefined }), sampleEvent())
    expect(outcome.kind).toBe('not_configured')
    if (outcome.kind === 'not_configured') expect(outcome.missing).toContain('HERMES_EVENTS_WEBHOOK_URL')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('missing HERMES_WEBHOOK_SECRET -> not_configured, no fetch attempted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const outcome = await deliverMessageCreatedEvent(stubEnv({ HERMES_WEBHOOK_SECRET: undefined }), sampleEvent())
    expect(outcome.kind).toBe('not_configured')
    if (outcome.kind === 'not_configured') expect(outcome.missing).toContain('HERMES_WEBHOOK_SECRET')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a network/timeout failure produces network_error and does NOT throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted'))
    const outcome = await deliverMessageCreatedEvent(stubEnv(), sampleEvent())
    expect(outcome.kind).toBe('network_error')
  })

  it('404 / 401 / network_error are three DISTINCT kinds, not one collapsed failure', async () => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch')

    fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    const notFound = await deliverMessageCreatedEvent(stubEnv(), sampleEvent())

    fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    const unauthorized = await deliverMessageCreatedEvent(stubEnv(), sampleEvent())

    fetchImpl.mockRejectedValueOnce(new Error('timeout'))
    const network = await deliverMessageCreatedEvent(stubEnv(), sampleEvent())

    const kinds = [notFound.kind, unauthorized.kind, network.kind]
    expect(new Set(kinds).size).toBe(3)
    expect(kinds).toEqual(['not_found', 'unauthorized', 'network_error'])
  })
})

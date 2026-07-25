import test from 'node:test'
import assert from 'node:assert/strict'

import {
  captureGeoEvent,
  sendMupotReceipt,
} from './sinks.mjs'

const POSTHOG_TOKEN = 'phc_project-token-that-must-not-be-returned'
const MUPOT_TOKEN = 'mupot_agent-token-that-must-not-be-returned'

function geoEvent() {
  return {
    schema: 'dme.geo-scan/v1',
    event_uuid: '11111111-1111-4111-8111-111111111111',
    scan_id: '22222222-2222-4222-8222-222222222222',
    project_id: 'viamar',
    profile_id: 'viamar',
    prompt_id: 'international-movers-toronto',
    market: 'Canada',
    observed_at: '2026-07-25T20:00:00.000Z',
    status: 'ok',
    target_domain: 'viamar.ca',
    target_cited: false,
    answer_text: 'Example Shipping is visible.',
    web_search_queries: ['best international movers Toronto'],
    cited_domains: ['example.com'],
    citations: [{
      title: 'Example Shipping',
      domain: 'example.com',
      uri: 'https://example.com/moving',
    }],
    tracked_competitors_named: ['Example Shipping'],
    prompt_tokens: 100,
    candidate_tokens: 200,
    total_tokens: 300,
    estimated_model_cost_micro_usd: 530,
    grounding_cost_micro_usd: null,
    cost_status: 'billing_unreconciled',
    model: 'gemini-2.5-flash',
  }
}

function receipt() {
  return {
    schema: 'mupot.geo-scan-receipt/v1',
    scan_id: '22222222-2222-4222-8222-222222222222',
    project_id: 'viamar',
    profiles: ['viamar'],
    counts: { ok: 1, empty: 0, failed: 0, budget_denied: 0, sink_failed: 0 },
    prompt_tokens: 100,
    candidate_tokens: 200,
    total_tokens: 300,
    estimated_model_cost_micro_usd: 530,
    grounding_cost_micro_usd: null,
    cost_status: 'billing_unreconciled',
    event_uuids: ['11111111-1111-4111-8111-111111111111'],
    started_at: '2026-07-25T20:00:00.000Z',
    completed_at: '2026-07-25T20:00:02.000Z',
  }
}

test('captures a complete GEO event in the project PostHog boundary', async () => {
  let request
  const result = await captureGeoEvent({
    posthogHost: 'https://us.i.posthog.com',
    token: POSTHOG_TOKEN,
    event: geoEvent(),
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response('{"status":"Ok"}', { status: 200 })
    },
  })

  assert.equal(request.url, 'https://us.i.posthog.com/i/v0/e/')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.redirect, 'manual')
  assert.deepEqual(JSON.parse(request.init.body), {
    api_key: POSTHOG_TOKEN,
    event: '$geo_scan',
    distinct_id: 'project:viamar:profile:viamar',
    uuid: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-07-25T20:00:00.000Z',
    properties: geoEvent(),
  })
  assert.deepEqual(result, {
    ok: true,
    eventUuid: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(JSON.stringify(result).includes(POSTHOG_TOKEN), false)
})

test('sends one project-attributed redacted Mupot acknowledgement', async () => {
  let request
  const value = receipt()
  const result = await sendMupotReceipt({
    baseUrl: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
    token: MUPOT_TOKEN,
    receiptTo: 'viamar-geo-receipts',
    projectId: 'viamar',
    receipt: value,
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({
        ok: true,
        id: 'message-1',
        seq: 7,
        duplicate: false,
        to: 'viamar-geo-receipts',
        project_id: 'viamar',
      }), { status: 200 })
    },
  })

  assert.equal(
    request.url,
    'https://mupot-viamar.weathered-scene-2272.workers.dev/api/inbox/send',
  )
  assert.equal(request.init.headers.Authorization, `Bearer ${MUPOT_TOKEN}`)
  assert.equal(request.init.redirect, 'manual')
  const body = JSON.parse(request.init.body)
  assert.deepEqual(body, {
    to: 'viamar-geo-receipts',
    kind: 'ack',
    project_id: 'viamar',
    request_id: 'geo:22222222-2222-4222-8222-222222222222',
    body: JSON.stringify(value),
  })
  assert.deepEqual(result, {
    ok: true,
    messageId: 'message-1',
    duplicate: false,
  })
  assert.equal(JSON.stringify(result).includes(MUPOT_TOKEN), false)
})

test('refuses detailed evidence or secret-like keys in a retained Mupot receipt', async () => {
  const forbidden = [
    { answer_text: 'customer evidence' },
    { web_search_queries: ['private query'] },
    { citations: [{ uri: 'https://example.com' }] },
    { access_token: 'credential' },
    { api_key: 'credential' },
    { authorization: 'credential' },
    { nested: { secret: 'credential' } },
  ]
  let calls = 0
  for (const extra of forbidden) {
    await assert.rejects(sendMupotReceipt({
      baseUrl: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
      token: MUPOT_TOKEN,
      receiptTo: 'viamar-geo-receipts',
      projectId: 'viamar',
      receipt: { ...receipt(), ...extra },
    }, {
      fetchImpl: async () => {
        calls++
        return new Response('{}')
      },
    }), /unsafe_receipt/)
  }
  assert.equal(calls, 0)
})

test('rejects redirects and non-2xx responses without echoing upstream bodies or tokens', async () => {
  const posthogRedirect = await captureGeoEvent({
    posthogHost: 'https://us.i.posthog.com',
    token: POSTHOG_TOKEN,
    event: geoEvent(),
  }, {
    fetchImpl: async () => new Response('private redirect body', {
      status: 307,
      headers: { location: 'https://evil.example' },
    }),
  })
  assert.deepEqual(posthogRedirect, { ok: false, reason: 'posthog_redirect' })

  const mupotFailure = await sendMupotReceipt({
    baseUrl: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
    token: MUPOT_TOKEN,
    receiptTo: 'viamar-geo-receipts',
    projectId: 'viamar',
    receipt: receipt(),
  }, {
    fetchImpl: async () => new Response('private database detail', { status: 503 }),
  })
  assert.deepEqual(mupotFailure, { ok: false, reason: 'mupot_http_503' })

  for (const result of [posthogRedirect, mupotFailure]) {
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('private'), false)
    assert.equal(serialized.includes(POSTHOG_TOKEN), false)
    assert.equal(serialized.includes(MUPOT_TOKEN), false)
  }
})

test('rejects invalid hosts, tokens, and event identity before network access', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response('{}')
  }
  for (const input of [
    { posthogHost: 'http://us.i.posthog.com', token: POSTHOG_TOKEN, event: geoEvent() },
    { posthogHost: 'https://127.0.0.1', token: POSTHOG_TOKEN, event: geoEvent() },
    { posthogHost: 'https://us.i.posthog.com', token: '', event: geoEvent() },
    {
      posthogHost: 'https://us.i.posthog.com',
      token: POSTHOG_TOKEN,
      event: { ...geoEvent(), project_id: '../viamar' },
    },
  ]) {
    await assert.rejects(captureGeoEvent(input, { fetchImpl }))
  }
  assert.equal(calls, 0)
})

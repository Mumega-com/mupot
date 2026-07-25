import test from 'node:test'
import assert from 'node:assert/strict'

import { validateScannerConfig } from './contract.mjs'
import { runGeoScan } from './scanner.mjs'

const GOOGLE_TOKEN = 'ya29.ephemeral-google-access-token'
const POSTHOG_TOKEN = 'phc_project-token'
const MUPOT_TOKEN = 'mupot_agent-token'
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function config(promptCount = 2) {
  return validateScannerConfig({
    schema: 'dme.geo-scanner-config/v1',
    project_id: PROJECT_ID,
    google_project_id: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    posthog_host: 'https://us.i.posthog.com',
    daily_query_cap: promptCount,
    state_file: '/var/lib/mupot/geo-budget/state.json',
    mupot: {
      base_url: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
      receipt_to: 'viamar-geo-receipts',
    },
    profiles: [{
      id: 'viamar',
      target_domain: 'viamar.ca',
      market: 'Canada',
      tracked_competitors: ['Example Shipping'],
      prompts: Array.from({ length: promptCount }, (_, index) => ({
        id: `prompt-${index + 1}`,
        text: `Which international moving company is most visible for market ${index + 1}?`,
      })),
    }],
  })
}

function uuidSequence() {
  const values = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ]
  return () => {
    const value = values.shift()
    if (!value) throw new Error('uuid fixture exhausted')
    return value
  }
}

function okVertex() {
  return {
    status: 'ok',
    answerText: 'Example Shipping is cited before Viamar.',
    webSearchQueries: ['best international moving company'],
    citations: [{
      title: 'Viamar',
      domain: 'www.viamar.ca',
      uri: 'https://www.viamar.ca/international-moving/',
    }],
    usage: { promptTokens: 100, candidateTokens: 200, totalTokens: 300 },
  }
}

function baseOptions(overrides = {}) {
  return {
    now: () => new Date('2026-07-25T20:00:00.000Z'),
    uuid: uuidSequence(),
    posthogToken: POSTHOG_TOKEN,
    mupotToken: MUPOT_TOKEN,
    claimQuery: async () => ({
      ok: true,
      day: '2026-07-25',
      used: 1,
      remaining: 1,
    }),
    getGoogleToken: async () => GOOGLE_TOKEN,
    runQuery: async () => okVertex(),
    captureEvent: async ({ event }) => ({ ok: true, eventUuid: event.event_uuid }),
    sendReceipt: async () => ({ ok: true, messageId: 'message-1', duplicate: false }),
    ...overrides,
  }
}

test('claims budget before each one-shot Vertex call and emits one event per prompt', async () => {
  const order = []
  const events = []
  let tokenCalls = 0
  const result = await runGeoScan(config(2), baseOptions({
    claimQuery: async () => {
      order.push('claim')
      return { ok: true, day: '2026-07-25', used: 1, remaining: 1 }
    },
    getGoogleToken: async () => {
      tokenCalls++
      return GOOGLE_TOKEN
    },
    runQuery: async () => {
      order.push('vertex')
      return okVertex()
    },
    captureEvent: async ({ event }) => {
      order.push('posthog')
      events.push(event)
      return { ok: true, eventUuid: event.event_uuid }
    },
  }))

  assert.deepEqual(order, ['claim', 'vertex', 'posthog', 'claim', 'vertex', 'posthog'])
  assert.equal(tokenCalls, 1)
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((event) => event.prompt_id), ['prompt-1', 'prompt-2'])
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result).includes(GOOGLE_TOKEN), false)
  assert.equal(JSON.stringify(result).includes(POSTHOG_TOKEN), false)
  assert.equal(JSON.stringify(result).includes(MUPOT_TOKEN), false)
})

test('records budget denial without making a Vertex call', async () => {
  const events = []
  let vertexCalls = 0
  const result = await runGeoScan(config(1), baseOptions({
    claimQuery: async () => ({
      ok: false,
      reason: 'daily_query_cap_reached',
      day: '2026-07-25',
      used: 1,
      remaining: 0,
    }),
    runQuery: async () => {
      vertexCalls++
      return okVertex()
    },
    captureEvent: async ({ event }) => {
      events.push(event)
      return { ok: true, eventUuid: event.event_uuid }
    },
  }))

  assert.equal(vertexCalls, 0)
  assert.equal(events[0].status, 'budget_denied')
  assert.equal(events[0].target_cited, null)
  assert.deepEqual(events[0].citations, [])
  assert.deepEqual(result.counts, {
    ok: 0,
    empty: 0,
    failed: 0,
    budget_denied: 1,
    sink_failed: 0,
  })
})

test('derives target citation, tracked competitor names, and dated model-only cost', async () => {
  const events = []
  let retainedReceipt
  const result = await runGeoScan(config(1), baseOptions({
    captureEvent: async ({ event }) => {
      events.push(event)
      return { ok: true, eventUuid: event.event_uuid }
    },
    sendReceipt: async ({ receipt }) => {
      retainedReceipt = receipt
      return { ok: true, messageId: 'message-1', duplicate: false }
    },
  }))

  const event = events[0]
  assert.equal(event.target_cited, true)
  assert.deepEqual(event.cited_domains, ['viamar.ca'])
  assert.deepEqual(event.tracked_competitors_named, ['Example Shipping'])
  assert.equal(event.estimated_model_cost_micro_usd, 530)
  assert.equal(event.grounding_cost_micro_usd, null)
  assert.equal(event.cost_status, 'billing_unreconciled')
  assert.equal(event.model_rate_card, 'vertex-gemini-2.5-flash-2026-07-25')
  assert.equal(retainedReceipt.estimated_model_cost_micro_usd, 530)
  assert.equal(retainedReceipt.grounding_cost_micro_usd, null)
  assert.equal(JSON.stringify(retainedReceipt).includes('answer_text'), false)
  assert.equal(JSON.stringify(retainedReceipt).includes('web_search_queries'), false)
  assert.equal(JSON.stringify(retainedReceipt).includes('citations'), false)
  assert.equal(result.ok, true)
})

test('preserves empty and failed outcomes without fabricating a citation zero', async () => {
  const events = []
  let index = 0
  const outcomes = [
    {
      status: 'empty',
      reason: 'empty_answer',
      answerText: '',
      webSearchQueries: [],
      citations: [],
      usage: { promptTokens: 10, candidateTokens: 0, totalTokens: 10 },
    },
    {
      status: 'failed',
      reason: 'vertex_http_503',
      answerText: '',
      webSearchQueries: [],
      citations: [],
      usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
    },
  ]
  const result = await runGeoScan(config(2), baseOptions({
    runQuery: async () => outcomes[index++],
    captureEvent: async ({ event }) => {
      events.push(event)
      return { ok: true, eventUuid: event.event_uuid }
    },
  }))

  assert.deepEqual(events.map((event) => event.status), ['empty', 'failed'])
  assert.deepEqual(events.map((event) => event.target_cited), [null, null])
  assert.deepEqual(events.map((event) => event.cited_domains), [[], []])
  assert.deepEqual(result.counts, {
    ok: 0,
    empty: 1,
    failed: 1,
    budget_denied: 0,
    sink_failed: 0,
  })
})

test('a PostHog failure never repeats the billable Vertex request', async () => {
  let vertexCalls = 0
  let receiptValue
  const result = await runGeoScan(config(1), baseOptions({
    runQuery: async () => {
      vertexCalls++
      return okVertex()
    },
    captureEvent: async () => ({ ok: false, reason: 'posthog_http_503' }),
    sendReceipt: async ({ receipt }) => {
      receiptValue = receipt
      return { ok: true, messageId: 'message-1', duplicate: false }
    },
  }))

  assert.equal(vertexCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.counts.sink_failed, 1)
  assert.equal(receiptValue.counts.sink_failed, 1)
  assert.deepEqual(receiptValue.event_uuids, [])
})

test('the first PostHog failure stops later prompts before they spend budget', async () => {
  let claimCalls = 0
  let vertexCalls = 0
  let captureCalls = 0
  const result = await runGeoScan(config(2), baseOptions({
    claimQuery: async () => {
      claimCalls++
      return { ok: true, day: '2026-07-25', used: claimCalls, remaining: 2 - claimCalls }
    },
    runQuery: async () => {
      vertexCalls++
      return okVertex()
    },
    captureEvent: async () => {
      captureCalls++
      return { ok: false, reason: 'posthog_http_503' }
    },
  }))

  assert.equal(claimCalls, 1)
  assert.equal(vertexCalls, 1)
  assert.equal(captureCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.counts.sink_failed, 1)
})

test('a Mupot receipt failure returns incomplete without repeating scans', async () => {
  let vertexCalls = 0
  let receiptCalls = 0
  const result = await runGeoScan(config(1), baseOptions({
    runQuery: async () => {
      vertexCalls++
      return okVertex()
    },
    sendReceipt: async () => {
      receiptCalls++
      return { ok: false, reason: 'mupot_http_503' }
    },
  }))

  assert.equal(vertexCalls, 1)
  assert.equal(receiptCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.receipt.reason, 'mupot_http_503')
})

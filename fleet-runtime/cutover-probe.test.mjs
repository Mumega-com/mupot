// node --test cutover-probe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReceipt, normalizeBaseUrl, parseArgs } from './cutover-probe.mjs'

const RELEASE_SHA = 'a'.repeat(40)

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('cutover probe queues inbox and control requests without echoing tokens', async () => {
  const calls = []
  const receipt = await buildReceipt({
    baseUrl: 'https://pot.example.org/',
    agent: 'agent-one',
    queueInbox: true,
    controls: ['start', 'stop'],
    requestId: 'rid-1',
    env: {
      MUPOT_AGENT_TOKEN: 'agent-secret-token',
      MUPOT_OWNER_TOKEN: 'owner-secret-token',
    },
    now: () => '2026-07-08T00:00:00.000Z',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      if (String(url).endsWith('/api/inbox/send')) {
        return jsonResponse({ ok: true, id: 'msg-1', seq: 7, duplicate: false, to: 'agent-one' })
      }
      return jsonResponse({ ok: true, nonce: `nonce-${calls.length}`, agent_id: 'agent-one', verb: calls.at(-1).body.verb })
    },
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-cutover-probe/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://pot.example.org/api/inbox/send')
  assert.deepEqual(calls[0].body, {
    to: 'agent-one',
    body: 'mupot cutover probe for agent-one (rid-1-inbox)',
    kind: 'request',
    request_id: 'rid-1-inbox',
  })
  assert.equal(calls[0].init.headers.authorization, 'Bearer agent-secret-token')
  assert.equal(calls[1].url, 'https://pot.example.org/api/fleet/control')
  assert.equal(calls[1].init.headers.authorization, 'Bearer owner-secret-token')
  assert.deepEqual(calls.slice(1).map((c) => c.body), [
    { agent_id: 'agent-one', verb: 'start' },
    { agent_id: 'agent-one', verb: 'stop' },
  ])
  const serialized = JSON.stringify(receipt)
  assert.equal(serialized.includes('agent-secret-token'), false)
  assert.equal(serialized.includes('owner-secret-token'), false)
  assert.ok(receipt.actions.some((a) => a.kind === 'inbox_probe' && a.request_id === 'rid-1-inbox'))
  assert.equal(receipt.actions.filter((a) => a.kind === 'control_request').length, 2)
})

test('cutover probe timestamps the receipt before queueing control work', async () => {
  const events = []
  const receipt = await buildReceipt({
    baseUrl: 'https://pot.example.org',
    agent: 'agent-one',
    queueInbox: false,
    controls: ['start'],
    env: { MUPOT_OWNER_TOKEN: 'owner-token' },
    now: () => {
      events.push('timestamp')
      return '2026-07-08T00:00:00.000Z'
    },
    fetchImpl: async () => {
      events.push('queue')
      return jsonResponse({ ok: true, nonce: 'nonce-start', agent_id: 'agent-one', verb: 'start' })
    },
  })

  assert.equal(receipt.status, 'pass')
  assert.deepEqual(events, ['timestamp', 'queue'])
})

test('cutover probe fails before posting when required tokens are missing', async () => {
  let called = false
  const receipt = await buildReceipt({
    baseUrl: 'https://pot.example.org',
    agent: 'agent-one',
    queueInbox: true,
    controls: ['start'],
    env: {},
    fetchImpl: async () => {
      called = true
      return jsonResponse({ ok: true })
    },
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(called, false)
  assert.ok(receipt.checks.some((c) => c.check === 'agent_token_present' && c.ok === false))
  assert.ok(receipt.checks.some((c) => c.check === 'owner_token_present' && c.ok === false))
})

test('cutover probe records HTTP failures as failed checks', async () => {
  const receipt = await buildReceipt({
    baseUrl: 'https://pot.example.org',
    agent: 'agent-one',
    queueInbox: true,
    controls: ['start'],
    env: {
      MUPOT_AGENT_TOKEN: 'agent-token',
      MUPOT_OWNER_TOKEN: 'owner-token',
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/inbox/send')) return jsonResponse({ error: 'recipient_not_found' }, 404)
      return jsonResponse({ error: 'forbidden' }, 403)
    },
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.check === 'inbox_probe_queued' && c.ok === false && c.status === 404))
  assert.ok(receipt.checks.some((c) => c.check === 'control_request_queued' && c.ok === false && c.status === 403))
})

test('release-bound cutover probe observes redacted matching health before posting', async () => {
  const calls = []
  const receipt = await buildReceipt({
    baseUrl: 'https://pot.example.org/',
    agent: 'agent-one',
    queueInbox: true,
    controls: ['start'],
    releaseSha: RELEASE_SHA,
    requestId: 'rid-bound',
    env: {
      MUPOT_AGENT_TOKEN: 'agent-token',
      MUPOT_OWNER_TOKEN: 'owner-token',
    },
    now: () => '2026-09-01T00:00:00.000Z',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' })
      if (String(url).endsWith('/health')) {
        return jsonResponse({
          ok: true,
          service: 'mupot',
          commit: RELEASE_SHA,
          clean: true,
          deployment_id: 'must-not-be-retained',
        })
      }
      if (String(url).endsWith('/api/inbox/send')) return jsonResponse({ ok: true })
      return jsonResponse({ ok: true, nonce: 'nonce-start' })
    },
  })

  assert.equal(receipt.status, 'pass')
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://pot.example.org/health', 'GET'],
    ['https://pot.example.org/api/inbox/send', 'POST'],
    ['https://pot.example.org/api/fleet/control', 'POST'],
  ])
  assert.equal(receipt.inputs.release_sha, RELEASE_SHA)
  assert.deepEqual(receipt.health, {
    ok: true,
    service: 'mupot',
    commit: RELEASE_SHA,
    clean: true,
  })
  assert.equal(JSON.stringify(receipt).includes('deployment_id'), false)
})

test('release-bound cutover probe refuses every invalid health result before posting', async (t) => {
  const cases = [
    ['health not ok', jsonResponse({ ok: false, service: 'mupot', commit: RELEASE_SHA, clean: true })],
    ['wrong service', jsonResponse({ ok: true, service: 'another-service', commit: RELEASE_SHA, clean: true })],
    ['wrong commit', jsonResponse({ ok: true, service: 'mupot', commit: 'b'.repeat(40), clean: true })],
    ['non-clean health', jsonResponse({ ok: true, service: 'mupot', commit: RELEASE_SHA, clean: false })],
    ['missing clean', jsonResponse({ ok: true, service: 'mupot', commit: RELEASE_SHA })],
    ['malformed health JSON', new Response('{', { status: 200 })],
    ['non-2xx health', jsonResponse({ ok: true, service: 'mupot', commit: RELEASE_SHA, clean: true }, 503)],
  ]

  for (const [name, healthResponse] of cases) {
    await t.test(name, async () => {
      const calls = []
      const receipt = await buildReceipt({
        baseUrl: 'https://pot.example.org',
        agent: 'agent-one',
        queueInbox: true,
        controls: ['start'],
        releaseSha: RELEASE_SHA,
        env: {
          MUPOT_AGENT_TOKEN: 'agent-token',
          MUPOT_OWNER_TOKEN: 'owner-token',
        },
        fetchImpl: async (url, init = {}) => {
          calls.push({ url: String(url), method: init.method ?? 'GET' })
          if (String(url).endsWith('/health')) return healthResponse
          return jsonResponse({ ok: true, nonce: 'must-not-post' })
        },
      })

      assert.equal(receipt.status, 'fail')
      assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
      assert.deepEqual(calls, [{ url: 'https://pot.example.org/health', method: 'GET' }])
    })
  }
})

test('malformed or uppercase release SHA fails before any request', async () => {
  for (const releaseSha of ['abc', 'A'.repeat(40)]) {
    assert.throws(
      () => parseArgs(['--release-sha', releaseSha]),
      /release sha/i,
    )
    let called = false
    const receipt = await buildReceipt({
      baseUrl: 'https://pot.example.org',
      agent: 'agent-one',
      controls: ['start'],
      releaseSha,
      env: { MUPOT_OWNER_TOKEN: 'owner-token' },
      fetchImpl: async () => {
        called = true
        return jsonResponse({ ok: true })
      },
    })
    assert.equal(receipt.status, 'fail')
    assert.equal(called, false)
  }
})

test('parseArgs and base-url validation cover operator inputs', () => {
  const opts = parseArgs([
    '--base-url', 'https://pot.example.org/',
    '--agent', 'agent-one',
    '--queue-inbox',
    '--control', 'start,stop',
    '--body', 'probe',
    '--kind', 'message',
    '--request-id', 'rid',
    '--agent-token-env', 'SENDER_TOKEN',
    '--owner-token-env', 'OWNER_TOKEN',
    '--release-sha', RELEASE_SHA,
  ])

  assert.equal(opts.baseUrl, 'https://pot.example.org/')
  assert.equal(opts.agent, 'agent-one')
  assert.equal(opts.queueInbox, true)
  assert.deepEqual(opts.controls, ['start', 'stop'])
  assert.equal(opts.body, 'probe')
  assert.equal(opts.kind, 'message')
  assert.equal(opts.requestId, 'rid')
  assert.equal(opts.agentTokenEnv, 'SENDER_TOKEN')
  assert.equal(opts.ownerTokenEnv, 'OWNER_TOKEN')
  assert.equal(opts.releaseSha, RELEASE_SHA)
  assert.deepEqual(normalizeBaseUrl('https://pot.example.org/'), { ok: true, value: 'https://pot.example.org' })
  assert.equal(normalizeBaseUrl('ftp://pot.example.org').ok, false)
  assert.throws(() => parseArgs(['--control', 'delete']), /unsupported control verb/)
})

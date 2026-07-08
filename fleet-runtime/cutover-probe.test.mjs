// node --test cutover-probe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReceipt, normalizeBaseUrl, parseArgs } from './cutover-probe.mjs'

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
  assert.deepEqual(normalizeBaseUrl('https://pot.example.org/'), { ok: true, value: 'https://pot.example.org' })
  assert.equal(normalizeBaseUrl('ftp://pot.example.org').ok, false)
  assert.throws(() => parseArgs(['--control', 'delete']), /unsupported control verb/)
})

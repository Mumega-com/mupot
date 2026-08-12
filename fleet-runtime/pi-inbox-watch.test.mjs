import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { authorizeMessage, runCycle, validateConfig } from '../scripts/pi-inbox-watch.mjs'

const AGENT = '3c7acb9e-c6cd-4d29-8749-7aff9b72cc91'
const PROJECT = 'eaf4fb0e-b4f6-4f28-aae6-c06c67ae7afa'
const SENDER = 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
const MESSAGE = {
  seq: 42,
  id: 'msg-pi-42',
  from_agent: SENDER,
  kind: 'request',
  body: 'Report your bounded status.',
  request_id: 'req-pi-42',
  in_reply_to: null,
  project_id: PROJECT,
}

function makeConfig(dir) {
  return validateConfig({
    mcp_url: 'https://mupot.example/mcp',
    token_file: join(dir, 'token'),
    expected_agent_id: AGENT,
    agent_slug: 'pi',
    project_id: PROJECT,
    allowed_senders: [SENDER],
    allowed_project_ids: [PROJECT],
    spool_dir: join(dir, 'spool'),
    lock_file: join(dir, 'lock'),
    interval_sec: 30,
    pi: { pi_path: '/usr/bin/pi', provider: 'openai-codex', model: 'test' },
  })
}
function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inbox-test-'))
  return { dir, config: makeConfig(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
function baseMcp(calls, consume = [MESSAGE]) {
  return async (_token, name, args) => {
    calls.push({ name, args })
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
    if (name === 'inbox' && args.peek) return { messages: [MESSAGE], remaining: 0 }
    if (name === 'inbox' && !args.peek) return { messages: consume, remaining: 0 }
    if (name === 'presence_register' || name === 'presence_deregister') return { ok: true }
    if (name === 'send') return { message: { id: 'ack-1' } }
    throw new Error(`unexpected ${name}`)
  }
}

test('config requires HTTPS, explicit sender/project allowlists, and absolute Pi identity', () => {
  const { dir, cleanup } = tempConfig()
  try {
    assert.throws(() => validateConfig({}), /mcp_url/)
    assert.equal(makeConfig(dir).allowed_senders.has(SENDER), true)
  } finally { cleanup() }
})

test('authorization rejects ack loops, self sender, unauthorized sender, and denied project', () => {
  const { config, cleanup } = tempConfig()
  try {
    assert.deepEqual(authorizeMessage(config, { ...MESSAGE, kind: 'ack' }), { ok: false, consume: true, reason: 'ack_observed' })
    assert.equal(authorizeMessage(config, { ...MESSAGE, from_agent: AGENT }).reason, 'self_sender_denied')
    assert.equal(authorizeMessage(config, { ...MESSAGE, from_agent: 'other-agent' }).reason, 'unauthorized_sender')
    assert.equal(authorizeMessage(config, { ...MESSAGE, project_id: 'other-project' }).reason, 'project_denied')
    assert.equal(authorizeMessage(config, MESSAGE).ok, true)
  } finally { cleanup() }
})

test('cycle persists activating state before RPC, then consumes exact row before correlated ack', async () => {
  const { config, cleanup } = tempConfig()
  const calls = []
  let runCount = 0
  try {
    const result = await runCycle(config, {
      token: 'test-token',
      mcp: baseMcp(calls),
      runPi: async () => {
        runCount += 1
        const file = join(config.spool_dir, readdirSync(config.spool_dir)[0])
        assert.equal(JSON.parse(readFileSync(file)).status, 'activating')
        return { ok: true, accepted: true, settled: true, response: 'Bounded status acknowledged.' }
      },
    })
    assert.deepEqual(result, { ok: true, reason: 'settled_consumed_acked', consumed: 1, activated: 1 })
    assert.equal(runCount, 1)
    const consumeIndex = calls.findIndex((c) => c.name === 'inbox' && c.args.peek === false)
    const ackIndex = calls.findIndex((c) => c.name === 'send')
    assert.ok(consumeIndex >= 0 && ackIndex > consumeIndex)
    assert.deepEqual(calls[ackIndex].args, {
      to: SENDER,
      body: 'Bounded status acknowledged.',
      kind: 'ack',
      request_id: 'pi-ack:msg-pi-42',
      in_reply_to: 'req-pi-42',
      project_id: PROJECT,
    })
    const record = JSON.parse(readFileSync(join(config.spool_dir, readdirSync(config.spool_dir)[0])))
    assert.equal(record.status, 'acked')
    assert.equal(record.body_sha256.length, 64)
  } finally { cleanup() }
})

test('consume race leaves settled spool and retry does not activate Pi twice', async () => {
  const { config, cleanup } = tempConfig()
  let activations = 0
  try {
    const first = await runCycle(config, {
      token: 'x',
      mcp: baseMcp([], []),
      runPi: async () => { activations += 1; return { ok: true, accepted: true, settled: true, response: 'once' } },
    })
    assert.equal(first.reason, 'consume_incomplete')
    assert.equal(activations, 1)

    const second = await runCycle(config, {
      token: 'x',
      mcp: baseMcp([]),
      runPi: async () => { activations += 1; throw new Error('must not reactivate') },
    })
    assert.equal(second.ok, true)
    assert.equal(activations, 1)
  } finally { cleanup() }
})

test('uncertain activation outcome fails closed without consuming or reactivation', async () => {
  const { config, cleanup } = tempConfig()
  const calls = []
  try {
    const first = await runCycle(config, {
      token: 'x', mcp: baseMcp(calls),
      runPi: async () => ({ ok: false, reason: 'timeout' }),
    })
    assert.equal(first.reason, 'timeout')
    assert.equal(calls.some((c) => c.name === 'inbox' && c.args.peek === false), false)

    // activation_failed is also not safe to retry automatically; the model may
    // have run before the adapter lost its settlement signal.
    const secondCalls = []
    const second = await runCycle(config, {
      token: 'x', mcp: baseMcp(secondCalls),
      runPi: async () => { throw new Error('must not rerun') },
    })
    assert.equal(second.reason, 'activation_outcome_uncertain')
    assert.equal(secondCalls.some((c) => c.name === 'inbox' && c.args.peek === false), false)
  } finally { cleanup() }
})

test('wrong identity and signed-only fence stop before inbox read', async () => {
  const { config, cleanup } = tempConfig()
  try {
    const wrongCalls = []
    const wrong = await runCycle(config, { token: 'x', mcp: async (_t, name) => {
      wrongCalls.push(name)
      if (name === 'boot_context') return { bound_agent_id: 'wrong-agent' }
      throw new Error('must stop')
    } })
    assert.equal(wrong.reason, 'wrong_bound_agent')
    assert.deepEqual(wrongCalls, ['boot_context'])

    const fenceCalls = []
    const fenced = await runCycle(config, { token: 'x', mcp: async (_t, name) => {
      fenceCalls.push(name)
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'signed_only' }
      throw new Error('must stop')
    } })
    assert.equal(fenced.reason, 'consumer_fenced')
    assert.deepEqual(fenceCalls, ['boot_context', 'inbox_consumer_status'])
  } finally { cleanup() }
})

test('unauthorized request is durably rejected and consumed without model activation', async () => {
  const { config, cleanup } = tempConfig()
  const denied = { ...MESSAGE, from_agent: 'unauthorized-agent' }
  const calls = []
  let activated = false
  try {
    const mcp = async (_token, name, args) => {
      calls.push({ name, args })
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
      if (name === 'inbox' && args.peek) return { messages: [denied] }
      if (name === 'inbox' && !args.peek) return { messages: [denied] }
      if (name === 'send') return { ok: true }
      throw new Error(`unexpected ${name}`)
    }
    const result = await runCycle(config, { token: 'x', mcp, runPi: async () => { activated = true } })
    assert.equal(result.reason, 'unauthorized_sender')
    assert.equal(activated, false)
    assert.equal(calls.filter((c) => c.name === 'send').length, 1)
  } finally { cleanup() }
})

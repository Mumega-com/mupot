import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { runAgentProfile } from './profile-runner.mjs'

function profile() {
  return {
    schema: 'mupot.agent-profile/v1',
    agent_id: 'hadi-mupot-dme',
    adapter: 'hermes',
    command: ['/opt/homebrew/bin/hermes', 'chat', '--toolsets', 'mumega_dme'],
    allowed_senders: ['hadi-codex-cli'],
    run_for: ['request'],
    timeout_ms: 120000,
  }
}

function batch(overrides = {}) {
  return {
    tenant: 'mumega',
    base_url: 'https://mupot.mumega.com',
    agent_id: 'hadi-mupot-dme',
    spool_dir: '/tmp/mupot-spool',
    files: ['/tmp/mupot-spool/message.json'],
    messages: [{
      id: 'message-a', seq: 1, from_agent: 'hadi-codex-cli', kind: 'request',
      body: 'Run governed work', request_id: 'request-a', in_reply_to: null,
      project_id: 'project-a', created_at: '2026-07-18T20:00:00Z',
    }],
    remaining: 0,
    ...overrides,
  }
}

function successfulSpawn(observed) {
  return (executable, args, options) => {
    const child = new EventEmitter()
    child.pid = 1234
    child.stdin = new EventEmitter()
    child.stdin.end = (value) => {
      observed.push({ executable, args, options, stdin: value })
      queueMicrotask(() => child.emit('exit', 0))
    }
    return child
  }
}

test('spawns the exact executable and argv without a shell and sends bounded JSON stdin', async () => {
  const observed = []
  const result = await runAgentProfile(profile(), batch(), { spawnImpl: successfulSpawn(observed) })

  assert.deepEqual(result, { ok: true, code: 0, activated_messages: 1 })
  assert.equal(observed[0].executable, '/opt/homebrew/bin/hermes')
  assert.deepEqual(observed[0].args, ['chat', '--toolsets', 'mumega_dme'])
  assert.equal(observed[0].options.shell, false)
  assert.equal(observed[0].options.detached, true)
  assert.equal(JSON.parse(observed[0].stdin).messages[0].project_id, 'project-a')
})

test('rejects unauthorized senders before spawning', async () => {
  let spawned = false
  const input = batch({ messages: [{ ...batch().messages[0], from_agent: 'unknown-agent' }] })
  const result = await runAgentProfile(profile(), input, { spawnImpl: () => { spawned = true } })

  assert.deepEqual(result, { ok: false, reason: 'unauthorized_sender' })
  assert.equal(spawned, false)
})

test('rejects acknowledgement loops and non-allowlisted message kinds before spawning', async () => {
  let spawned = false
  const ack = batch({ messages: [{ ...batch().messages[0], kind: 'ack' }] })
  const plain = batch({ messages: [{ ...batch().messages[0], kind: 'message' }] })
  assert.deepEqual(await runAgentProfile(profile(), ack, { spawnImpl: () => { spawned = true } }), { ok: false, reason: 'ack_loop' })
  assert.deepEqual(await runAgentProfile(profile(), plain, { spawnImpl: () => { spawned = true } }), { ok: false, reason: 'message_kind_denied' })
  assert.equal(spawned, false)
})

test('rejects a batch addressed to another welded identity', async () => {
  const result = await runAgentProfile(profile(), batch({ agent_id: 'other-agent' }))
  assert.deepEqual(result, { ok: false, reason: 'agent_mismatch' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { runHermesBatch } from './hermes-inbox-adapter.mjs'

function batch() {
  return {
    tenant: 'dme',
    base_url: 'https://pot.dme.example',
    agent_id: 'dme-hermes-k8s',
    spool_dir: '/var/lib/mupot/inbox/dme-hermes-k8s',
    files: ['/var/lib/mupot/inbox/dme-hermes-k8s/0001.json'],
    messages: [{
      id: 'message-a', seq: 1, from_agent: 'dme-project-link', kind: 'request',
      body: 'Verify the project evidence', request_id: 'request-a', in_reply_to: null,
      project_id: 'dme-delivery-project', created_at: '2026-07-18T20:00:00Z',
    }],
    remaining: 0,
  }
}

function spawnResult(observed, code = 0) {
  return (executable, args, options) => {
    const call = { executable, args, options, stdin: '' }
    observed.push(call)
    const child = new EventEmitter()
    child.pid = 42
    child.stdin = new EventEmitter()
    child.stdin.end = (value) => {
      call.stdin = value
      queueMicrotask(() => child.emit('exit', code))
    }
    return child
  }
}

test('invokes Hermes as one bounded programmatic query without a shell', async () => {
  const observed = []
  const result = await runHermesBatch(batch(), {
    spawnImpl: spawnResult(observed),
    env: {
      HOME: '/home/mupot', PATH: '/usr/local/bin', MUPOT_PLUGIN_MODE: 'operator',
      MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token', OPENAI_API_KEY: 'must-not-pass',
    },
    readFileSyncImpl: () => 'mupot_test_operator_token',
  })

  assert.deepEqual(result, { ok: true, code: 0 })
  assert.equal(observed[0].executable, '/opt/hermes/.venv/bin/python3')
  assert.deepEqual(observed[0].args, ['/opt/mupot/hermes-query-stdin.py'])
  assert.match(observed[0].stdin, /request-a/)
  assert.match(observed[0].stdin, /dme-delivery-project/)
  assert.equal(observed[0].options.shell, false)
  assert.deepEqual(observed[0].options.stdio, ['pipe', 'inherit', 'inherit'])
  assert.deepEqual(observed[0].options.env, {
    HOME: '/home/mupot', PATH: '/usr/local/bin', MUPOT_PLUGIN_MODE: 'operator',
    MUPOT_AGENT_TOKEN: 'mupot_test_operator_token',
  })
})

test('keeps a valid batch larger than Linux MAX_ARG_STRLEN out of argv', async () => {
  const observed = []
  const messages = Array.from({ length: 17 }, (_, index) => ({
    ...batch().messages[0], id: `message-${index}`, request_id: `request-${index}`, body: 'x'.repeat(8000),
  }))
  const result = await runHermesBatch({ ...batch(), messages }, {
    spawnImpl: spawnResult(observed),
    env: { MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token' },
    readFileSyncImpl: () => 'mupot_test_operator_token',
  })
  assert.equal(result.ok, true)
  assert.ok(Buffer.byteLength(observed[0].stdin) > 128 * 1024)
  assert.ok(observed[0].args.every((arg) => !arg.includes('xxxxxxxxxxxxxxxx')))
})

test('rejects malformed and oversized batches before spawning', async () => {
  let spawned = false
  const spawnImpl = () => { spawned = true }
  assert.deepEqual(await runHermesBatch(null, { spawnImpl }), { ok: false, reason: 'invalid_batch' })
  assert.deepEqual(
    await runHermesBatch({ ...batch(), messages: [{ ...batch().messages[0], body: 'x'.repeat(9000) }] }, { spawnImpl }),
    { ok: false, reason: 'invalid_batch' },
  )
  assert.equal(spawned, false)
})

test('propagates a non-zero Hermes exit', async () => {
  const result = await runHermesBatch(batch(), {
    spawnImpl: spawnResult([], 7),
    env: { MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token' },
    readFileSyncImpl: () => 'mupot_test_operator_token',
  })
  assert.deepEqual(result, { ok: false, reason: 'exit_nonzero', code: 7 })
})

test('fails closed when the fixed token file is unavailable or redirected', async () => {
  let spawned = false
  const spawnImpl = () => { spawned = true }
  assert.deepEqual(await runHermesBatch(batch(), {
    spawnImpl,
    env: { MUPOT_AGENT_TOKEN_FILE: '/tmp/token' },
    readFileSyncImpl: () => 'mupot_test_operator_token',
  }), { ok: false, reason: 'credential_unavailable' })
  assert.deepEqual(await runHermesBatch(batch(), {
    spawnImpl,
    env: { MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token' },
    readFileSyncImpl: () => { throw new Error('missing') },
  }), { ok: false, reason: 'credential_unavailable' })
  assert.equal(spawned, false)
})

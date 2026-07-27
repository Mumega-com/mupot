import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  api,
  authorizeMessage,
  completeShutdown,
  cycle,
  readToken,
  runCodexTurn,
  shutdownActiveChild,
  threadLockPath,
  threadTurnActive,
  validateConfig,
} from './codex-thread-endpoint.mjs'

const THREAD_ID = '00000000-0000-4000-8000-000000000001'

function validConfig(overrides = {}) {
  return {
    schema: 'mupot.codex-thread-endpoint/v1',
    base_url: 'https://pot.example',
    token_file: '/Users/test/.config/mupot/agent.token',
    thread_id: THREAD_ID,
    rollout_path: '/Users/test/.codex/sessions/review.jsonl',
    workdir: '/Users/test/work/mupot',
    node_id: 'node-macbook',
    local_source_id: 'source-codex-desktop',
    project_id: 'project-mupot',
    purpose: 'mupot-review',
    workspace: 'Mumega-com/mupot',
    allowed_senders: ['kasra', 'hadi-codex-cli'],
    poll_ms: 5000,
    lease_seconds: 300,
    timeout_ms: 600000,
    http_timeout_ms: 15000,
    shutdown_grace_ms: 5000,
    codex_bin: '/opt/homebrew/bin/codex',
    state_file: '/Users/test/.fleet/state/codex-review.json',
    spool_dir: '/Users/test/.fleet/inbox/codex-review',
    ...overrides,
  }
}

test('config keeps the raw thread id host-local and rejects inline credentials', () => {
  const config = validateConfig(validConfig())
  assert.equal(config.thread_id, THREAD_ID)
  assert.equal(config.project_id, 'project-mupot')
  assert.match(
    threadLockPath(config, '/Users/test'),
    /^\/Users\/test\/\.fleet\/locks\/codex-thread-[a-f0-9]{16}\.lock$/,
  )
  assert.throws(
    () => validateConfig(validConfig({ token_file: 'Bearer mupot_secret' })),
    /token_file/,
  )
  assert.throws(
    () => validateConfig(validConfig({ thread_id: 'not-a-thread' })),
    /thread_id/,
  )
})

test('active-turn guard scans beyond a short file tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-endpoint-'))
  const path = join(dir, 'rollout.jsonl')
  const started = '{"type":"event_msg","payload":{"type":"task_started"}}\n'
  const completed = '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
  writeFileSync(path, started + 'x'.repeat(2 * 1024 * 1024))
  assert.equal(await threadTurnActive(path), true)
  writeFileSync(path, started + 'x'.repeat(2 * 1024 * 1024) + completed)
  assert.equal(await threadTurnActive(path), false)
})

test('token files must be owner-only regular files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-token-'))
  const tokenFile = join(dir, 'agent.token')
  writeFileSync(tokenFile, 'opaque-token-value\n', { mode: 0o600 })
  const config = { token_file: tokenFile }
  assert.equal(readToken(config), 'opaque-token-value')
  chmodSync(tokenFile, 0o644)
  assert.throws(() => readToken(config), /token_file_permissions/)
})

test('sender and project allowlists fail closed before runtime execution', () => {
  const config = validateConfig(validConfig())
  const message = {
    seq: 1,
    id: 'message-1',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    project_id: 'project-mupot',
    kind: 'request',
    body: 'Review.',
  }
  assert.equal(authorizeMessage(config, message, 'endpoint-1'), null)
  assert.equal(authorizeMessage(config, { ...message, from_agent: 'stranger' }), 'unauthorized_sender')
  assert.equal(authorizeMessage(config, { ...message, project_id: 'other-project' }), 'project_denied')
  assert.equal(authorizeMessage(config, { ...message, kind: 'ack' }), 'ack_loop')
  assert.equal(authorizeMessage(config, { ...message, endpoint_id: 'endpoint-2' }, 'endpoint-1'), 'endpoint_denied')
  assert.equal(authorizeMessage(config, { ...message, seq: Number.MAX_SAFE_INTEGER + 1 }), 'invalid_message')
})

test('delivery resumes the exact thread, parses the resulting turn id, and never uses --last', async () => {
  const config = validateConfig(validConfig())
  let observed
  const spawnImpl = (bin, args, opts) => {
    observed = { bin, args, opts }
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write('{"type":"thread.started","thread_id":"redacted"}\n')
      child.stdout.write('{"type":"turn.started","turn_id":"turn-live-123"}\n')
      child.stdout.end()
      child.emit('close', 0, null)
    })
    return child
  }
  const result = await runCodexTurn(config, {
    id: 'message-1',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review the exact head.',
    request_id: 'request-1',
    project_id: 'project-mupot',
  }, { spawnImpl, activeCheck: async () => false })

  assert.deepEqual(result, { ok: true, runtime_turn_id: 'turn-live-123' })
  assert.equal(observed.bin, '/opt/homebrew/bin/codex')
  assert.deepEqual(observed.args.slice(0, 3), ['exec', 'resume', THREAD_ID])
  assert.equal(observed.args.includes('--last'), false)
  assert.equal(observed.args.includes('--json'), true)
  assert.equal(observed.opts.shell, false)
})

test('delivery parses a final JSON event that arrives without a trailing newline', async () => {
  const config = validateConfig(validConfig())
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write('{"type":"turn.started","turn_id":"turn-final-buffer"}')
      child.stdout.end()
      child.emit('close', 0, null)
    })
    return child
  }

  assert.deepEqual(await runCodexTurn(config, {
    id: 'message-final-buffer',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    project_id: 'project-mupot',
  }, { spawnImpl, activeCheck: async () => false }), {
    ok: true,
    runtime_turn_id: 'turn-final-buffer',
  })
})

test('delivery defers without spawning while the exact thread has an active turn', async () => {
  const config = validateConfig(validConfig())
  let spawned = false
  const result = await runCodexTurn(config, {
    id: 'message-1',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    request_id: 'request-1',
    project_id: 'project-mupot',
  }, {
    activeCheck: async () => true,
    spawnImpl: () => {
      spawned = true
      throw new Error('must not spawn')
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'active_turn' })
  assert.equal(spawned, false)
})

test('delivery terminates a stuck Codex subprocess at the configured timeout', async () => {
  const config = { ...validateConfig(validConfig()), timeout_ms: 10 }
  let killed = false
  let spawnedChild
  const spawnImpl = () => {
    const child = new EventEmitter()
    spawnedChild = child
    child.pid = 424242
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    return child
  }
  const result = await runCodexTurn(config, {
    id: 'message-timeout-1',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    request_id: 'request-timeout-1',
    project_id: 'project-mupot',
  }, {
    activeCheck: async () => false,
    spawnImpl,
    killImpl: () => {
      killed = true
      queueMicrotask(() => spawnedChild.emit('close', null, 'SIGKILL'))
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.equal(killed, true)
})

test('unconfirmed subprocess termination is a fatal bridge fault', async () => {
  const config = {
    ...validateConfig(validConfig()),
    timeout_ms: 10,
    shutdown_grace_ms: 10,
  }
  let child
  const spawnImpl = () => {
    child = new EventEmitter()
    child.pid = 454545
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    return child
  }

  const result = await runCodexTurn(config, {
    id: 'message-unconfirmed-termination',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    project_id: 'project-mupot',
  }, {
    activeCheck: async () => false,
    spawnImpl,
    killImpl: () => {},
  })

  assert.deepEqual(result, {
    ok: false,
    reason: 'termination_unconfirmed',
    fatal: true,
  })

  const signals = []
  const shutdown = shutdownActiveChild(config, {
    killImpl: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal))
    },
  })
  await shutdown
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('shutdown rechecks for a child spawned after an early signal', async () => {
  const config = {
    ...validateConfig(validConfig()),
    timeout_ms: 10,
    shutdown_grace_ms: 10,
  }
  const earlyShutdown = shutdownActiveChild(config)
  let child
  const result = await runCodexTurn(config, {
    id: 'message-signal-before-spawn',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    project_id: 'project-mupot',
  }, {
    activeCheck: async () => false,
    spawnImpl: () => {
      child = new EventEmitter()
      child.pid = 464646
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      return child
    },
    killImpl: () => {},
  })
  assert.equal(result.fatal, true)

  const signals = []
  await completeShutdown(config, earlyShutdown, {
    killImpl: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal))
    },
  })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('stdin failure kills and waits for the spawned process before returning', async () => {
  const config = validateConfig(validConfig())
  let child
  const spawnImpl = () => {
    child = new EventEmitter()
    child.pid = 434343
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => child.stdin.emit('error', new Error('broken pipe')))
    return child
  }
  const result = await runCodexTurn(config, {
    id: 'message-stdin-failure',
    endpoint_id: 'endpoint-1',
    from_agent: 'kasra',
    kind: 'request',
    body: 'Review.',
    project_id: 'project-mupot',
  }, {
    activeCheck: async () => false,
    spawnImpl,
    killImpl: () => queueMicrotask(() => child.emit('close', null, 'SIGKILL')),
  })
  assert.deepEqual(result, { ok: false, reason: 'stdin_failed' })
})

test('HTTP calls abort at the configured timeout', async () => {
  const config = { ...validateConfig(validConfig()), http_timeout_ms: 10 }
  const fetchImpl = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

  await assert.rejects(
    () => api(config, 'token-value', '/inbox', {
      method: 'POST',
      body: { endpoint_id: 'endpoint-1' },
      fetchImpl,
    }),
    /runtime_endpoint_http_timeout/,
  )
})

test('accept failure keeps a turn receipt and retries consumption without executing Codex twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-replay-'))
  const rollout = join(dir, 'rollout.jsonl')
  writeFileSync(rollout, '{"type":"event_msg","payload":{"type":"task_complete"}}\n')
  const config = validateConfig(validConfig({
    rollout_path: rollout,
    workdir: dir,
    token_file: join(dir, 'agent.token'),
    state_file: join(dir, 'state.json'),
    spool_dir: join(dir, 'spool'),
  }))
  let acceptAttempts = 0
  let spawnCount = 0
  const message = {
    seq: 1,
    id: 'message-replay-1',
    endpoint_id: 'endpoint-replay-1',
    from_agent: 'kasra',
    from_member: 'member-kasra',
    kind: 'request',
    body: 'Handle exactly once.',
    request_id: 'request-replay-1',
    in_reply_to: null,
    project_id: 'project-mupot',
    created_at: new Date().toISOString(),
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/check-in')) {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.allowed_senders, ['kasra', 'hadi-codex-cli'])
      return Response.json({
        endpoint: { id: 'endpoint-replay-1' },
        endpoint_capability: 'endpointCapabilityReplayValueThatIsLongEnough1234',
      })
    }
    if (path.endsWith('/inbox')) {
      const body = JSON.parse(init.body)
      assert.equal(body.endpoint_capability, 'endpointCapabilityReplayValueThatIsLongEnough1234')
      return Response.json(acceptAttempts >= 2
        ? { messages: [], remaining: 0, consumed: false }
        : { messages: [message], remaining: 1, consumed: false })
    }
    if (path.endsWith('/accept')) {
      const body = JSON.parse(init.body)
      assert.equal(body.endpoint_capability, 'endpointCapabilityReplayValueThatIsLongEnough1234')
      acceptAttempts += 1
      if (acceptAttempts === 1) return Response.json({ error: 'temporary' }, { status: 500 })
      return Response.json({
        schema: 'mupot.runtime-endpoint-ack/v1',
        receipt: {
          endpoint_id: message.endpoint_id,
          message_id: message.id,
          request_id: message.request_id,
          runtime_turn_id: 'turn-replay-1',
          accepted_at: new Date().toISOString(),
          duplicate: true,
        },
      })
    }
    throw new Error(`unexpected request ${path} ${init?.method}`)
  }
  const spawnImpl = () => {
    spawnCount += 1
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write('{"type":"turn.started","turn_id":"turn-replay-1"}\n')
      child.stdout.end()
      child.emit('close', 0, null)
    })
    return child
  }
  const state = {
    schema: 'mupot.codex-thread-endpoint-state/v1',
    runtime_session_handle: 'local-handle-C9xA3XdLqHoP9pQ4T0iRm5zN8yS1',
    endpoint_id: null,
    endpoint_capability: null,
    last_check_in_at: null,
  }

  await assert.rejects(
    () => cycle(config, 'token-value', state, {
      fetchImpl,
      spawnImpl,
      activeCheck: async () => false,
    }),
    /runtime_endpoint_http_500/,
  )
  assert.equal(spawnCount, 1)
  const pendingPath = join(config.spool_dir, '000000000001-message-replay-1.json')
  assert.equal(JSON.parse(readFileSync(pendingPath, 'utf8')).runtime_turn_id, 'turn-replay-1')

  const checkedState = JSON.parse(readFileSync(config.state_file, 'utf8'))
  await cycle(config, 'token-value', checkedState, {
    fetchImpl,
    spawnImpl,
    activeCheck: async () => false,
  })
  assert.equal(spawnCount, 1)
  assert.equal(acceptAttempts, 2)
  assert.equal(existsSync(pendingPath), false)
  assert.equal(
    JSON.parse(readFileSync(join(config.spool_dir, 'receipts', 'message-replay-1.json'), 'utf8'))
      .server_receipt.runtime_turn_id,
    'turn-replay-1',
  )
})

test('an uncertain prior dispatch latches a durable fatal fault instead of polling forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-uncertain-'))
  const config = validateConfig(validConfig({
    rollout_path: join(dir, 'rollout.jsonl'),
    workdir: dir,
    token_file: join(dir, 'agent.token'),
    state_file: join(dir, 'state.json'),
    spool_dir: join(dir, 'spool'),
  }))
  const message = {
    seq: 1,
    id: 'message-uncertain-1',
    endpoint_id: 'endpoint-uncertain-1',
    from_agent: 'kasra',
    from_member: 'member-kasra',
    kind: 'request',
    body: 'Do not dispatch twice.',
    request_id: 'request-uncertain-1',
    in_reply_to: null,
    project_id: 'project-mupot',
    created_at: new Date().toISOString(),
  }
  const pendingPath = join(config.spool_dir, '000000000001-message-uncertain-1.json')
  mkdirSync(config.spool_dir, { recursive: true })
  writeFileSync(pendingPath, JSON.stringify({
    schema: 'mupot.codex-thread-pending/v1',
    persisted_at: new Date().toISOString(),
    endpoint_id: message.endpoint_id,
    message,
    dispatch_state: 'dispatching',
    dispatching_at: new Date().toISOString(),
    delivery_id: 'delivery-uncertain-1',
  }))
  const state = {
    schema: 'mupot.codex-thread-endpoint-state/v1',
    runtime_session_handle: 'local-handle-D0yB4YeMrIpQ0qR5U1jSn6aO9zT2',
    endpoint_id: message.endpoint_id,
    endpoint_capability: 'endpointCapabilityUncertainValueThatIsLongEnough123',
    last_check_in_at: new Date().toISOString(),
  }
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/inbox')) {
      return Response.json({ messages: [message], remaining: 1, consumed: false })
    }
    throw new Error(`unexpected request ${path}`)
  }

  await assert.rejects(
    () => cycle(config, 'token-value', state, { fetchImpl }),
    /fatal_bridge_fault:delivery_uncertain/,
  )
  const fault = JSON.parse(readFileSync(`${config.state_file}.fault.json`, 'utf8'))
  assert.equal(fault.reason, 'delivery_uncertain')
  assert.equal(fault.message_id, message.id)
  assert.equal(existsSync(pendingPath), true)
})

test('an unwritable fault path still raises a fatal bridge fault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-fault-write-'))
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'not-a-directory')
  const config = validateConfig(validConfig({
    rollout_path: join(dir, 'rollout.jsonl'),
    workdir: dir,
    token_file: join(dir, 'agent.token'),
    state_file: join(blocked, 'state.json'),
    spool_dir: join(dir, 'spool'),
  }))
  const message = {
    seq: 1,
    id: 'message-fault-write-1',
    endpoint_id: 'endpoint-fault-write-1',
    from_agent: 'kasra',
    from_member: 'member-kasra',
    kind: 'request',
    body: 'Remain stopped even if the marker cannot be written.',
    request_id: 'request-fault-write-1',
    in_reply_to: null,
    project_id: 'project-mupot',
    created_at: new Date().toISOString(),
  }
  mkdirSync(config.spool_dir, { recursive: true })
  writeFileSync(join(config.spool_dir, '000000000001-message-fault-write-1.json'), JSON.stringify({
    schema: 'mupot.codex-thread-pending/v1',
    persisted_at: new Date().toISOString(),
    endpoint_id: message.endpoint_id,
    message,
    dispatch_state: 'dispatching',
    dispatching_at: new Date().toISOString(),
    delivery_id: 'delivery-fault-write-1',
  }))
  const state = {
    schema: 'mupot.codex-thread-endpoint-state/v1',
    runtime_session_handle: 'local-handle-E1zC5ZfNsJqR1rS6V2kTo7bP0aU3',
    endpoint_id: message.endpoint_id,
    endpoint_capability: 'endpointCapabilityFaultWriteValueThatIsLongEnough12',
    last_check_in_at: new Date().toISOString(),
  }

  await assert.rejects(
    () => cycle(config, 'token-value', state, {
      fetchImpl: async (url) => {
        if (new URL(url).pathname.endsWith('/inbox')) {
          return Response.json({ messages: [message], remaining: 1, consumed: false })
        }
        throw new Error('unexpected request')
      },
    }),
    /fatal_bridge_fault:delivery_uncertain/,
  )
})

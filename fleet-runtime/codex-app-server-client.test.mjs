import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { runAppServerTurn } from './codex-app-server-client.mjs'

class FakeSocket extends EventEmitter {
  constructor(handler) {
    super()
    this.handler = handler
    this.sent = []
    this.readyState = 0
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  send(raw) {
    const message = JSON.parse(raw)
    this.sent.push(message)
    this.handler(message, this)
  }

  reply(message) {
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(message))))
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)))
  }

  terminate() {
    this.close()
  }
}

function config(overrides = {}) {
  return {
    app_server_socket: '/tmp/codex-app-server.sock',
    thread_id: '019fbd98-2b25-7881-beb6-9edc15e0d48b',
    workdir: '/home/mumega',
    timeout_ms: 1000,
    shutdown_grace_ms: 100,
    ...overrides,
  }
}

function message() {
  return {
    id: 'message-1',
    from_agent: 'cairn',
    project_id: 'mcpwp',
    body: 'Map the acceptance evidence.',
  }
}

test('resumes the exact thread and starts one attributed App Server turn', async () => {
  const started = []
  const socket = new FakeSocket((request, peer) => {
    if (request.method === 'initialize') {
      peer.reply({ id: request.id, result: { userAgent: 'codex-test' } })
    } else if (request.method === 'thread/resume') {
      peer.reply({
        id: request.id,
        result: { thread: { id: config().thread_id, status: { type: 'idle' } } },
      })
    } else if (request.method === 'turn/start') {
      peer.reply({
        id: request.id,
        result: { turn: { id: 'turn-app-server-1', status: 'inProgress', items: [] } },
      })
      peer.reply({
        method: 'turn/completed',
        params: {
          threadId: config().thread_id,
          turn: { id: 'turn-app-server-1', status: 'completed', items: [] },
        },
      })
    }
  })

  const result = await runAppServerTurn(config(), message(), {
    connectImpl: () => socket,
    prompt: 'trusted attributed prompt',
    onTurnStarted: (turnId) => started.push(turnId),
  })

  assert.deepEqual(result, {
    ok: true,
    runtime_turn_id: 'turn-app-server-1',
    completion_status: 'completed',
  })
  assert.deepEqual(started, ['turn-app-server-1'])
  assert.deepEqual(
    socket.sent.map(({ method }) => method),
    ['initialize', 'initialized', 'thread/resume', 'turn/start'],
  )
  assert.equal(socket.sent[2].params.threadId, config().thread_id)
  assert.deepEqual(socket.sent[3].params, {
    threadId: config().thread_id,
    input: [{ type: 'text', text: 'trusted attributed prompt' }],
    cwd: '/home/mumega',
  })
})

test('defers without starting a turn when App Server reports the thread active', async () => {
  const socket = new FakeSocket((request, peer) => {
    if (request.method === 'initialize') {
      peer.reply({ id: request.id, result: {} })
    } else if (request.method === 'thread/resume') {
      peer.reply({
        id: request.id,
        result: {
          thread: {
            id: config().thread_id,
            status: { type: 'active', activeFlags: ['waitingOnModel'] },
          },
        },
      })
    }
  })

  const result = await runAppServerTurn(config(), message(), {
    connectImpl: () => socket,
    prompt: 'not dispatched',
  })

  assert.deepEqual(result, { ok: false, reason: 'active_turn' })
  assert.equal(socket.sent.some(({ method }) => method === 'turn/start'), false)
})

test('treats a turn-start race rejection as retryable', async () => {
  const socket = new FakeSocket((request, peer) => {
    if (request.method === 'initialize') {
      peer.reply({ id: request.id, result: {} })
    } else if (request.method === 'thread/resume') {
      peer.reply({
        id: request.id,
        result: { thread: { id: config().thread_id, status: { type: 'idle' } } },
      })
    } else if (request.method === 'turn/start') {
      peer.reply({ id: request.id, error: { code: -32000, message: 'turn rejected' } })
    }
  })

  const result = await runAppServerTurn(config(), message(), {
    connectImpl: () => socket,
    prompt: 'retry later',
  })

  assert.deepEqual(result, { ok: false, reason: 'turn_start_rejected' })
})

test('latches uncertainty when the connection closes after turn acceptance', async () => {
  const started = []
  const socket = new FakeSocket((request, peer) => {
    if (request.method === 'initialize') {
      peer.reply({ id: request.id, result: {} })
    } else if (request.method === 'thread/resume') {
      peer.reply({
        id: request.id,
        result: { thread: { id: config().thread_id, status: { type: 'idle' } } },
      })
    } else if (request.method === 'turn/start') {
      peer.reply({
        id: request.id,
        result: { turn: { id: 'turn-uncertain-1', status: 'inProgress', items: [] } },
      })
      queueMicrotask(() => peer.emit('close', 1006, Buffer.from('lost')))
    }
  })

  const result = await runAppServerTurn(config(), message(), {
    connectImpl: () => socket,
    prompt: 'accepted then disconnected',
    onTurnStarted: (turnId) => started.push(turnId),
  })

  assert.deepEqual(started, ['turn-uncertain-1'])
  assert.deepEqual(result, {
    ok: false,
    reason: 'delivery_uncertain',
    fatal: true,
    runtime_turn_id: 'turn-uncertain-1',
  })
})

test('fails closed when the resumed thread identity differs from config', async () => {
  const socket = new FakeSocket((request, peer) => {
    if (request.method === 'initialize') {
      peer.reply({ id: request.id, result: {} })
    } else if (request.method === 'thread/resume') {
      peer.reply({
        id: request.id,
        result: {
          thread: {
            id: '019fbd98-2b25-7881-beb6-9edc15e0d48c',
            status: { type: 'idle' },
          },
        },
      })
    }
  })

  const result = await runAppServerTurn(config(), message(), {
    connectImpl: () => socket,
    prompt: 'wrong thread must never run',
  })

  assert.deepEqual(result, {
    ok: false,
    reason: 'thread_identity_mismatch',
    fatal: true,
  })
})

test('aborts a connection attempt promptly during service shutdown', async () => {
  const controller = new AbortController()
  const socket = new EventEmitter()
  socket.readyState = 0
  socket.terminate = () => {
    socket.readyState = 3
    queueMicrotask(() => socket.emit('close', 1006, Buffer.from('shutdown')))
  }

  const resultPromise = runAppServerTurn(config({ timeout_ms: 60_000 }), message(), {
    connectImpl: () => socket,
    prompt: 'must not dispatch',
    signal: controller.signal,
  })
  controller.abort()

  assert.deepEqual(await resultPromise, { ok: false, reason: 'shutdown' })
})

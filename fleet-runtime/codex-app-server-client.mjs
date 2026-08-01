import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import WebSocket from 'ws'

const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

class RpcError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'RpcError'
    this.remote = options.remote === true
    this.code = options.code
  }
}

function socketReason(code, reason) {
  const suffix = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '')
  return suffix ? `app_server_closed:${code}:${suffix}` : `app_server_closed:${code}`
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.on === 'function') {
    socket.on(event, listener)
    return () => socket.off?.(event, listener)
  }
  socket.addEventListener(event, listener)
  return () => socket.removeEventListener(event, listener)
}

async function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => finish(new RpcError('app_server_connect_timeout')), timeoutMs)
    const cleanups = []
    const finish = (error = null) => {
      clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
      if (error) rejectOpen(error)
      else resolveOpen()
    }
    cleanups.push(addSocketListener(socket, 'open', () => finish()))
    cleanups.push(addSocketListener(socket, 'error', () => finish(new RpcError('app_server_connect_failed'))))
    cleanups.push(addSocketListener(socket, 'close', (code, reason) => {
      finish(new RpcError(socketReason(code, reason)))
    }))
  })
}

function maskedFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  let header
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  const encoded = Buffer.alloc(body.length)
  for (let index = 0; index < body.length; index += 1) {
    encoded[index] = body[index] ^ mask[index % 4]
  }
  return Buffer.concat([header, mask, encoded])
}

class RawUnixWebSocket extends EventEmitter {
  constructor(socketPath) {
    super()
    this.readyState = 0
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = null
    this.closeCode = 1006
    this.closeReason = Buffer.alloc(0)
    this.socket = createConnection({ path: socketPath })
    this.socket.on('connect', () => {
      this.readyState = 1
      this.emit('open')
    })
    this.socket.on('data', (chunk) => this.consume(chunk))
    this.socket.on('error', (error) => this.emit('error', error))
    this.socket.on('close', () => {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close', this.closeCode, this.closeReason)
    })
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const final = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const wideLength = this.buffer.readBigUInt64BE(2)
        if (wideLength > 16n * 1024n * 1024n) return this.protocolError()
        length = Number(wideLength)
        offset = 10
      }
      if (length > 16 * 1024 * 1024) return this.protocolError()
      const maskBytes = masked ? 4 : 0
      if (this.buffer.length < offset + maskBytes + length) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      offset += maskBytes
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(offset + length)
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4]
        }
      }
      if (!this.handleFrame(opcode, final, payload)) return
    }
  }

  handleFrame(opcode, final, payload) {
    if (opcode === 0x8) {
      if (payload.length >= 2) {
        this.closeCode = payload.readUInt16BE(0)
        this.closeReason = payload.subarray(2)
      }
      this.socket.end(maskedFrame(0x8, payload))
      return false
    }
    if (opcode === 0x9) {
      this.socket.write(maskedFrame(0x0a, payload))
      return true
    }
    if (opcode === 0x0a) return true
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode !== null) return this.protocolError()
      this.fragmentOpcode = opcode
      this.fragments = [payload]
    } else if (opcode === 0x0) {
      if (this.fragmentOpcode === null) return this.protocolError()
      this.fragments.push(payload)
    } else {
      return this.protocolError()
    }
    if (final) {
      const message = Buffer.concat(this.fragments)
      this.fragments = []
      this.fragmentOpcode = null
      this.emit('message', message)
    }
    return true
  }

  protocolError() {
    this.closeCode = 1002
    this.closeReason = Buffer.from('protocol error')
    this.socket.destroy()
    return false
  }

  send(value) {
    if (this.readyState !== 1) throw new Error('app_server_socket_not_open')
    this.socket.write(maskedFrame(0x1, Buffer.from(String(value))))
  }

  close() {
    if (this.readyState >= 2) return
    this.readyState = 2
    this.socket.end(maskedFrame(0x8, Buffer.from([0x03, 0xe8])))
  }

  terminate() {
    this.socket.destroy()
  }
}

class AdaptiveUnixWebSocket extends EventEmitter {
  constructor(socketPath) {
    super()
    this.socketPath = socketPath
    this.readyState = 0
    this.delegate = null
    this.candidate = null
    this.attempt = 0
    this.tryUpgrade()
  }

  tryUpgrade() {
    const attempt = ++this.attempt
    const socket = new WebSocket('ws://localhost/rpc', {
      createConnection: () => createConnection({ path: this.socketPath }),
      perMessageDeflate: false,
    })
    this.candidate = socket
    let opened = false
    socket.on('open', () => {
      if (attempt !== this.attempt) return
      opened = true
      this.activate(socket)
    })
    socket.on('message', (message) => {
      if (attempt === this.attempt && opened) this.emit('message', message)
    })
    socket.on('error', (error) => {
      if (attempt !== this.attempt) return
      if (!opened) this.tryRaw(attempt)
      else this.emit('error', error)
    })
    socket.on('close', (code, reason) => {
      if (attempt !== this.attempt) return
      if (!opened) this.tryRaw(attempt)
      else this.forwardClose(code, reason)
    })
  }

  tryRaw(upgradeAttempt) {
    if (upgradeAttempt !== this.attempt || this.readyState >= 2) return
    this.candidate?.terminate?.()
    const attempt = ++this.attempt
    const socket = new RawUnixWebSocket(this.socketPath)
    this.candidate = socket
    socket.on('open', () => {
      if (attempt === this.attempt) this.activate(socket)
    })
    socket.on('message', (message) => {
      if (attempt === this.attempt) this.emit('message', message)
    })
    socket.on('error', (error) => {
      if (attempt === this.attempt) this.emit('error', error)
    })
    socket.on('close', (code, reason) => {
      if (attempt === this.attempt) this.forwardClose(code, reason)
    })
  }

  activate(socket) {
    if (this.readyState >= 2) {
      socket.terminate?.()
      return
    }
    this.delegate = socket
    this.candidate = socket
    this.readyState = 1
    this.emit('open')
  }

  forwardClose(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', code, reason)
  }

  send(value) {
    return this.delegate.send(value)
  }

  close() {
    if (this.readyState >= 2) return
    this.readyState = 2
    const socket = this.delegate ?? this.candidate
    try {
      socket?.close()
    } catch {
      socket?.terminate?.()
    }
  }

  terminate() {
    if (this.readyState === 3) return
    this.readyState = 3
    const socket = this.delegate ?? this.candidate
    socket?.terminate?.()
    this.emit('close', 1006, Buffer.from('terminated'))
  }
}

export function connectAppServerSocket(socketPath) {
  return new AdaptiveUnixWebSocket(socketPath)
}

class AppServerRpc {
  constructor(socket, options = {}) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.closedError = null
    this.onNotification = options.onNotification ?? (() => {})
    this.onServerRequest = options.onServerRequest
    this.cleanups = [
      addSocketListener(socket, 'message', (data) => this.handleMessage(data)),
      addSocketListener(socket, 'error', () => this.closePending(new RpcError('app_server_connection_error'))),
      addSocketListener(socket, 'close', (code, reason) => {
        this.closePending(new RpcError(socketReason(code, reason)))
      }),
    ]
  }

  handleMessage(data) {
    let message
    try {
      const raw = data?.data ?? data
      message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw))
    } catch {
      return
    }
    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new RpcError('app_server_request_rejected', {
          remote: true,
          code: message.error.code,
        }))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message?.method && Object.hasOwn(message, 'id')) {
      if (this.onServerRequest) {
        Promise.resolve(this.onServerRequest(message)).then(
          (result) => this.send({ id: message.id, result: result ?? {} }),
          () => this.send({ id: message.id, error: { code: -32000, message: 'request declined' } }),
        ).catch(() => {})
      } else {
        this.send({ id: message.id, error: { code: -32601, message: 'unsupported server request' } })
      }
      return
    }
    if (message?.method) this.onNotification(message)
  }

  send(message) {
    if (this.closedError) throw this.closedError
    this.socket.send(JSON.stringify(message))
  }

  request(method, params, options = {}) {
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      try {
        options.beforeSend?.()
        this.send({ method, id, params })
      } catch (error) {
        this.pending.delete(id)
        rejectRequest(error)
      }
    })
  }

  notify(method, params = {}) {
    this.send({ method, params })
  }

  closePending(error) {
    if (this.closedError) return
    this.closedError = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.onNotification({ method: 'transport/closed', params: { error } })
  }

  close() {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    try {
      this.socket.close()
    } catch {
      this.socket.terminate?.()
    }
  }
}

function threadStatus(result) {
  return result?.thread?.status?.type ?? null
}

function validTurnId(value) {
  return typeof value === 'string' && TURN_ID_RE.test(value)
}

export async function runAppServerTurn(config, _message, options = {}) {
  if (typeof options.prompt !== 'string' || options.prompt.length === 0) {
    return { ok: false, reason: 'invalid_prompt', fatal: true }
  }
  const connectImpl = options.connectImpl ?? connectAppServerSocket
  let socket
  let rpc
  let timer
  let turnStartSent = false
  let runtimeTurnId = null
  let completionResolve
  let abortHandler
  const completions = new Map()
  const completion = new Promise((resolveCompletion) => {
    completionResolve = resolveCompletion
  })
  const onNotification = (notification) => {
    if (notification.method === 'turn/completed') {
      const turn = notification.params?.turn
      if (validTurnId(turn?.id)) {
        completions.set(turn.id, turn)
        if (runtimeTurnId === turn.id) completionResolve({ turn })
      }
    } else if (notification.method === 'transport/closed') {
      completionResolve({ error: notification.params?.error })
    }
    options.onNotification?.(notification)
  }

  try {
    if (options.signal?.aborted) return { ok: false, reason: 'shutdown' }
    socket = connectImpl(config.app_server_socket)
    abortHandler = () => {
      if (rpc) rpc.closePending(new RpcError('app_server_shutdown'))
      else socket?.terminate?.()
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })
    await waitForOpen(socket, Math.min(config.timeout_ms, 30_000))
    rpc = new AppServerRpc(socket, {
      onNotification,
      onServerRequest: options.onServerRequest,
    })
    timer = setTimeout(() => rpc.closePending(new RpcError('app_server_turn_timeout')), config.timeout_ms)

    await rpc.request('initialize', {
      clientInfo: {
        name: 'mupot-runtime-endpoint',
        title: 'Mupot Runtime Endpoint',
        version: '1.0.0',
      },
    })
    rpc.notify('initialized')

    const resumed = await rpc.request('thread/resume', { threadId: config.thread_id })
    if (resumed?.thread?.id !== config.thread_id) {
      return { ok: false, reason: 'thread_identity_mismatch', fatal: true }
    }
    if (threadStatus(resumed) === 'active') {
      return { ok: false, reason: 'active_turn' }
    }

    let started
    try {
      started = await rpc.request('turn/start', {
        threadId: config.thread_id,
        input: [{ type: 'text', text: options.prompt }],
        cwd: config.workdir,
      }, {
        beforeSend: () => {
          turnStartSent = true
          options.onDispatching?.()
        },
      })
    } catch (error) {
      if (error?.remote === true) return { ok: false, reason: 'turn_start_rejected' }
      throw error
    }

    runtimeTurnId = started?.turn?.id
    if (!validTurnId(runtimeTurnId)) {
      return { ok: false, reason: 'turn_id_missing', fatal: true }
    }
    options.onTurnStarted?.(runtimeTurnId)

    const alreadyCompleted = completions.get(runtimeTurnId)
    const terminal = alreadyCompleted ? { turn: alreadyCompleted } : await completion
    if (terminal.error) {
      return {
        ok: false,
        reason: 'delivery_uncertain',
        fatal: true,
        runtime_turn_id: runtimeTurnId,
      }
    }
    return {
      ok: true,
      runtime_turn_id: runtimeTurnId,
      completion_status: terminal.turn.status,
    }
  } catch (error) {
    if (options.signal?.aborted && !turnStartSent) {
      return { ok: false, reason: 'shutdown' }
    }
    if (turnStartSent) {
      return {
        ok: false,
        reason: 'delivery_uncertain',
        fatal: true,
        ...(runtimeTurnId ? { runtime_turn_id: runtimeTurnId } : {}),
      }
    }
    return { ok: false, reason: 'app_server_unavailable' }
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler)
    clearTimeout(timer)
    rpc?.close()
    if (!rpc && socket) {
      try {
        socket.close()
      } catch {
        socket.terminate?.()
      }
    }
  }
}

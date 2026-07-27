#!/usr/bin/env node
// Exact Codex thread bridge for Mupot runtime endpoints (#577).
//
// Mupot stores an opaque endpoint id and a hash of a host-generated session
// handle. The raw Codex thread UUID remains only in this host-local config. The
// bridge peeks endpoint-addressed messages, persists each one before execution,
// refuses sender/project mismatches, avoids overlapping an active turn, resumes
// the exact thread, and accepts the message only after Codex reports a turn id.

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { acquireSingletonLock } from './singleton-lock.mjs'

export const CODEX_THREAD_ENDPOINT_SCHEMA = 'mupot.codex-thread-endpoint/v1'
const STATE_SCHEMA = 'mupot.codex-thread-endpoint-state/v1'
const RECEIPT_SCHEMA = 'mupot.codex-thread-delivery-receipt/v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_RE = /Bearer\s+\S+|\bmupot_[A-Za-z0-9_-]+\b|(?:authorization|token|private_key|secret)\s*[:=]/i
const STARTED_TOKEN = '"type":"event_msg","payload":{"type":"task_started"'
const COMPLETED_TOKEN = '"type":"event_msg","payload":{"type":"task_complete"'
const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const MAX_CODEX_STDOUT_BUFFER = 1024 * 1024
let activeChild = null

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path
}

function requiredPath(value, name) {
  const expanded = expandHome(value)
  if (typeof expanded !== 'string' || !isAbsolute(expanded)) {
    throw new Error(`config.${name} must be an absolute path`)
  }
  return resolve(expanded)
}

function requiredRef(value, name) {
  if (typeof value !== 'string' || !REF_RE.test(value)) {
    throw new Error(`config.${name} invalid`)
  }
  return value
}

function uniqueRefs(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error(`config.${name} must be a non-empty array`)
  }
  const refs = value.map((item) => requiredRef(item, name))
  if (new Set(refs).size !== refs.length) throw new Error(`config.${name} contains duplicates`)
  return refs
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a JSON object')
  if (raw.schema !== CODEX_THREAD_ENDPOINT_SCHEMA) throw new Error(`config.schema must be ${CODEX_THREAD_ENDPOINT_SCHEMA}`)
  if (typeof raw.base_url !== 'string' || !/^https:\/\/[^/]+/.test(raw.base_url)) {
    throw new Error('config.base_url must be an https URL')
  }
  const tokenFile = requiredPath(raw.token_file, 'token_file')
  if (SECRET_RE.test(raw.token_file)) throw new Error('config.token_file must be a path, not a credential')
  if (typeof raw.thread_id !== 'string' || !UUID_RE.test(raw.thread_id)) {
    throw new Error('config.thread_id must be the exact Codex thread UUID')
  }
  const pollMs = Number(raw.poll_ms)
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60_000) {
    throw new Error('config.poll_ms must be an integer from 1000 to 60000')
  }
  const leaseSeconds = Number(raw.lease_seconds)
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 3600) {
    throw new Error('config.lease_seconds must be an integer from 60 to 3600')
  }
  const timeoutMs = Number(raw.timeout_ms)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new Error('config.timeout_ms must be an integer from 1000 to 600000')
  }
  const httpTimeoutMs = Number(raw.http_timeout_ms)
  if (!Number.isInteger(httpTimeoutMs) || httpTimeoutMs < 1000 || httpTimeoutMs > 60_000) {
    throw new Error('config.http_timeout_ms must be an integer from 1000 to 60000')
  }
  const shutdownGraceMs = Number(raw.shutdown_grace_ms)
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1000 || shutdownGraceMs > 30_000) {
    throw new Error('config.shutdown_grace_ms must be an integer from 1000 to 30000')
  }
  return {
    schema: CODEX_THREAD_ENDPOINT_SCHEMA,
    base_url: raw.base_url.replace(/\/+$/, ''),
    token_file: tokenFile,
    thread_id: raw.thread_id,
    rollout_path: requiredPath(raw.rollout_path, 'rollout_path'),
    workdir: requiredPath(raw.workdir, 'workdir'),
    node_id: requiredRef(raw.node_id, 'node_id'),
    local_source_id: requiredRef(raw.local_source_id, 'local_source_id'),
    project_id: requiredRef(raw.project_id, 'project_id'),
    purpose: requiredRef(raw.purpose, 'purpose'),
    workspace: typeof raw.workspace === 'string' && raw.workspace.length >= 1 && raw.workspace.length <= 240
      ? raw.workspace
      : (() => { throw new Error('config.workspace invalid') })(),
    allowed_senders: uniqueRefs(raw.allowed_senders, 'allowed_senders'),
    poll_ms: pollMs,
    lease_seconds: leaseSeconds,
    timeout_ms: timeoutMs,
    http_timeout_ms: httpTimeoutMs,
    shutdown_grace_ms: shutdownGraceMs,
    codex_bin: requiredPath(raw.codex_bin, 'codex_bin'),
    state_file: requiredPath(raw.state_file, 'state_file'),
    spool_dir: requiredPath(raw.spool_dir, 'spool_dir'),
  }
}

export function threadLockPath(config, homeDir = homedir()) {
  const threadHash = createHash('sha256').update(config.thread_id).digest('hex').slice(0, 16)
  return join(homeDir, '.fleet', 'locks', `codex-thread-${threadHash}.lock`)
}

export async function threadTurnActive(rolloutPath) {
  const chunkSize = 1024 * 1024
  let handle
  try {
    handle = await open(rolloutPath, 'r')
    const { size } = await handle.stat()
    let end = size
    let carry = ''
    while (end > 0) {
      const start = Math.max(0, end - chunkSize)
      const buffer = Buffer.alloc(end - start)
      await handle.read(buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8') + carry
      const startedAt = text.lastIndexOf(STARTED_TOKEN)
      const completedAt = text.lastIndexOf(COMPLETED_TOKEN)
      if (startedAt >= 0 || completedAt >= 0) return startedAt > completedAt
      carry = text.slice(0, Math.max(STARTED_TOKEN.length, COMPLETED_TOKEN.length))
      end = start
    }
    return false
  } finally {
    await handle?.close()
  }
}

export function authorizeMessage(config, message, endpointId = null) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid_message'
  if (!config.allowed_senders.includes(message.from_agent)) return 'unauthorized_sender'
  if (message.project_id !== config.project_id) return 'project_denied'
  if (message.kind === 'ack') return 'ack_loop'
  if (message.kind !== 'request' && message.kind !== 'message') return 'message_kind_denied'
  if (!Number.isSafeInteger(message.seq) || message.seq < 1) return 'invalid_message'
  if (typeof message.id !== 'string' || !REF_RE.test(message.id)) return 'invalid_message'
  if (typeof message.endpoint_id !== 'string' || !REF_RE.test(message.endpoint_id)) return 'invalid_message'
  if (endpointId !== null && message.endpoint_id !== endpointId) return 'endpoint_denied'
  if (typeof message.body !== 'string' || !message.body || message.body.length > 8000) return 'invalid_message'
  return null
}

function promptForMessage(message) {
  return [
    'You were activated by a Mupot exact-runtime endpoint.',
    `Sender: ${message.from_agent}`,
    `Project: ${message.project_id}`,
    `Message ID: ${message.id}`,
    message.request_id ? `Request ID: ${message.request_id}` : '',
    message.delivery_id ? `Delivery ID: ${message.delivery_id}` : '',
    '',
    message.body,
    '',
    message.request_id
      ? `After handling this request, reply through Mupot with in_reply_to=${message.request_id}.`
      : 'Handle the message in this existing project thread.',
  ].filter(Boolean).join('\n')
}

function turnIdFromEvent(value) {
  if (!value || typeof value !== 'object') return null
  for (const candidate of [
    value.turn_id,
    value.turnId,
    value.turn?.id,
    value.payload?.turn_id,
    value.payload?.turn?.id,
  ]) {
    if (typeof candidate === 'string' && TURN_ID_RE.test(candidate)) return candidate
  }
  return null
}

export function runCodexTurn(config, message, options = {}) {
  const activeCheck = options.activeCheck ?? (() => threadTurnActive(config.rollout_path))
  const spawnImpl = options.spawnImpl ?? spawn
  const killImpl = options.killImpl ?? process.kill
  return Promise.resolve(activeCheck()).then((active) => {
    if (active) return { ok: false, reason: 'active_turn' }
    return new Promise((resolveDone) => {
      let settled = false
      let timer
      let killGraceTimer
      let timedOut = false
      let receiptPersistFailed = false
      let processFailureReason = null
      let runtimeTurnId = null
      let stdoutCarry = ''
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(killGraceTimer)
        if (activeChild === child && value?.reason !== 'termination_unconfirmed') {
          activeChild = null
        }
        resolveDone(value)
      }
      let child
      const captureTurnId = (parsed) => {
        if (runtimeTurnId || !parsed) return
        runtimeTurnId = parsed
        try {
          options.onTurnStarted?.(parsed)
        } catch {
          receiptPersistFailed = true
          terminateChild('turn_receipt_persist_failed')
        }
      }
      const terminateChild = (reason) => {
        processFailureReason ??= reason
        try {
          if (child.pid) killImpl(-child.pid, 'SIGKILL')
          else child.kill?.('SIGKILL')
        } catch {
          // Wait for close or the normal execution timeout.
        }
        killGraceTimer ??= setTimeout(
          () => finish({ ok: false, reason: 'termination_unconfirmed', fatal: true }),
          config.shutdown_grace_ms,
        )
      }
      try {
        options.onDispatching?.()
        child = spawnImpl(
          config.codex_bin,
          [
            'exec',
            'resume',
            config.thread_id,
            '--skip-git-repo-check',
            '--json',
            '-',
          ],
          {
            cwd: config.workdir,
            env: {
              HOME: process.env.HOME,
              PATH: process.env.PATH,
              CODEX_HOME: process.env.CODEX_HOME,
            },
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
      } catch {
        return finish({ ok: false, reason: 'spawn_failed' })
      }
      activeChild = child
      timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) killImpl(-child.pid, 'SIGKILL')
          else child.kill?.('SIGKILL')
        } catch {
          // The process may already have exited between timeout and kill.
        }
        killGraceTimer = setTimeout(
          () => finish({ ok: false, reason: 'termination_unconfirmed', fatal: true }),
          config.shutdown_grace_ms,
        )
      }, config.timeout_ms)
      child.stdout.setEncoding?.('utf8')
      child.stderr.resume?.()
      child.stdout.on('data', (chunk) => {
        stdoutCarry += String(chunk)
        if (stdoutCarry.length > MAX_CODEX_STDOUT_BUFFER) {
          terminateChild('stdout_overflow')
          return
        }
        const lines = stdoutCarry.split(/\r?\n/)
        stdoutCarry = lines.pop() ?? ''
        for (const line of lines) {
          try {
            captureTurnId(turnIdFromEvent(JSON.parse(line)))
          } catch {
            // Ignore non-JSON output. It is intentionally never logged.
          }
        }
      })
      child.on('error', () => finish({ ok: false, reason: 'spawn_failed' }))
      child.on('close', (code) => {
        if (activeChild === child) activeChild = null
        if (stdoutCarry) {
          try {
            captureTurnId(turnIdFromEvent(JSON.parse(stdoutCarry)))
          } catch {
            // Ignore a non-JSON final buffer.
          }
        }
        if (receiptPersistFailed) return finish({ ok: false, reason: 'turn_receipt_persist_failed' })
        if (processFailureReason) return finish({ ok: false, reason: processFailureReason })
        if (timedOut) return finish({ ok: false, reason: 'timeout' })
        if (code !== 0) return finish({ ok: false, reason: 'codex_exit_nonzero' })
        if (!runtimeTurnId) return finish({ ok: false, reason: 'turn_id_missing' })
        finish({ ok: true, runtime_turn_id: runtimeTurnId })
      })
      child.stdin.on('error', () => terminateChild('stdin_failed'))
      try {
        child.stdin.end(promptForMessage(message))
      } catch {
        terminateChild('stdin_failed')
      }
    })
  }).catch(() => ({ ok: false, reason: 'active_guard_failed' }))
}

export async function shutdownActiveChild(config, options = {}) {
  const child = options.child ?? activeChild
  if (!child) return
  const killImpl = options.killImpl ?? process.kill
  const closed = new Promise((resolveClose) => {
    if (activeChild !== child) resolveClose(true)
    else child.once('close', () => resolveClose(true))
  })
  const signal = (name) => {
    if (activeChild !== child) return
    if (child.pid) killImpl(-child.pid, name)
    else child.kill?.(name)
  }
  try {
    signal('SIGTERM')
  } catch {
    // Escalate after the same bounded grace period.
  }
  const closedDuringGrace = await Promise.race([
    closed,
    sleep(config.shutdown_grace_ms).then(() => false),
  ])
  if (closedDuringGrace === true || activeChild !== child) return
  try {
    signal('SIGKILL')
  } catch {
    // Keep waiting with the canonical lock held; shutdown is unconfirmed.
  }
  await closed
}

export async function completeShutdown(config, startedShutdown = null, options = {}) {
  await startedShutdown
  // A signal can arrive immediately before spawn assigns activeChild. Recheck
  // after the active cycle has unwound so the canonical lock stays held.
  await shutdownActiveChild(config, options)
}

function writeAtomic(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, value, { mode })
    const file = openSync(tmp, 'r')
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(tmp, path)
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Preserve the original write error.
    }
    throw error
  }
}

function readState(config) {
  try {
    const state = JSON.parse(readFileSync(config.state_file, 'utf8'))
    if (
      state?.schema === STATE_SCHEMA &&
      typeof state.runtime_session_handle === 'string' &&
      /^[A-Za-z0-9_-]{32,128}$/.test(state.runtime_session_handle) &&
      (
        state.endpoint_id === null ||
        (
          typeof state.endpoint_id === 'string' &&
          REF_RE.test(state.endpoint_id) &&
          typeof state.endpoint_capability === 'string' &&
          /^[A-Za-z0-9_-]{40,128}$/.test(state.endpoint_capability)
        )
      )
    ) {
      return state
    }
  } catch {
    // First run creates state below.
  }
  return {
    schema: STATE_SCHEMA,
    runtime_session_handle: randomBytes(32).toString('base64url'),
    endpoint_id: null,
    endpoint_capability: null,
    last_check_in_at: null,
  }
}

function writeState(config, state) {
  writeAtomic(config.state_file, `${JSON.stringify(state, null, 2)}\n`)
}

export function readToken(config) {
  const info = statSync(config.token_file)
  if (!info.isFile()) throw new Error('token_file_invalid')
  if ((info.mode & 0o077) !== 0) throw new Error('token_file_permissions')
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('token_file_owner')
  }
  const token = readFileSync(config.token_file, 'utf8').trim()
  if (!token || /\s/.test(token)) throw new Error('token_file_invalid')
  return token
}

export async function api(config, token, path, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.http_timeout_ms)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.base_url}/api/runtime-endpoints${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: controller.signal,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok) throw new Error(`runtime_endpoint_http_${response.status}`)
    return payload
  } catch (error) {
    if (controller.signal.aborted) throw new Error('runtime_endpoint_http_timeout')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function checkIn(config, token, state, fetchImpl) {
  const payload = await api(config, token, '/check-in', {
    method: 'POST',
    fetchImpl,
    body: {
      runtime_kind: 'codex',
      runtime_session_handle: state.runtime_session_handle,
      node_id: config.node_id,
      local_source_id: config.local_source_id,
      project_id: config.project_id,
      purpose: config.purpose,
      workspace: config.workspace,
      wake_adapter: 'codex_cli',
      allowed_senders: config.allowed_senders,
      lease_seconds: config.lease_seconds,
    },
  })
  if (
    typeof payload?.endpoint?.id !== 'string' ||
    !REF_RE.test(payload.endpoint.id) ||
    typeof payload?.endpoint_capability !== 'string' ||
    !/^[A-Za-z0-9_-]{40,128}$/.test(payload.endpoint_capability)
  ) {
    throw new Error('runtime_endpoint_check_in_invalid')
  }
  const next = {
    ...state,
    endpoint_id: payload.endpoint.id,
    endpoint_capability: payload.endpoint_capability,
    last_check_in_at: new Date().toISOString(),
  }
  writeState(config, next)
  return next
}

function spoolPath(config, message) {
  const path = resolve(config.spool_dir, `${String(message.seq).padStart(12, '0')}-${message.id}.json`)
  const root = `${resolve(config.spool_dir)}${sep}`
  if (!path.startsWith(root)) throw new Error('pending_spool_path_invalid')
  return path
}

function persistMessage(config, message) {
  const path = spoolPath(config, message)
  if (!existsSync(path)) {
    writeAtomic(path, `${JSON.stringify({
      schema: 'mupot.codex-thread-pending/v1',
      persisted_at: new Date().toISOString(),
      endpoint_id: message.endpoint_id,
      message,
    }, null, 2)}\n`)
  }
  return path
}

function readPendingRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record?.schema !== 'mupot.codex-thread-pending/v1' || !record.message) return null
    return record
  } catch {
    return null
  }
}

function persistRuntimeAcceptance(path, record, runtimeTurnId) {
  writeAtomic(path, `${JSON.stringify({
    ...record,
    dispatch_state: 'accepted',
    runtime_accepted_at: new Date().toISOString(),
    runtime_turn_id: runtimeTurnId,
  }, null, 2)}\n`)
}

function persistDispatching(path, record, deliveryId) {
  writeAtomic(path, `${JSON.stringify({
    ...record,
    dispatch_state: 'dispatching',
    dispatching_at: new Date().toISOString(),
    delivery_id: deliveryId,
  }, null, 2)}\n`)
}

function resetPending(path, record) {
  const {
    dispatch_state: _dispatchState,
    dispatching_at: _dispatchingAt,
    delivery_id: _deliveryId,
    runtime_accepted_at: _runtimeAcceptedAt,
    runtime_turn_id: _runtimeTurnId,
    ...pending
  } = record
  writeAtomic(path, `${JSON.stringify(pending, null, 2)}\n`)
}

function acceptedReceipt(payload, message, endpointId, runtimeTurnId) {
  const receipt = payload?.receipt
  if (
    payload?.schema !== 'mupot.runtime-endpoint-ack/v1' ||
    !receipt ||
    receipt.endpoint_id !== endpointId ||
    receipt.message_id !== message.id ||
    (receipt.request_id ?? null) !== (message.request_id ?? null) ||
    receipt.runtime_turn_id !== runtimeTurnId ||
    typeof receipt.accepted_at !== 'string'
  ) {
    throw new Error('runtime_endpoint_accept_invalid_receipt')
  }
  return {
    schema: payload.schema,
    endpoint_id: receipt.endpoint_id,
    message_id: receipt.message_id,
    request_id: receipt.request_id ?? null,
    runtime_turn_id: receipt.runtime_turn_id,
    accepted_at: receipt.accepted_at,
    duplicate: receipt.duplicate === true,
  }
}

async function acceptPending(config, token, state, message, runtimeTurnId, options = {}) {
  const payload = await api(config, token, '/accept', {
    method: 'POST',
    fetchImpl: options.fetchImpl,
    body: {
      endpoint_id: state.endpoint_id,
      endpoint_capability: state.endpoint_capability,
      message_id: message.id,
      runtime_turn_id: runtimeTurnId,
    },
  })
  return acceptedReceipt(payload, message, state.endpoint_id, runtimeTurnId)
}

function finalizeMessage(config, message, serverReceipt, path) {
  const receiptPath = join(config.spool_dir, 'receipts', `${message.id}.json`)
  writeAtomic(receiptPath, `${JSON.stringify({
    schema: RECEIPT_SCHEMA,
    saved_at: new Date().toISOString(),
    server_receipt: serverReceipt,
  }, null, 2)}\n`)
  try {
    unlinkSync(path)
  } catch {
    // A missing spool after durable server acceptance is harmless.
  }
}

async function reconcileAcceptedSpools(config, token, state, options = {}) {
  mkdirSync(config.spool_dir, { recursive: true, mode: 0o700 })
  const names = readdirSync(config.spool_dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  for (const name of names) {
    const path = join(config.spool_dir, name)
    const record = readPendingRecord(path)
    if (!record || typeof record.runtime_turn_id !== 'string' || !TURN_ID_RE.test(record.runtime_turn_id)) continue
    if (record.message.endpoint_id !== state.endpoint_id) {
      log(config, 'pending_endpoint_mismatch', { message_id: record.message?.id ?? null })
      continue
    }
    const receipt = await acceptPending(
      config,
      token,
      state,
      record.message,
      record.runtime_turn_id,
      options,
    )
    finalizeMessage(config, record.message, receipt, path)
    log(config, 'message_reconciled', {
      endpoint_id: state.endpoint_id,
      message_id: record.message.id,
      runtime_turn_id: record.runtime_turn_id,
    })
  }
}

function log(config, event, detail = {}) {
  const path = join(dirname(config.state_file), 'codex-thread-endpoint.log')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}\n`, { mode: 0o600 })
}

function bestEffortLog(config, event, detail = {}) {
  try {
    log(config, event, detail)
  } catch {
    // Fatal state must not depend on observability storage being writable.
  }
}

function bridgeFaultPath(config) {
  return `${config.state_file}.fault.json`
}

function latchBridgeFault(config, reason, detail = {}) {
  const path = bridgeFaultPath(config)
  let faultPersisted = existsSync(path)
  if (!faultPersisted) {
    try {
      writeAtomic(path, `${JSON.stringify({
        schema: 'mupot.codex-thread-bridge-fault/v1',
        faulted_at: new Date().toISOString(),
        reason,
        local_source_id: config.local_source_id,
        ...detail,
      }, null, 2)}\n`)
      faultPersisted = true
    } catch {
      faultPersisted = false
    }
  }
  bestEffortLog(config, 'bridge_faulted', { reason, fault_persisted: faultPersisted, ...detail })
  throw new Error(`fatal_bridge_fault:${reason}`)
}

export async function cycle(config, token, state, options = {}) {
  const last = Date.parse(state.last_check_in_at ?? '')
  if (!state.endpoint_id || !Number.isFinite(last) || Date.now() - last >= config.lease_seconds * 1000 / 3) {
    state = await checkIn(config, token, state, options.fetchImpl)
    log(config, 'endpoint_checked_in', { endpoint_id: state.endpoint_id })
  }
  await reconcileAcceptedSpools(config, token, state, options)
  const inbox = await api(config, token, '/inbox', {
    method: 'POST',
    fetchImpl: options.fetchImpl,
    body: {
      endpoint_id: state.endpoint_id,
      endpoint_capability: state.endpoint_capability,
      limit: 20,
    },
  })
  for (const message of inbox?.messages ?? []) {
    const denied = authorizeMessage(config, message, state.endpoint_id)
    if (denied) {
      log(config, 'message_refused', { message_id: message?.id ?? null, reason: denied })
      continue
    }
    const path = persistMessage(config, message)
    const pending = readPendingRecord(path)
    if (!pending) {
      log(config, 'message_deferred', { message_id: message.id, reason: 'pending_spool_invalid' })
      continue
    }
    if (pending.dispatch_state === 'dispatching' && !pending.runtime_turn_id) {
      latchBridgeFault(config, 'delivery_uncertain', {
        message_id: message.id,
        delivery_id: pending.delivery_id ?? null,
      })
    }
    const deliveryId = pending.delivery_id ?? randomBytes(18).toString('base64url')
    const persistedMessage = pending.message
    const delivery = await runCodexTurn(
      config,
      { ...persistedMessage, delivery_id: deliveryId },
      {
        ...options,
        onDispatching: () => persistDispatching(path, pending, deliveryId),
        onTurnStarted: (runtimeTurnId) => {
          const dispatched = readPendingRecord(path)
          if (!dispatched) throw new Error('pending_spool_invalid')
          persistRuntimeAcceptance(path, dispatched, runtimeTurnId)
        },
      },
    )
    if (!delivery.ok) {
      if (delivery.fatal === true) {
        latchBridgeFault(config, delivery.reason, {
          message_id: message.id,
          delivery_id: deliveryId,
        })
      }
      if (delivery.reason === 'spawn_failed') {
        const dispatched = readPendingRecord(path)
        if (dispatched) resetPending(path, dispatched)
      }
      log(config, 'message_deferred', { message_id: message.id, reason: delivery.reason })
      break
    }
    const acceptedRecord = readPendingRecord(path)
    if (!acceptedRecord?.runtime_turn_id) {
      log(config, 'message_deferred', { message_id: message.id, reason: 'turn_receipt_not_persisted' })
      break
    }
    const receipt = await acceptPending(
      config,
      token,
      state,
      persistedMessage,
      acceptedRecord.runtime_turn_id,
      options,
    )
    finalizeMessage(config, persistedMessage, receipt, path)
    log(config, 'message_accepted', {
      endpoint_id: state.endpoint_id,
      message_id: message.id,
      runtime_turn_id: delivery.runtime_turn_id,
    })
  }
  return state
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function main() {
  const configPath = process.argv[2] ?? join(homedir(), '.fleet', 'codex-thread-endpoint.json')
  const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  const lock = await acquireSingletonLock({ path: threadLockPath(config) })
  if (!lock.ok) {
    process.stderr.write(`codex-thread-endpoint: ${lock.reason}\n`)
    process.exit(2)
  }
  let shutdownPromise = null
  let stopped = false
  let faulted = existsSync(bridgeFaultPath(config))
  const stop = () => {
    stopped = true
    shutdownPromise ??= shutdownActiveChild(config)
  }
  try {
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    const token = faulted ? null : readToken(config)
    let state = faulted ? null : readState(config)
    if (state) writeState(config, state)
    while (!stopped) {
      if (faulted) {
        await sleep(1000)
        continue
      }
      try {
        state = await cycle(config, token, state)
      } catch (error) {
        const reason = String(error?.message ?? error)
        bestEffortLog(config, 'cycle_failed', { reason })
        if (reason.startsWith('fatal_bridge_fault:')) {
          faulted = true
          continue
        }
      }
      if (!stopped) await sleep(config.poll_ms)
    }
  } finally {
    await completeShutdown(config, shutdownPromise)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    lock.release()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

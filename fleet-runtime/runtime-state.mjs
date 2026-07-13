import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SECRET_VALUE_PATTERNS } from './service-context.mjs'

const SECRET_FIELD_RE = /(?:^|_)(?:authorization|bearer|token|access_token|refresh_token|secret|password|passwd|api_key|private_key|client_secret|cookie|signature|sig|nonce)(?:$|_)/i

function normalizedFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

function assertSecretFree(value) {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some(([, pattern]) => pattern.test(value))) {
      throw new Error('runtime state contains prohibited secret-like material')
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach(assertSecretFree)
    return
  }
  if (!value || typeof value !== 'object') return

  if (typeof value.kty === 'string' && typeof value.d === 'string') {
    throw new Error('runtime state contains prohibited secret-like material')
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(normalizedFieldName(key))) {
      throw new Error('runtime state contains prohibited secret-like material')
    }
    assertSecretFree(item)
  }
}

function defaultTempName(target) {
  return `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`
}

function consumeState(inbox) {
  if (inbox?.action === 'inbox_consumed') return 'consumed'
  if (inbox?.action === 'inbox_not_configured' || inbox === null) return 'not_configured'
  if (typeof inbox?.action === 'string') return inbox.action
  return 'not_attempted'
}

export function writeRuntimeState(path, value, deps = {}) {
  assertSecretFree(value)
  const fs = {
    closeSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    ...(deps.fs ?? deps),
  }
  const parent = dirname(path)
  let parentStats
  try {
    parentStats = fs.statSync(parent)
  } catch {
    throw new Error(`runtime state parent directory does not exist: ${parent}`)
  }
  if (!parentStats.isDirectory()) throw new Error(`runtime state parent is not a directory: ${parent}`)

  const tempName = (deps.tempName ?? defaultTempName)(path)
  if (typeof tempName !== 'string' || !tempName || basename(tempName) !== tempName) {
    throw new Error('runtime state temporary name must be a filename')
  }
  const tempPath = join(parent, tempName)
  const json = `${JSON.stringify(value)}\n`
  let fd = null
  let closed = false
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    closed = true
    fs.renameSync(tempPath, path)
  } catch (error) {
    if (fd !== null && !closed) {
      try { fs.closeSync(fd) } catch { /* preserve the original error */ }
    }
    try { fs.unlinkSync(tempPath) } catch { /* temp file was not created or already removed */ }
    throw error
  }
}

export function readRuntimeState(path, deps = {}) {
  const fs = { readFileSync, ...(deps.fs ?? deps) }
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

export function heartbeatState({ pid, startedAt, tick, lastTickAt, intervalSec, results }) {
  return {
    schema: 'mupot-fleet-daemon-state/v1',
    pid,
    started_at: startedAt,
    tick,
    last_tick_at: lastTickAt,
    interval_sec: intervalSec,
    agents: (Array.isArray(results) ? results : []).map((result) => ({
      agent_id: result.agent,
      probe: result.probe,
      heartbeat_status: Number.isInteger(result.heartbeat?.status) ? result.heartbeat.status : null,
      inbox_count: Number.isInteger(result.inbox?.messages) ? result.inbox.messages : 0,
      consume: consumeState(result.inbox),
    })),
  }
}

export function controlState({ pid, startedAt, poll, lastPollAt, pollSec, outcome }) {
  return {
    schema: 'mupot-fleet-control-state/v1',
    pid,
    started_at: startedAt,
    poll,
    last_poll_at: lastPollAt,
    poll_sec: pollSec,
    last_outcome: {
      agent_id: outcome?.request?.agent_id ?? null,
      verb: outcome?.request?.verb ?? null,
      accepted: outcome?.ok === true,
      result: outcome?.action ?? 'unknown',
    },
  }
}

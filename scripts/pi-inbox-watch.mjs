#!/usr/bin/env node
// Pi Mupot inbox watcher — bearer-fenced, durable, no SOS or tmux path.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertCanonicalRuntimeIdentity, bearerConsumerAllowed, verifyConsumedBatch } from '../fleet-runtime/claude-code-inbox-adapter.mjs'
import { runPiRpc, validatePiMessage } from '../fleet-runtime/pi-rpc-inbox-adapter.mjs'
import { acquireSingletonLock } from '../fleet-runtime/singleton-lock.mjs'

const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const DEFAULT_CONFIG = join(homedir(), '.fleet', 'pi-inbox.json')
const ONCE = process.argv.includes('--once')
const CONFIG_ARG = process.argv.slice(2).find((arg) => arg !== '--once')
const TERMINAL = new Set(['expected_agent_required', 'token_not_agent_bound', 'wrong_bound_agent', 'fence_mode_missing', 'invalid_fence_mode', 'consumer_fenced'])

function log(event, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), component: 'pi-inbox-watch', event, ...extra }))
}

function expandHome(value) {
  return typeof value === 'string' && value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}
function absPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} required`)
  return resolve(expandHome(value))
}
function refs(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || value.some((v) => typeof v !== 'string' || !REF_RE.test(v))) {
    throw new TypeError(`${name} invalid`)
  }
  return new Set(value)
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('config must be object')
  if (typeof raw.mcp_url !== 'string' || !raw.mcp_url.startsWith('https://')) throw new TypeError('mcp_url must be https')
  if (typeof raw.expected_agent_id !== 'string' || !REF_RE.test(raw.expected_agent_id)) throw new TypeError('expected_agent_id invalid')
  if (typeof raw.agent_slug !== 'string' || !REF_RE.test(raw.agent_slug)) throw new TypeError('agent_slug invalid')
  if (typeof raw.project_id !== 'string' || !REF_RE.test(raw.project_id)) throw new TypeError('project_id invalid')
  const intervalSec = Math.min(120, Math.max(15, Number(raw.interval_sec ?? 30) || 30))
  return {
    mcp_url: raw.mcp_url,
    token_file: absPath(raw.token_file, 'token_file'),
    expected_agent_id: raw.expected_agent_id,
    agent_slug: raw.agent_slug,
    project_id: raw.project_id,
    allowed_senders: refs(raw.allowed_senders, 'allowed_senders'),
    allowed_project_ids: refs(raw.allowed_project_ids, 'allowed_project_ids'),
    spool_dir: absPath(raw.spool_dir ?? '~/.fleet/inbox/pi', 'spool_dir'),
    lock_file: absPath(raw.lock_file ?? '~/.fleet/locks/pi-inbox.lock', 'lock_file'),
    interval_sec: intervalSec,
    pi: raw.pi,
  }
}

function readToken(path) {
  const st = statSync(path)
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('token_file_permissions_invalid')
  const token = readFileSync(path, 'utf8').trim()
  if (token.length < 16 || token.length > 4096) throw new Error('token_missing_or_invalid')
  return token
}

export async function mcpCall(config, token, name, args) {
  const res = await fetch(config.mcp_url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'mupot-pi-inbox/0.1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`mcp http ${res.status}`)
  const payload = await res.json()
  if (payload.error) throw new Error(`mcp error ${payload.error.code ?? 'unknown'}`)
  if (payload.result?.structuredContent !== undefined) return payload.result.structuredContent
  const text = payload.result?.content?.[0]?.text
  const inner = typeof text === 'string' ? JSON.parse(text) : null
  if (!inner || inner.ok === false) throw new Error(`mcp tool ${name} failed: ${inner?.error ?? inner?.reason ?? 'invalid_response'}`)
  return inner.result ?? inner
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
}
function recordPath(config, message) {
  return join(config.spool_dir, `${String(message.seq).padStart(12, '0')}-${safePart(message.id)}.json`)
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
function bodyHash(message) {
  return createHash('sha256').update(message.body).digest('hex')
}
function loadRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
function spool(config, message, now = () => new Date().toISOString()) {
  mkdirSync(config.spool_dir, { recursive: true, mode: 0o700 })
  const path = recordPath(config, message)
  const prior = loadRecord(path)
  if (prior) {
    if (prior.message?.id !== message.id || prior.body_sha256 !== bodyHash(message)) throw new Error('spool_identity_collision')
    return { path, record: prior, created: false }
  }
  const record = { schema: 'mupot.pi-inbox-spool/v1', received_at: now(), status: 'spooled', body_sha256: bodyHash(message), message }
  writeAtomic(path, record)
  return { path, record, created: true }
}
function updateRecord(path, record, patch) {
  const next = { ...record, ...patch, updated_at: new Date().toISOString() }
  writeAtomic(path, next)
  return next
}

function validateInboxEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('message must be object')
  if (!Number.isInteger(Number(raw.seq)) || Number(raw.seq) < 0) throw new TypeError('message.seq invalid')
  if (typeof raw.id !== 'string' || !REF_RE.test(raw.id)) throw new TypeError('message.id invalid')
  if (typeof raw.from_agent !== 'string' || !REF_RE.test(raw.from_agent)) throw new TypeError('message.from_agent invalid')
  if (!['message', 'request', 'ack'].includes(raw.kind)) throw new TypeError('message.kind invalid')
  if (typeof raw.body !== 'string' || raw.body.length > 8000) throw new TypeError('message.body invalid')
  for (const field of ['request_id', 'in_reply_to', 'project_id']) {
    if (raw[field] != null && !REF_RE.test(String(raw[field]))) throw new TypeError(`message.${field} invalid`)
  }
  return raw
}

export function authorizeMessage(config, raw) {
  if (raw?.kind === 'ack') return { ok: false, consume: true, reason: 'ack_observed' }
  let message
  try { message = validatePiMessage(raw) } catch (error) { return { ok: false, consume: true, reason: String(error.message ?? error) } }
  if (message.from_agent === config.expected_agent_id || message.from_agent === config.agent_slug) return { ok: false, consume: true, reason: 'self_sender_denied' }
  if (!config.allowed_senders.has(message.from_agent)) return { ok: false, consume: true, reason: 'unauthorized_sender' }
  if (!message.project_id || !config.allowed_project_ids.has(message.project_id)) return { ok: false, consume: true, reason: 'project_denied' }
  return { ok: true, message }
}

async function consumeExact(mcp, token, expected) {
  const consumed = await mcp(token, 'inbox', { limit: 1, peek: false })
  const messages = Array.isArray(consumed.messages) ? consumed.messages : []
  return { consumed, verified: verifyConsumedBatch({ expected: [expected], consumed: messages }) }
}

async function sendAck(mcp, token, message, body) {
  if (message.kind !== 'request' || !message.request_id) return null
  return await mcp(token, 'send', {
    to: message.from_agent,
    body: body.slice(0, 4000),
    kind: 'ack',
    request_id: `pi-ack:${message.id}`.slice(0, 128),
    in_reply_to: message.request_id,
    project_id: message.project_id,
  })
}

export async function retryPendingAcks(config, token, mcp) {
  mkdirSync(config.spool_dir, { recursive: true, mode: 0o700 })
  let sent = 0
  for (const file of readdirSync(config.spool_dir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(config.spool_dir, file)
    const record = loadRecord(path)
    if (record?.status !== 'consumed_pending_ack' || !record.pending_ack) continue
    await sendAck(mcp, token, record.message, record.pending_ack)
    updateRecord(path, record, { status: 'acked', acked_at: new Date().toISOString(), pending_ack: null })
    sent += 1
  }
  return sent
}

export async function runCycle(config, options = {}) {
  const token = options.token ?? readToken(config.token_file)
  const mcp = options.mcp ?? ((t, n, a) => mcpCall(config, t, n, a))
  const runPi = options.runPi ?? ((message) => runPiRpc(message, config.pi))

  const boot = await mcp(token, 'boot_context', {})
  const identity = assertCanonicalRuntimeIdentity(boot, config.expected_agent_id)
  if (!identity.ok) return { ok: false, reason: identity.reason, consumed: 0 }
  const fence = await mcp(token, 'inbox_consumer_status', {})
  const allowed = bearerConsumerAllowed(fence)
  if (!allowed.ok) return { ok: false, reason: allowed.reason, consumed: 0 }

  const retried_acks = await retryPendingAcks(config, token, mcp)
  const peeked = await mcp(token, 'inbox', { limit: 1, peek: true })
  const message = Array.isArray(peeked.messages) ? peeked.messages[0] : null
  if (!message) return { ok: true, reason: 'inbox_empty', consumed: 0, retried_acks }
  try { validateInboxEnvelope(message) } catch (error) {
    return { ok: false, reason: String(error.message ?? error), consumed: 0 }
  }

  const persisted = spool(config, message, options.now)
  let record = persisted.record
  const auth = authorizeMessage(config, message)
  if (!auth.ok) {
    record = updateRecord(persisted.path, record, { status: 'rejected', rejection_reason: auth.reason })
    const { verified } = await consumeExact(mcp, token, message)
    if (!verified.ok) return { ok: false, reason: verified.reason, consumed: 1 }
    record = updateRecord(persisted.path, record, { status: 'consumed', consumed_at: new Date().toISOString() })
    if (message.kind === 'request' && message.request_id) {
      const rejection = `Pi runtime rejected this request: ${auth.reason}.`
      try {
        await sendAck(mcp, token, message, rejection)
        updateRecord(persisted.path, record, { status: 'acked', acked_at: new Date().toISOString() })
      } catch {
        updateRecord(persisted.path, record, { status: 'consumed_pending_ack', pending_ack: rejection })
      }
    }
    return { ok: true, reason: auth.reason, consumed: 1, activated: 0 }
  }

  if (record.status === 'activating' || record.status === 'activation_failed') {
    return { ok: false, reason: 'activation_outcome_uncertain', consumed: 0 }
  }
  if (['consumed', 'consumed_pending_ack', 'acked'].includes(record.status)) {
    return { ok: false, reason: 'consumed_message_reappeared', consumed: 0 }
  }
  let response = record.response
  if (record.status !== 'settled') {
    await mcp(token, 'presence_register', { adapter: 'pi-rpc', project_id: config.project_id, kind: 'agent_system', capabilities: ['communicate'] })
    record = updateRecord(persisted.path, record, { status: 'activating', activation_started_at: new Date().toISOString() })
    let result
    try { result = await runPi(auth.message) } finally {
      try { await mcp(token, 'presence_deregister', { project_id: config.project_id }) } catch { /* observability cleanup retried next run */ }
    }
    if (!result?.ok || !result.accepted || !result.settled) {
      updateRecord(persisted.path, record, { status: 'activation_failed', activation_reason: result?.reason ?? 'invalid_result' })
      return { ok: false, reason: result?.reason ?? 'activation_failed', consumed: 0 }
    }
    response = result.response
    record = updateRecord(persisted.path, record, { status: 'settled', settled_at: new Date().toISOString(), response })
  }

  const { verified } = await consumeExact(mcp, token, message)
  if (!verified.ok) return { ok: false, reason: verified.reason, consumed: 1 }
  record = updateRecord(persisted.path, record, { status: 'consumed', consumed_at: new Date().toISOString() })
  if (message.kind === 'request') {
    try {
      await sendAck(mcp, token, message, response)
      updateRecord(persisted.path, record, { status: 'acked', acked_at: new Date().toISOString() })
    } catch {
      updateRecord(persisted.path, record, { status: 'consumed_pending_ack', pending_ack: response })
      return { ok: false, reason: 'ack_pending', consumed: 1, activated: 1 }
    }
  }
  return { ok: true, reason: 'settled_consumed_acked', consumed: 1, activated: 1 }
}

function terminalError(message) {
  return /\bmcp http (401|403)\b/.test(message) || [...TERMINAL].some((reason) => message.includes(reason))
}

export async function main(options = {}) {
  const config = options.config ?? validateConfig(JSON.parse(readFileSync(CONFIG_ARG || DEFAULT_CONFIG, 'utf8')))
  const token = options.token ?? readToken(config.token_file)
  const mcp = options.mcp ?? ((t, n, a) => mcpCall(config, t, n, a))
  const boot = await mcp(token, 'boot_context', {})
  const identity = assertCanonicalRuntimeIdentity(boot, config.expected_agent_id)
  if (!identity.ok) throw new Error(identity.reason)
  const fence = bearerConsumerAllowed(await mcp(token, 'inbox_consumer_status', {}))
  if (!fence.ok) throw new Error(fence.reason)

  const lock = await (options.acquireLock ?? acquireSingletonLock)({ path: config.lock_file })
  if (!lock.ok) return lock.reason === 'already_running' ? 0 : 1
  let released = false
  const release = () => { if (!released) { released = true; lock.release() } }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { release(); process.exit(0) })
  log('start', { agent_id: config.expected_agent_id, interval_sec: config.interval_sec, once: ONCE })
  try {
    for (;;) {
      try {
        const result = await (options.runCycle ?? runCycle)(config, { token, mcp })
        log('cycle', result)
        if (ONCE || TERMINAL.has(result.reason)) return result.ok ? 0 : 1
      } catch (error) {
        const message = String(error?.message ?? error)
        log('cycle_error', { error: message, terminal: terminalError(message) })
        if (ONCE || terminalError(message)) return 1
      }
      await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(config.interval_sec * 1000)
    }
  } finally { release() }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exit(await main())

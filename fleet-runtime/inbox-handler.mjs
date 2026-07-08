#!/usr/bin/env node
// Mupot inbox handler - durable local handoff for fleet-daemon inbox batches.
//
// fleet-daemon peeks a signed Mupot inbox batch and sends this handler one JSON
// payload on stdin. This handler validates it, writes each message to a 0600
// spool file, then optionally runs a per-agent command. Exit 0 means "accepted";
// the daemon consumes from Mupot only after that.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const KINDS = new Set(['message', 'request', 'ack'])
const DEFAULT_TIMEOUT_MS = 120_000

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }))
}

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function normalizePath(v, fallback) {
  const path = typeof v === 'string' && v.trim() ? v : fallback
  if (!path) throw new Error('path required')
  return resolve(expandHome(path))
}

function clampTimeout(v) {
  let n = Number.isInteger(v) ? v : DEFAULT_TIMEOUT_MS
  if (n < 1_000) n = 1_000
  if (n > 600_000) n = 600_000
  return n
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object')
  const spoolDir = normalizePath(raw.spool_dir, '~/.fleet/inbox')
  const commandTimeoutMs = clampTimeout(raw.command_timeout_ms)
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error('config.agents must be a non-empty array')
  }
  const agents = new Map()
  for (const [i, a] of raw.agents.entries()) {
    if (!a || typeof a !== 'object') throw new Error(`agents[${i}] must be an object`)
    if (typeof a.agent_id !== 'string' || !AGENT_ID_RE.test(a.agent_id)) {
      throw new Error(`agents[${i}].agent_id invalid`)
    }
    if (agents.has(a.agent_id)) throw new Error(`duplicate agent_id '${a.agent_id}'`)
    let command = ''
    if (a.command !== undefined) {
      if (typeof a.command !== 'string' || !a.command.trim()) throw new Error(`agents[${i}].command must be non-empty when set`)
      command = a.command
    }
    let runFor = command ? ['request'] : []
    if (Array.isArray(a.run_for)) {
      runFor = []
      for (const [j, k] of a.run_for.entries()) {
        if (typeof k !== 'string' || !KINDS.has(k)) {
          throw new Error(`agents[${i}].run_for[${j}] invalid`)
        }
        runFor.push(k)
      }
    }
    agents.set(a.agent_id, {
      agent_id: a.agent_id,
      spoolDir: normalizePath(a.spool_dir, join(spoolDir, a.agent_id)),
      command,
      runFor: new Set(runFor),
      commandTimeoutMs: clampTimeout(a.command_timeout_ms ?? commandTimeoutMs),
    })
  }
  return { spoolDir, commandTimeoutMs, agents }
}

export function validatePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload must be a JSON object')
  if (typeof raw.tenant !== 'string' || !raw.tenant) throw new Error('payload.tenant required')
  if (typeof raw.base_url !== 'string' || !/^https?:\/\//.test(raw.base_url)) throw new Error('payload.base_url must be http(s)')
  if (typeof raw.agent_id !== 'string' || !AGENT_ID_RE.test(raw.agent_id)) throw new Error('payload.agent_id invalid')
  if (!Array.isArray(raw.messages)) throw new Error('payload.messages must be an array')
  if (raw.messages.length > 100) throw new Error('payload.messages too large')
  const messages = raw.messages.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`messages[${i}] must be an object`)
    const seq = Number(m.seq)
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`messages[${i}].seq invalid`)
    if (typeof m.id !== 'string' || !m.id || m.id.length > 128) throw new Error(`messages[${i}].id invalid`)
    if (typeof m.from_agent !== 'string' || !m.from_agent || m.from_agent.length > 128) throw new Error(`messages[${i}].from_agent invalid`)
    if (typeof m.kind !== 'string' || !KINDS.has(m.kind)) throw new Error(`messages[${i}].kind invalid`)
    if (typeof m.body !== 'string' || m.body.length > 8000) throw new Error(`messages[${i}].body invalid`)
    const requestId = m.request_id == null ? null : String(m.request_id)
    if (requestId != null && !REF_RE.test(requestId)) throw new Error(`messages[${i}].request_id invalid`)
    const inReplyTo = m.in_reply_to == null ? null : String(m.in_reply_to)
    if (inReplyTo != null && !REF_RE.test(inReplyTo)) throw new Error(`messages[${i}].in_reply_to invalid`)
    return {
      seq,
      id: m.id,
      from_agent: m.from_agent,
      from_member: m.from_member == null ? null : String(m.from_member),
      kind: m.kind,
      body: m.body,
      request_id: requestId,
      in_reply_to: inReplyTo,
      created_at: typeof m.created_at === 'string' ? m.created_at : '',
    }
  })
  return {
    tenant: raw.tenant,
    base_url: raw.base_url,
    agent_id: raw.agent_id,
    messages,
    remaining: Number.isFinite(raw.remaining) ? Number(raw.remaining) : 0,
  }
}

function safeFilePart(s) {
  const clean = String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
  return clean || createHash('sha256').update(String(s)).digest('hex').slice(0, 24)
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

export function writeSpoolFiles(agentCfg, payload, now = () => new Date().toISOString()) {
  mkdirSync(agentCfg.spoolDir, { recursive: true, mode: 0o700 })
  return payload.messages.map((message) => {
    const name = `${String(message.seq).padStart(12, '0')}-${safeFilePart(message.id)}.json`
    const path = join(agentCfg.spoolDir, name)
    const record = {
      received_at: now(),
      tenant: payload.tenant,
      base_url: payload.base_url,
      agent_id: payload.agent_id,
      message,
    }
    writeAtomic(path, JSON.stringify(record, null, 2) + '\n')
    return path
  })
}

export function runCommand(cmd, stdinPayload, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn) {
  return new Promise((resolveDone) => {
    let done = false
    const finish = (ok, code = null) => { if (!done) { done = true; resolveDone({ ok, code }) } }
    let child
    try {
      child = spawnImpl('sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
    } catch {
      return finish(false, null)
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      finish(false, null)
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); finish(false, null) })
    child.on('exit', (code) => { clearTimeout(timer); finish(code === 0, code) })
    try {
      child.stdin.end(stdinPayload)
    } catch {
      clearTimeout(timer)
      finish(false, null)
    }
  })
}

export async function handleBatch(config, payload, opts = {}) {
  const agentCfg = config.agents.get(payload.agent_id)
  if (!agentCfg) throw new Error(`agent '${payload.agent_id}' is not configured`)
  const files = writeSpoolFiles(agentCfg, payload, opts.now)
  const shouldRun = !!agentCfg.command && payload.messages.some((m) => agentCfg.runFor.has(m.kind))
  if (!shouldRun) return { ok: true, files, command: 'skipped' }

  const commandPayload = JSON.stringify({
    tenant: payload.tenant,
    base_url: payload.base_url,
    agent_id: payload.agent_id,
    spool_dir: agentCfg.spoolDir,
    files,
    messages: payload.messages,
    remaining: payload.remaining,
  }) + '\n'
  const res = await (opts.runCommand ?? runCommand)(agentCfg.command, commandPayload, agentCfg.commandTimeoutMs)
  return { ok: res.ok, files, command: agentCfg.command, code: res.code }
}

function readStdin() {
  return new Promise((resolveRead, rejectRead) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { s += d })
    process.stdin.on('error', rejectRead)
    process.stdin.on('end', () => resolveRead(s))
  })
}

async function main() {
  const cfgPath = process.argv[2] || join(homedir(), '.fleet', 'inbox-handler.json')
  let config
  let payload
  try {
    config = validateConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
    payload = validatePayload(JSON.parse(await readStdin()))
    const res = await handleBatch(config, payload)
    log({ event: res.ok ? 'inbox_batch_accepted' : 'inbox_batch_rejected', agent: payload.agent_id, files: res.files.length, command: res.command, code: res.code })
    process.exit(res.ok ? 0 : 1)
  } catch (e) {
    log({ event: 'inbox_handler_error', error: String(e && e.message ? e.message : e) })
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

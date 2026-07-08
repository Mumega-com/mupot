#!/usr/bin/env node
// Fleet control daemon — consumes signed control-requests from Mupot and runs flights.
//
// Worker/dashboard side:
//   owner action → POST /api/fleet/control → signed fleet-control.v1 request
//   → message to FLEET_CONSUMER_AGENT inbox.
//
// Host side:
//   this daemon signs /api/inbox/signed as the consumer agent, verifies the panel
//   signature with a PUBLIC key, burns nonce locally, then runs flight.mjs.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadPrivKey, signedInbox } from './fleet-sign.mjs'
import { importPanelPublicKey, JsonNonceLedger, verifyControlRequest } from './control-request.mjs'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_TIMEOUT_MS = 120_000
const HERE = dirname(fileURLToPath(import.meta.url))

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }))
}

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function requirePath(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty path`)
  return resolve(expandHome(v))
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object')
  if (typeof raw.base_url !== 'string' || !/^https?:\/\//.test(raw.base_url)) {
    throw new Error('config.base_url must be an http(s) URL')
  }
  if (typeof raw.tenant !== 'string' || !raw.tenant) {
    throw new Error('config.tenant is required (this runtime hardcodes no tenant)')
  }
  const consumerAgent = raw.consumer_agent_id
  if (typeof consumerAgent !== 'string' || !AGENT_ID_RE.test(consumerAgent)) {
    throw new Error('config.consumer_agent_id must be an agent slug')
  }
  let pollSec = Number.isFinite(raw.poll_sec) && raw.poll_sec >= 2 ? raw.poll_sec : 5
  if (pollSec > 120) pollSec = 120
  let commandTimeoutMs = Number.isInteger(raw.command_timeout_ms) ? raw.command_timeout_ms : DEFAULT_TIMEOUT_MS
  if (commandTimeoutMs < 1_000) commandTimeoutMs = 1_000
  if (commandTimeoutMs > 600_000) commandTimeoutMs = 600_000
  return {
    baseUrl: raw.base_url,
    tenant: raw.tenant,
    consumerAgent,
    panelPublicKeyPath: requirePath(raw.panel_public_key, 'config.panel_public_key'),
    flightsConfigPath: requirePath(raw.flights_config, 'config.flights_config'),
    nonceLedgerPath: resolve(expandHome(typeof raw.nonce_ledger === 'string' ? raw.nonce_ledger : '~/.fleet/control-nonces.json')),
    pollSec,
    commandTimeoutMs,
    flightScript: resolve(expandHome(typeof raw.flight_script === 'string' ? raw.flight_script : join(HERE, 'flight.mjs'))),
  }
}

export function runCommand(argv, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn) {
  return new Promise((resolveDone) => {
    let done = false
    const finish = (ok, code = null) => { if (!done) { done = true; resolveDone({ ok, code }) } }
    let child
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: 'ignore', detached: true })
    } catch {
      return finish(false, null)
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      finish(false, null)
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); finish(false, null) })
    child.on('exit', (code) => { clearTimeout(timer); finish(code === 0, code) })
  })
}

export async function runFlightVerb(cfg, request, runImpl = runCommand) {
  const base = [process.execPath, cfg.flightScript]
  if (request.verb === 'status') {
    return { ok: true, action: 'status_noop' }
  }
  if (request.verb === 'start') {
    const res = await runImpl([...base, 'open', request.agent_id, cfg.flightsConfigPath], cfg.commandTimeoutMs)
    return { ok: res.ok, action: 'open', code: res.code }
  }
  if (request.verb === 'stop') {
    const res = await runImpl([...base, 'close', request.agent_id, cfg.flightsConfigPath], cfg.commandTimeoutMs)
    return { ok: res.ok, action: 'close', code: res.code }
  }
  if (request.verb === 'restart') {
    const close = await runImpl([...base, 'close', request.agent_id, cfg.flightsConfigPath], cfg.commandTimeoutMs)
    if (!close.ok) return { ok: false, action: 'restart_close', code: close.code }
    const open = await runImpl([...base, 'open', request.agent_id, cfg.flightsConfigPath], cfg.commandTimeoutMs)
    return { ok: open.ok, action: 'restart_open', code: open.code }
  }
  return { ok: false, action: 'bad_verb', code: null }
}

export async function handleControlMessage(message, cfg, publicKey, ledger, runImpl = runFlightVerb) {
  let req
  try {
    req = JSON.parse(String(message.body ?? ''))
  } catch {
    return { consume: true, ok: false, reason: 'invalid_json' }
  }
  const verified = await verifyControlRequest(publicKey, req, ledger)
  if (!verified.ok) {
    return { consume: true, ok: false, reason: verified.reason }
  }

  const ran = await runImpl(cfg, verified.request)
  if (!ran.ok) {
    return { consume: true, ok: false, reason: 'flight_command_failed', request: verified.request, action: ran.action, code: ran.code }
  }
  return { consume: true, ok: true, request: verified.request, action: ran.action }
}

export async function pollOnce(cfg, consumerKey, publicKey, ledger, opts = {}) {
  const inboxFn = opts.signedInbox ?? signedInbox
  const runImpl = opts.runFlightVerb ?? runFlightVerb
  const logFn = opts.log ?? log
  const peek = await inboxFn(cfg.baseUrl, cfg.consumerAgent, {
    tenant: cfg.tenant,
    privKey: consumerKey,
    peek: true,
    limit: 1,
  })
  if (!peek.ok) {
    logFn({ event: 'control_inbox_peek_fail', status: peek.status })
    return { ok: false, action: 'peek_failed', status: peek.status }
  }
  const messages = Array.isArray(peek.json?.messages) ? peek.json.messages : []
  if (messages.length === 0) return { ok: true, action: 'idle' }

  const handled = await handleControlMessage(messages[0], cfg, publicKey, ledger, runImpl)
  logFn({
    event: handled.ok ? 'control_executed' : 'control_rejected',
    action: handled.action,
    reason: handled.reason,
    agent: handled.request?.agent_id,
    verb: handled.request?.verb,
  })
  if (handled.consume) {
    const consume = await inboxFn(cfg.baseUrl, cfg.consumerAgent, {
      tenant: cfg.tenant,
      privKey: consumerKey,
      peek: false,
      limit: 1,
    })
    if (!consume.ok) return { ok: false, action: 'consume_failed', status: consume.status, request: handled.request ?? null }
  }
  return handled.ok
    ? { ok: true, action: handled.action, request: handled.request ?? null }
    : { ok: false, action: handled.reason, retry: !handled.consume, request: handled.request ?? null }
}

async function main() {
  const cfgPath = process.argv[2] || join(homedir(), '.fleet', 'control.json')
  let cfg
  try {
    cfg = validateConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  } catch (e) {
    console.error(`fleet-control-daemon: bad config ${cfgPath}: ${e && e.message ? e.message : e}`)
    process.exit(2)
  }

  let consumerKey
  let publicKey
  try {
    consumerKey = await loadPrivKey(cfg.consumerAgent)
    publicKey = await importPanelPublicKey(readFileSync(cfg.panelPublicKeyPath, 'utf8'))
  } catch (e) {
    console.error(`fleet-control-daemon: cannot load keys: ${e && e.message ? e.message : e}`)
    process.exit(3)
  }
  const ledger = new JsonNonceLedger(cfg.nonceLedgerPath)
  log({ event: 'start', base_url: cfg.baseUrl, tenant: cfg.tenant, consumer_agent: cfg.consumerAgent, poll_sec: cfg.pollSec })

  let stopping = false
  const loop = async () => {
    while (!stopping) {
      try { await pollOnce(cfg, consumerKey, publicKey, ledger) } catch (e) { log({ event: 'control_tick_error', error: String(e && e.message ? e.message : e) }) }
      if (!stopping) await new Promise((resolveTimer) => setTimeout(resolveTimer, cfg.pollSec * 1000))
    }
  }
  process.on('SIGTERM', () => { stopping = true; log({ event: 'stop', signal: 'SIGTERM' }) })
  process.on('SIGINT', () => { stopping = true; log({ event: 'stop', signal: 'SIGINT' }) })
  await loop()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

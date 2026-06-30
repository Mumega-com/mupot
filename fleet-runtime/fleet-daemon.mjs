#!/usr/bin/env node
// Fleet daemon — keeps the pot's presence view TRUE by heartbeating only the agents whose
// runtime is ACTUALLY running.
//
//   node fleet-daemon.mjs [config.json]   (default: ~/.fleet/daemon.json)
//
// STERILE / FORKABLE: hardcodes no tenant. The config MUST specify `tenant` and `base_url`
// for your pot. Each agent's `probe` is a shell command (exit 0 = its runtime is alive NOW).
// Alive → signed-attach (re-stamps last_reported_at → presence stays `live`). Probe fails →
// SKIP — no heartbeat — and presence honestly decays running→stale after the pot's TTL. The
// daemon never asserts liveness it cannot observe.
//
// Heartbeat cadence must be comfortably under the pot's presence TTL (default 180s); default
// interval 75s gives ~2.4 beats/window. Private keys are loaded once at startup (fail-fast).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadPrivKey, signedAttach } from './fleet-sign.mjs'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROBE_TIMEOUT_MS = 10_000

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }))
}

/** Validate + normalize the daemon config. Throws on a fatal shape error (fail-fast).
 *  STERILE: `tenant` is REQUIRED — there is no default. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object')
  const baseUrl = raw.base_url
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('config.base_url must be an http(s) URL')
  }
  if (typeof raw.tenant !== 'string' || !raw.tenant) {
    throw new Error('config.tenant is required (this runtime hardcodes no tenant — set yours)')
  }
  const tenant = raw.tenant
  // Floor 15s (anti-spam) → else default 75. CEILING 120s: the cadence must stay well under
  // the pot's presence TTL (default 180s) or a live agent is heartbeated too slowly to ever
  // read `live` — a quiet misconfig that silently defeats truthful presence.
  let intervalSec = Number.isFinite(raw.interval_sec) && raw.interval_sec >= 15 ? raw.interval_sec : 75
  if (intervalSec > 120) intervalSec = 120
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error('config.agents must be a non-empty array')
  }
  const agents = raw.agents.map((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`agents[${i}] must be an object`)
    if (typeof a.agent_id !== 'string' || !AGENT_ID_RE.test(a.agent_id)) {
      throw new Error(`agents[${i}].agent_id invalid`)
    }
    if (typeof a.probe !== 'string' || !a.probe.trim()) {
      throw new Error(`agents[${i}].probe must be a non-empty shell command (exit 0 = alive)`)
    }
    return {
      agent_id: a.agent_id,
      type: typeof a.type === 'string' ? a.type : 'generic',
      runtime: typeof a.runtime === 'string' ? a.runtime : 'claude-code',
      lifecycle: typeof a.lifecycle === 'string' ? a.lifecycle : 'on_demand',
      probe: a.probe,
    }
  })
  return { baseUrl, tenant, intervalSec, agents }
}

/** Run a probe shell command; resolve true iff it exits 0 within the timeout. Never throws.
 *  detached:true makes the child its own process-group leader so a timeout SIGKILLs the WHOLE
 *  group (the `sh` AND any grandchildren it forked). Killing only the `sh` parent would orphan
 *  those grandchildren to init, leaking a process on every probe timeout. */
export function runProbe(cmd, timeoutMs = PROBE_TIMEOUT_MS, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let done = false
    const finish = (alive) => { if (!done) { done = true; resolve(alive) } }
    let child
    try {
      child = spawnImpl('sh', ['-c', cmd], { stdio: 'ignore', detached: true })
    } catch {
      return finish(false)
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
      finish(false)
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); finish(false) })
    child.on('exit', (code) => { clearTimeout(timer); finish(code === 0) })
  })
}

async function tick(cfg, keys) {
  for (const a of cfg.agents) {
    let alive = false
    try { alive = await runProbe(a.probe) } catch { alive = false }
    if (!alive) {
      log({ agent: a.agent_id, probe: 'dead', action: 'skip' })
      continue
    }
    const res = await signedAttach(cfg.baseUrl, a.agent_id, {
      type: a.type, runtime: a.runtime, tenant: cfg.tenant, lifecycle: a.lifecycle, privKey: keys.get(a.agent_id),
    })
    log({ agent: a.agent_id, probe: 'alive', action: res.ok ? 'heartbeat_ok' : 'heartbeat_fail', status: res.status })
  }
}

async function main() {
  const cfgPath = process.argv[2] || join(homedir(), '.fleet', 'daemon.json')
  let cfg
  try {
    cfg = validateConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  } catch (e) {
    console.error(`fleet-daemon: bad config ${cfgPath}: ${e && e.message ? e.message : e}`)
    process.exit(2)
  }

  const keys = new Map()
  for (const a of cfg.agents) {
    try {
      keys.set(a.agent_id, await loadPrivKey(a.agent_id))
    } catch (e) {
      console.error(`fleet-daemon: cannot load key for '${a.agent_id}': ${e && e.message ? e.message : e}`)
      process.exit(3)
    }
  }

  log({ event: 'start', base_url: cfg.baseUrl, tenant: cfg.tenant, interval_sec: cfg.intervalSec, agents: cfg.agents.map((a) => a.agent_id) })

  let stopping = false
  let timer = null
  const loop = async () => {
    if (stopping) return
    try { await tick(cfg, keys) } catch (e) { log({ event: 'tick_error', error: String(e && e.message ? e.message : e) }) }
    if (!stopping) timer = setTimeout(loop, cfg.intervalSec * 1000)
  }

  const shutdown = (sig) => {
    stopping = true
    if (timer) clearTimeout(timer)
    log({ event: 'stop', signal: sig, note: 'presence decays to stale; no signed detach in v1' })
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await loop()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

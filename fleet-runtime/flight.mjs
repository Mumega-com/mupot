#!/usr/bin/env node
// flight — the activation unit. Agents don't sit warm; they fly bounded bursts and land.
//
//   node flight.mjs open  <agent> [config.json]   # takeoff: bring up runtime + signed-attach
//   node flight.mjs close <agent> [config.json]   # land: tear down runtime (presence decays)
//   node flight.mjs list  [config.json]           # show configured flights
//
// STERILE / FORKABLE: hardcodes no tenant. Config (default ~/.fleet/flights.json) supplies
// base_url, tenant, and per-agent { launch, teardown } commands — how THIS host brings each
// runtime up and down. `open` runs `launch` then signed-attach (the takeoff ping → presence
// `live`). `close` runs `teardown` (the runtime goes down → presence decays running→stale =
// landed). A crisp `offline` on land needs a signed /detach (follow-up); stale is the honest
// interim. Tokens burn only between takeoff and land.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadPrivKey, signedAttach } from './fleet-sign.mjs'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const LAUNCH_TIMEOUT_MS = 30_000

function log(obj) { console.log(JSON.stringify({ t: new Date().toISOString(), ...obj })) }

/** Validate the flights config. STERILE: base_url + tenant required. */
export function validateFlights(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object')
  if (typeof raw.base_url !== 'string' || !/^https?:\/\//.test(raw.base_url)) {
    throw new Error('config.base_url must be an http(s) URL')
  }
  if (typeof raw.tenant !== 'string' || !raw.tenant) {
    throw new Error('config.tenant is required (this runtime hardcodes no tenant)')
  }
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error('config.agents must be a non-empty array')
  }
  const agents = new Map()
  for (const [i, a] of raw.agents.entries()) {
    if (!a || typeof a !== 'object' || !AGENT_ID_RE.test(a.agent_id ?? '')) {
      throw new Error(`agents[${i}].agent_id invalid`)
    }
    if (typeof a.launch !== 'string' || !a.launch.trim()) {
      throw new Error(`agents[${i}].launch must be a non-empty shell command`)
    }
    agents.set(a.agent_id, {
      agent_id: a.agent_id,
      type: typeof a.type === 'string' ? a.type : 'generic',
      runtime: typeof a.runtime === 'string' ? a.runtime : 'claude-code',
      lifecycle: typeof a.lifecycle === 'string' ? a.lifecycle : 'on_demand',
      launch: a.launch,
      teardown: typeof a.teardown === 'string' ? a.teardown : '',
    })
  }
  return { baseUrl: raw.base_url, tenant: raw.tenant, agents }
}

/** Run a shell command; resolve its exit code (or null on timeout/spawn-fail). detached +
 *  group-kill so a launch that forks (tmux, &) can't orphan grandchildren on timeout. */
function runCmd(cmd, timeoutMs = LAUNCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false
    const finish = (code) => { if (!done) { done = true; resolve(code) } }
    let child
    try { child = spawn('sh', ['-c', cmd], { stdio: 'ignore', detached: true }) } catch { return finish(null) }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
      finish(null)
    }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('exit', (code) => { clearTimeout(timer); finish(code) })
  })
}

function loadConfig(argvPath) {
  const cfgPath = argvPath || join(homedir(), '.fleet', 'flights.json')
  return validateFlights(JSON.parse(readFileSync(cfgPath, 'utf8')))
}

async function open(cfg, agentId) {
  const a = cfg.agents.get(agentId)
  if (!a) throw new Error(`no flight configured for '${agentId}'`)
  log({ flight: agentId, phase: 'takeoff', step: 'launch' })
  const code = await runCmd(a.launch)
  if (code !== 0) {
    log({ flight: agentId, phase: 'takeoff', step: 'launch', result: 'FAILED', exit: code })
    process.exit(1)
  }
  // Takeoff ping: prove the runtime is up by signing an attach. This is the flight going live.
  const res = await signedAttach(cfg.baseUrl, agentId, {
    type: a.type, runtime: a.runtime, tenant: cfg.tenant, lifecycle: a.lifecycle,
    privKey: await loadPrivKey(agentId),
  })
  log({ flight: agentId, phase: 'takeoff', step: 'attach', result: res.ok ? 'AIRBORNE' : 'attach_failed', status: res.status })
  if (!res.ok) process.exit(1)
}

async function close(cfg, agentId) {
  const a = cfg.agents.get(agentId)
  if (!a) throw new Error(`no flight configured for '${agentId}'`)
  if (a.teardown) {
    log({ flight: agentId, phase: 'land', step: 'teardown' })
    await runCmd(a.teardown)
  }
  // No signed /detach yet: the runtime is down, so presence decays running→stale (= landed).
  log({ flight: agentId, phase: 'land', result: 'LANDED', note: 'presence decays to stale (offline needs signed detach — follow-up)' })
}

async function main() {
  const [verb, agentId, cfgPath] = process.argv.slice(2)
  if (!verb || (verb !== 'list' && !agentId)) {
    console.error('usage: node flight.mjs open|close <agent> [config.json]   |   node flight.mjs list [config.json]')
    process.exit(2)
  }
  let cfg
  try { cfg = loadConfig(verb === 'list' ? agentId : cfgPath) } catch (e) {
    console.error(`flight: bad config: ${e && e.message ? e.message : e}`); process.exit(2)
  }
  if (verb === 'list') { log({ flights: [...cfg.agents.keys()], tenant: cfg.tenant, base_url: cfg.baseUrl }); return }
  if (verb === 'open') return open(cfg, agentId)
  if (verb === 'close') return close(cfg, agentId)
  console.error(`flight: unknown verb '${verb}'`); process.exit(2)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

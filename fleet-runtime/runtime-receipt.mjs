#!/usr/bin/env node
// fleet-runtime live receipt — one daemon cycle as JSON evidence.
//
// host-receipt.mjs proves local config/key wiring without touching Mupot. This
// command is the next gate: it runs the real daemon path once for selected
// agents (probe -> signed attach -> signed inbox peek -> local handler ->
// signed consume) and emits a receipt suitable for a cutover record.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateConfig as validateDaemonConfig, runDaemonOnce } from './fleet-daemon.mjs'
import { loadPrivKey } from './fleet-sign.mjs'

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function parseArgs(argv) {
  const opts = {
    daemonPath: join(homedir(), '.fleet', 'daemon.json'),
    agents: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--daemon') opts.daemonPath = pathArg(next())
    else if (arg === '--agent') opts.agents.push(...next().split(',').map((s) => s.trim()).filter(Boolean))
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/runtime-receipt.mjs [options]',
    '',
    'Options:',
    '  --daemon <path>       fleet-daemon config (default: ~/.fleet/daemon.json)',
    '  --agent <agent_id>    run one selected agent; repeat or comma-separate',
    '  -h, --help            show this help',
    '',
    'Runs one live daemon cycle: probe -> signed attach -> signed inbox drain.',
  ].join('\n')
}

function summarize(checks) {
  const failed = checks.filter((c) => c.ok === false)
  const warnings = checks.filter((c) => c.ok === null)
  return {
    status: failed.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    passed: checks.length - failed.length - warnings.length,
    failed: failed.length,
    warnings: warnings.length,
  }
}

function readDaemonConfig(path, checks) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    checks.push({ ok: false, component: 'runtime-receipt', check: 'daemon_config_read', path, reason: String(err && err.message ? err.message : err) })
    return null
  }
  try {
    const cfg = validateDaemonConfig(raw)
    checks.push({ ok: true, component: 'runtime-receipt', check: 'daemon_config_valid', path })
    return cfg
  } catch (err) {
    checks.push({ ok: false, component: 'runtime-receipt', check: 'daemon_config_valid', path, reason: String(err && err.message ? err.message : err) })
    return null
  }
}

function selectAgents(cfg, requested, checks) {
  const requestedSet = new Set(requested)
  if (requestedSet.size === 0) return cfg.agents
  const byId = new Map(cfg.agents.map((a) => [a.agent_id, a]))
  const selected = []
  for (const agentId of requestedSet) {
    const agent = byId.get(agentId)
    checks.push({ ok: Boolean(agent), component: 'runtime-receipt', check: 'agent_configured', agent_id: agentId })
    if (agent) selected.push(agent)
  }
  return selected
}

async function loadAgentKeys(agents, checks, keyLoader) {
  const keys = new Map()
  for (const agent of agents) {
    try {
      keys.set(agent.agent_id, await keyLoader(agent.agent_id))
      checks.push({ ok: true, component: 'runtime-receipt', check: 'agent_private_key_loaded', agent_id: agent.agent_id })
    } catch (err) {
      checks.push({ ok: false, component: 'runtime-receipt', check: 'agent_private_key_loaded', agent_id: agent.agent_id, reason: String(err && err.message ? err.message : err) })
    }
  }
  return keys
}

function addRunChecks(results, checks) {
  for (const result of results) {
    checks.push({
      ok: result.probe === 'alive',
      component: 'fleet-daemon',
      check: 'probe_alive',
      agent_id: result.agent,
    })
    checks.push({
      ok: result.heartbeat?.ok === true,
      component: 'fleet-daemon',
      check: 'signed_attach_ok',
      agent_id: result.agent,
      status: result.heartbeat?.status ?? null,
    })

    if (!result.inbox) {
      checks.push({ ok: null, component: 'fleet-daemon', check: 'inbox_not_configured', agent_id: result.agent })
      continue
    }
    if (result.inbox.action === 'inbox_empty') {
      checks.push({
        ok: true,
        component: 'fleet-daemon',
        check: 'signed_inbox_peek_ok',
        agent_id: result.agent,
        status: result.inbox.status,
      })
      checks.push({
        ok: null,
        component: 'fleet-daemon',
        check: 'inbox_no_messages_to_handoff',
        agent_id: result.agent,
      })
      continue
    }
    checks.push({
      ok: result.inbox.ok === true && result.inbox.consumed === true,
      component: 'fleet-daemon',
      check: 'signed_inbox_handoff_consumed',
      agent_id: result.agent,
      action: result.inbox.action,
      status: result.inbox.status ?? null,
      messages: result.inbox.messages ?? 0,
    })
  }
}

export async function buildReceipt(opts) {
  const checks = []
  const cfg = readDaemonConfig(opts.daemonPath, checks)
  let agents = []
  let results = []

  if (cfg) {
    agents = selectAgents(cfg, opts.agents ?? [], checks)
    if (agents.length === 0) {
      checks.push({ ok: false, component: 'runtime-receipt', check: 'selected_agents_present' })
    } else {
      const keyLoader = opts.keyLoader ?? loadPrivKey
      const keys = await loadAgentKeys(agents, checks, keyLoader)
      const runnableAgents = agents.filter((a) => keys.has(a.agent_id))
      if (runnableAgents.length === 0) {
        checks.push({ ok: false, component: 'runtime-receipt', check: 'runnable_agents_present' })
      } else {
        const liveAgents = new Set()
        const runOnce = opts.runDaemonOnce ?? runDaemonOnce
        results = await runOnce({ ...cfg, agents: runnableAgents }, keys, liveAgents, opts.runOptions ?? {})
        addRunChecks(results, checks)
      }
    }
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      daemon_config: opts.daemonPath,
      selected_agents: (opts.agents ?? []).length > 0 ? opts.agents : agents.map((a) => a.agent_id),
    },
    checks,
    agents: results,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`runtime-receipt: ${err && err.message ? err.message : err}`)
    console.error(usage())
    process.exit(2)
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const receipt = await buildReceipt(opts)
  console.log(JSON.stringify(receipt, null, 2))
  process.exit(receipt.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { parseArgs, summarize }

#!/usr/bin/env node
// fleet-runtime host receipt — non-destructive proof that a host is wired enough
// to carry Mupot agents through the signed runtime adapter.
//
// This command does not touch Mupot and does not read private key material. It
// validates the same config shapes used by fleet-daemon, inbox-handler, and
// fleet-control-daemon, checks local prerequisite files, and emits a redacted JSON
// receipt operators can attach to a cutover record.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateConfig as validateDaemonConfig, runProbe } from './fleet-daemon.mjs'
import { validateConfig as validateInboxHandlerConfig } from './inbox-handler.mjs'
import { validateConfig as validateControlConfig } from './fleet-control-daemon.mjs'
import { keyPathFor } from './fleet-sign.mjs'

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function defaultPaths() {
  return {
    daemon: join(homedir(), '.fleet', 'daemon.json'),
    inbox: join(homedir(), '.fleet', 'inbox-handler.json'),
    control: join(homedir(), '.fleet', 'control.json'),
  }
}

function parseArgs(argv) {
  const defaults = defaultPaths()
  const opts = {
    daemonPath: defaults.daemon,
    inboxPath: defaults.inbox,
    controlPath: defaults.control,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a path`)
      return pathArg(argv[i])
    }
    if (arg === '--daemon') opts.daemonPath = next()
    else if (arg === '--inbox') opts.inboxPath = next()
    else if (arg === '--control') opts.controlPath = next()
    else if (arg === '--skip-inbox') opts.skipInbox = true
    else if (arg === '--skip-control') opts.skipControl = true
    else if (arg === '--exec-probes') opts.execProbes = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/host-receipt.mjs [options]',
    '',
    'Options:',
    '  --daemon <path>       fleet-daemon config (default: ~/.fleet/daemon.json)',
    '  --inbox <path>        inbox-handler config (default: ~/.fleet/inbox-handler.json)',
    '  --control <path>      fleet-control-daemon config (default: ~/.fleet/control.json)',
    '  --skip-inbox          do not require inbox-handler config',
    '  --skip-control        do not require fleet-control config',
    '  --exec-probes         run daemon probe commands and include alive/dead results',
    '  -h, --help            show this help',
  ].join('\n')
}

function readJson(path, label) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { ok: false, error: `${label}: ${err && err.message ? err.message : err}` }
  }
}

function checkPath(path, opts = {}) {
  const label = opts.label ?? path
  try {
    const st = statSync(path)
    const mode = st.mode & 0o777
    if (opts.file && !st.isFile()) return { ok: false, label, path, reason: 'not_file' }
    if (opts.modeMax !== undefined && (mode & ~opts.modeMax) !== 0) {
      return { ok: false, label, path, mode: mode.toString(8), reason: `perms_too_open_max_${opts.modeMax.toString(8)}` }
    }
    return { ok: true, label, path, mode: mode.toString(8), size: st.size }
  } catch {
    return { ok: false, label, path, reason: 'missing' }
  }
}

function hasPlaceholder(v) {
  return typeof v === 'string' && (
    v.includes('YOUR_') ||
    v.includes('YOUR-POT') ||
    v.includes('YOUR-TENANT') ||
    hasReservedExampleHost(v)
  )
}

function hasReservedExampleHost(v) {
  try {
    const hostname = new URL(v).hostname.toLowerCase()
    return hostname === 'example.com' || hostname.endsWith('.example.com')
  } catch {
    return false
  }
}

function checkConfigIdentity(kind, cfg) {
  const checks = []
  if (hasPlaceholder(cfg.baseUrl ?? cfg.base_url)) {
    checks.push({ ok: false, kind, check: 'base_url_real', reason: 'placeholder_base_url' })
  } else {
    checks.push({ ok: true, kind, check: 'base_url_real' })
  }
  if (hasPlaceholder(cfg.tenant) || !cfg.tenant) {
    checks.push({ ok: false, kind, check: 'tenant_real', reason: 'placeholder_or_missing_tenant' })
  } else {
    checks.push({ ok: true, kind, check: 'tenant_real' })
  }
  return checks
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

function normalizeCheck(result, extra = {}) {
  return { ...extra, ...result, ok: result.ok === true }
}

function collectDaemonChecks(opts, checks) {
  const raw = readJson(opts.daemonPath, 'fleet-daemon config')
  if (!raw.ok) {
    checks.push({ ok: false, component: 'fleet-daemon', check: 'config_read', path: opts.daemonPath, reason: raw.error })
    return null
  }
  let cfg
  try {
    cfg = validateDaemonConfig(raw.value)
    checks.push({ ok: true, component: 'fleet-daemon', check: 'config_valid', path: opts.daemonPath })
  } catch (err) {
    checks.push({ ok: false, component: 'fleet-daemon', check: 'config_valid', path: opts.daemonPath, reason: String(err && err.message ? err.message : err) })
    return null
  }
  checks.push(...checkConfigIdentity('fleet-daemon', cfg).map((c) => ({ component: 'fleet-daemon', ...c })))
  checks.push({ ok: cfg.intervalSec <= 120, component: 'fleet-daemon', check: 'heartbeat_cadence_under_ttl', interval_sec: cfg.intervalSec })
  const keyPath = opts.keyPathFor ?? keyPathFor
  for (const agent of cfg.agents) {
    checks.push(normalizeCheck(checkPath(keyPath(agent.agent_id), { label: `key:${agent.agent_id}`, file: true, modeMax: 0o600 }), {
      component: 'fleet-daemon',
      check: 'agent_private_key_present_0600',
      agent_id: agent.agent_id,
    }))
    checks.push({
      ok: true,
      component: 'fleet-daemon',
      check: 'probe_configured',
      agent_id: agent.agent_id,
      probe: agent.probe,
    })
  }
  return cfg
}

function collectInboxChecks(opts, checks, daemonCfg) {
  if (opts.skipInbox) {
    checks.push({ ok: null, component: 'inbox-handler', check: 'skipped' })
    return null
  }
  const raw = readJson(opts.inboxPath, 'inbox-handler config')
  if (!raw.ok) {
    checks.push({ ok: false, component: 'inbox-handler', check: 'config_read', path: opts.inboxPath, reason: raw.error })
    return null
  }
  let cfg
  try {
    cfg = validateInboxHandlerConfig(raw.value)
    checks.push({ ok: true, component: 'inbox-handler', check: 'config_valid', path: opts.inboxPath })
  } catch (err) {
    checks.push({ ok: false, component: 'inbox-handler', check: 'config_valid', path: opts.inboxPath, reason: String(err && err.message ? err.message : err) })
    return null
  }
  const daemonInboxAgents = (daemonCfg?.agents ?? []).filter((a) => a.inbox).map((a) => a.agent_id)
  for (const agentId of daemonInboxAgents) {
    checks.push({
      ok: cfg.agents.has(agentId),
      component: 'inbox-handler',
      check: 'daemon_inbox_agent_has_handler_config',
      agent_id: agentId,
    })
  }
  for (const [agentId, agentCfg] of cfg.agents.entries()) {
    checks.push({
      ok: true,
      component: 'inbox-handler',
      check: 'spool_dir_configured',
      agent_id: agentId,
      spool_dir: agentCfg.spoolDir,
      command_configured: Boolean(agentCfg.command),
    })
  }
  return cfg
}

function collectControlChecks(opts, checks) {
  if (opts.skipControl) {
    checks.push({ ok: null, component: 'fleet-control-daemon', check: 'skipped' })
    return null
  }
  const raw = readJson(opts.controlPath, 'fleet-control config')
  if (!raw.ok) {
    checks.push({ ok: false, component: 'fleet-control-daemon', check: 'config_read', path: opts.controlPath, reason: raw.error })
    return null
  }
  let cfg
  try {
    cfg = validateControlConfig(raw.value)
    checks.push({ ok: true, component: 'fleet-control-daemon', check: 'config_valid', path: opts.controlPath })
  } catch (err) {
    checks.push({ ok: false, component: 'fleet-control-daemon', check: 'config_valid', path: opts.controlPath, reason: String(err && err.message ? err.message : err) })
    return null
  }
  checks.push(...checkConfigIdentity('fleet-control-daemon', cfg).map((c) => ({ component: 'fleet-control-daemon', ...c })))
  const keyPath = opts.keyPathFor ?? keyPathFor
  checks.push(normalizeCheck(checkPath(keyPath(cfg.consumerAgent), { label: `key:${cfg.consumerAgent}`, file: true, modeMax: 0o600 }), {
    component: 'fleet-control-daemon',
    check: 'consumer_private_key_present_0600',
    agent_id: cfg.consumerAgent,
  }))
  checks.push(normalizeCheck(checkPath(cfg.panelPublicKeyPath, { label: 'panel_public_key', file: true }), {
    component: 'fleet-control-daemon',
    check: 'panel_public_key_present',
  }))
  checks.push(normalizeCheck(checkPath(cfg.flightsConfigPath, { label: 'flights_config', file: true }), {
    component: 'fleet-control-daemon',
    check: 'flights_config_present',
  }))
  checks.push(normalizeCheck(checkPath(cfg.flightScript, { label: 'flight_script', file: true }), {
    component: 'fleet-control-daemon',
    check: 'flight_script_present',
  }))
  return cfg
}

export async function buildReceipt(opts) {
  const checks = []
  const daemonCfg = collectDaemonChecks(opts, checks)
  collectInboxChecks(opts, checks, daemonCfg)
  collectControlChecks(opts, checks)

  if (opts.execProbes && daemonCfg) {
    for (const agent of daemonCfg.agents) {
      const alive = await runProbe(agent.probe)
      checks.push({ ok: alive, component: 'fleet-daemon', check: 'probe_exec_alive', agent_id: agent.agent_id })
    }
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-host-receipt/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      daemon_config: opts.daemonPath,
      inbox_handler_config: opts.skipInbox ? null : opts.inboxPath,
      control_config: opts.skipControl ? null : opts.controlPath,
      exec_probes: opts.execProbes,
    },
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`host-receipt: ${err && err.message ? err.message : err}`)
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

export { parseArgs, checkPath, hasPlaceholder, summarize }

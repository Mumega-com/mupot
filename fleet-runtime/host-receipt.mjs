#!/usr/bin/env node
// fleet-runtime host receipt — non-destructive proof that a host is wired enough
// to carry Mupot agents through the signed runtime adapter.
//
// This command does not touch Mupot and does not read private key material. It
// validates the same config shapes used by fleet-daemon, inbox-handler, and
// fleet-control-daemon, checks local prerequisite files, and emits a redacted JSON
// receipt operators can attach to a cutover record.

import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateConfig as validateDaemonConfig, runProbe } from './fleet-daemon.mjs'
import { validateConfig as validateInboxHandlerConfig } from './inbox-handler.mjs'
import { validateConfig as validateControlConfig } from './fleet-control-daemon.mjs'
import { keyPathFor } from './fleet-sign.mjs'
import { importPanelPublicKey } from './control-request.mjs'
import { buildServiceReceipt as buildDefaultServiceReceipt } from './service-manager.mjs'
import { createServiceContext, resolveServiceManager, SECRET_VALUE_PATTERNS } from './service-context.mjs'
import { renderLaunchd } from './launchd-service-manager.mjs'
import { renderSystemd } from './systemd-service-manager.mjs'

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
    requireServices: false,
    serviceManager: 'auto',
    serviceDefinitionDir: null,
    nodePath: null,
  }
  let serviceOptionUsed = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const nextValue = () => {
      i += 1
      if (i >= argv.length || argv[i] === '' || argv[i].startsWith('-')) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    const next = () => pathArg(nextValue())
    if (arg === '--daemon') opts.daemonPath = next()
    else if (arg === '--inbox') opts.inboxPath = next()
    else if (arg === '--control') opts.controlPath = next()
    else if (arg === '--skip-inbox') opts.skipInbox = true
    else if (arg === '--skip-control') opts.skipControl = true
    else if (arg === '--exec-probes') opts.execProbes = true
    else if (arg === '--require-services') opts.requireServices = true
    else if (arg === '--service-manager') {
      serviceOptionUsed = true
      opts.serviceManager = nextValue()
      if (!['auto', 'systemd', 'launchd'].includes(opts.serviceManager)) {
        throw new Error('--service-manager requires auto|systemd|launchd')
      }
    }
    else if (arg === '--service-definition-dir') {
      serviceOptionUsed = true
      opts.serviceDefinitionDir = next()
    }
    else if (arg === '--node') {
      serviceOptionUsed = true
      const nodePath = expandHome(nextValue())
      if (!isAbsolute(nodePath)) throw new Error('--node requires an absolute path')
      opts.nodePath = resolve(nodePath)
    }
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (serviceOptionUsed && !opts.requireServices) throw new Error('service-manager/definition flags require --require-services')
  if (opts.requireServices && opts.skipControl) throw new Error('--require-services conflicts with --skip-control')
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
    '  --require-services    require current definitions and running heartbeat/control services',
    '  --service-manager <auto|systemd|launchd>',
    '                        service manager to inspect (default: auto)',
    '  --service-definition-dir <path>',
    '                        launchd/systemd user definition directory',
    '  --node <absolute-path>',
    '                        Node entrypoint used to render service definitions',
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

async function validatePanelPublicKey(path, checks) {
  try {
    await importPanelPublicKey(readFileSync(path, 'utf8'))
    checks.push({
      ok: true,
      component: 'fleet-control-daemon',
      check: 'panel_public_key_public_only',
      path,
    })
  } catch (err) {
    checks.push({
      ok: false,
      component: 'fleet-control-daemon',
      check: 'panel_public_key_public_only',
      path,
      reason: String(err && err.message ? err.message : err),
    })
  }
}

async function collectControlChecks(opts, checks) {
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
  await validatePanelPublicKey(cfg.panelPublicKeyPath, checks)
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

function addHostTargetConsistencyChecks(checks, daemonCfg, controlCfg) {
  if (!daemonCfg || !controlCfg) return
  checks.push({
    ok: daemonCfg.baseUrl === controlCfg.baseUrl,
    component: 'host-receipt',
    check: 'daemon_control_base_url_match',
    daemon_base_url: daemonCfg.baseUrl,
    control_base_url: controlCfg.baseUrl,
  })
  checks.push({
    ok: daemonCfg.tenant === controlCfg.tenant,
    component: 'host-receipt',
    check: 'daemon_control_tenant_match',
    daemon_tenant: daemonCfg.tenant,
    control_tenant: controlCfg.tenant,
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function passingPathCheck(check, component, name, extraKeys = []) {
  return hasExactKeys(check, ['ok', 'component', 'check', ...extraKeys, 'label', 'path', 'mode', 'size']) &&
    check.ok === true && check.component === component && check.check === name &&
    nonEmptyString(check.label) && nonEmptyString(check.path) && /^[0-7]{3,4}$/.test(check.mode) &&
    Number.isInteger(check.size) && check.size >= 0
}

function passingHostSummary(receipt) {
  if (!hasExactKeys(receipt?.summary, ['status', 'passed', 'failed', 'warnings']) || !Array.isArray(receipt?.checks)) return false
  const expected = summarize(receipt.checks)
  return receipt.status === 'pass' && receipt.status === receipt.summary.status && sameJson(receipt.summary, expected)
}

function validateDefinitionEvidence(check, service) {
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'service_manager', 'definition_dir', 'definitions']) ||
    check.ok !== true || check.component !== 'host-services' || check.check !== 'service_definitions_current' ||
    check.service_manager !== service.manager || !nonEmptyString(check.definition_dir) ||
    !Array.isArray(check.definitions) || check.definitions.length !== 2) return null
  const hashes = {}
  for (const definition of check.definitions) {
    if (!hasExactKeys(definition, ['service', 'path', 'expected_sha256', 'rendered_sha256', 'actual_sha256', 'argv', 'expected_argv', 'ok']) ||
      !['heartbeat', 'control'].includes(definition.service) || Object.hasOwn(hashes, definition.service) || definition.ok !== true ||
      !nonEmptyString(definition.path) || !/^[a-f0-9]{64}$/.test(definition.expected_sha256 ?? '') ||
      definition.expected_sha256 !== service.definitions?.[definition.service] ||
      definition.rendered_sha256 !== definition.expected_sha256 || definition.actual_sha256 !== definition.expected_sha256 ||
      !Array.isArray(definition.argv) || definition.argv.length === 0 || definition.argv.some((arg) => typeof arg !== 'string') ||
      !Array.isArray(definition.expected_argv) || !sameJson(definition.argv, definition.expected_argv)) return null
    hashes[definition.service] = definition.actual_sha256
  }
  return hashes
}

/** Validate the exact successful shape emitted by buildReceipt with service checks enabled. */
export function normalizePassingHostReceipt(receipt, service, selectedAgents = []) {
  const topKeys = ['receipt_type', 'generated_at', 'status', 'summary', 'inputs', 'target', 'checks']
  if (!service || !hasExactKeys(receipt, topKeys) || receipt.receipt_type !== 'mupot-fleet-host-receipt/v1' ||
    !nonEmptyString(receipt.generated_at) || Number.isNaN(Date.parse(receipt.generated_at)) || !passingHostSummary(receipt)) return null
  if (!hasExactKeys(receipt.inputs, ['daemon_config', 'inbox_handler_config', 'control_config', 'exec_probes', 'service_manager', 'service_definition_dir']) ||
    !['daemon_config', 'inbox_handler_config', 'control_config', 'service_definition_dir'].every((key) => nonEmptyString(receipt.inputs[key])) ||
    typeof receipt.inputs.exec_probes !== 'boolean' || receipt.inputs.service_manager !== service.manager) return null
  const target = receipt.target
  if (!hasExactKeys(target, ['base_url', 'tenant', 'daemon_agents', 'control_consumer_agent']) ||
    !nonEmptyString(target.base_url) || !nonEmptyString(target.tenant) || !nonEmptyString(target.control_consumer_agent) ||
    !Array.isArray(target.daemon_agents) || target.daemon_agents.length === 0 ||
    target.daemon_agents.some((agent) => !nonEmptyString(agent)) || new Set(target.daemon_agents).size !== target.daemon_agents.length ||
    !Array.isArray(selectedAgents) || selectedAgents.some((agent) => !target.daemon_agents.includes(agent))) return null

  const checks = receipt.checks
  let index = 0
  const take = () => checks[index++]
  let check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'path']) || check.ok !== true || check.component !== 'fleet-daemon' || check.check !== 'config_valid' || !nonEmptyString(check.path)) return null
  for (const name of ['base_url_real', 'tenant_real']) {
    check = take()
    if (!hasExactKeys(check, ['component', 'ok', 'kind', 'check']) || check.ok !== true || check.component !== 'fleet-daemon' || check.kind !== 'fleet-daemon' || check.check !== name) return null
  }
  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'interval_sec']) || check.ok !== true || check.component !== 'fleet-daemon' ||
    check.check !== 'heartbeat_cadence_under_ttl' || !Number.isFinite(check.interval_sec) || check.interval_sec < 15 || check.interval_sec > 120) return null
  for (const agentId of target.daemon_agents) {
    check = take()
    if (!passingPathCheck(check, 'fleet-daemon', 'agent_private_key_present_0600', ['agent_id']) || check.agent_id !== agentId || check.mode !== '600') return null
    check = take()
    if (!hasExactKeys(check, ['ok', 'component', 'check', 'agent_id', 'probe']) || check.ok !== true || check.component !== 'fleet-daemon' ||
      check.check !== 'probe_configured' || check.agent_id !== agentId || !nonEmptyString(check.probe)) return null
  }

  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'path']) || check.ok !== true || check.component !== 'inbox-handler' || check.check !== 'config_valid' || !nonEmptyString(check.path)) return null
  const inboxAgents = new Set()
  while (checks[index]?.component === 'inbox-handler' && checks[index]?.check === 'daemon_inbox_agent_has_handler_config') {
    check = take()
    if (!hasExactKeys(check, ['ok', 'component', 'check', 'agent_id']) || check.ok !== true || !target.daemon_agents.includes(check.agent_id) || inboxAgents.has(check.agent_id)) return null
    inboxAgents.add(check.agent_id)
  }
  const spoolAgents = new Set()
  while (checks[index]?.component === 'inbox-handler' && checks[index]?.check === 'spool_dir_configured') {
    check = take()
    if (!hasExactKeys(check, ['ok', 'component', 'check', 'agent_id', 'spool_dir', 'command_configured']) || check.ok !== true ||
      !nonEmptyString(check.agent_id) || !nonEmptyString(check.spool_dir) || typeof check.command_configured !== 'boolean' || spoolAgents.has(check.agent_id)) return null
    spoolAgents.add(check.agent_id)
  }
  if ([...inboxAgents].some((agent) => !spoolAgents.has(agent))) return null

  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'path']) || check.ok !== true || check.component !== 'fleet-control-daemon' || check.check !== 'config_valid' || !nonEmptyString(check.path)) return null
  for (const name of ['base_url_real', 'tenant_real']) {
    check = take()
    if (!hasExactKeys(check, ['component', 'ok', 'kind', 'check']) || check.ok !== true || check.component !== 'fleet-control-daemon' || check.kind !== 'fleet-control-daemon' || check.check !== name) return null
  }
  check = take()
  if (!passingPathCheck(check, 'fleet-control-daemon', 'consumer_private_key_present_0600', ['agent_id']) || check.agent_id !== target.control_consumer_agent || check.mode !== '600') return null
  check = take()
  if (!passingPathCheck(check, 'fleet-control-daemon', 'panel_public_key_present')) return null
  const panelPath = check.path
  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'path']) || check.ok !== true || check.component !== 'fleet-control-daemon' || check.check !== 'panel_public_key_public_only' || check.path !== panelPath) return null
  for (const name of ['flights_config_present', 'flight_script_present']) {
    check = take()
    if (!passingPathCheck(check, 'fleet-control-daemon', name)) return null
  }
  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'daemon_base_url', 'control_base_url']) || check.ok !== true || check.component !== 'host-receipt' ||
    check.check !== 'daemon_control_base_url_match' || check.daemon_base_url !== target.base_url || check.control_base_url !== target.base_url) return null
  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'daemon_tenant', 'control_tenant']) || check.ok !== true || check.component !== 'host-receipt' ||
    check.check !== 'daemon_control_tenant_match' || check.daemon_tenant !== target.tenant || check.control_tenant !== target.tenant) return null

  check = take()
  const hashes = validateDefinitionEvidence(check, service)
  if (!hashes || check.definition_dir !== receipt.inputs.service_definition_dir) return null
  for (const [key, name] of [['heartbeat', 'heartbeat_service_running'], ['control', 'control_service_running']]) {
    check = take()
    if (!hasExactKeys(check, ['ok', 'component', 'check', 'service']) || check.ok !== true || check.component !== 'host-services' ||
      check.check !== name || !sameJson(check.service, service.services?.[key])) return null
  }
  check = take()
  if (!hasExactKeys(check, ['ok', 'component', 'check', 'service_manager', 'applicable', 'linger']) || check.ok !== true ||
    check.component !== 'host-services' || check.check !== 'systemd_linger_enabled' || check.service_manager !== service.manager ||
    check.applicable !== (service.manager === 'systemd') || !sameJson(check.linger, service.linger)) return null

  if (receipt.inputs.exec_probes) {
    for (const agentId of target.daemon_agents) {
      check = take()
      if (!hasExactKeys(check, ['ok', 'component', 'check', 'agent_id']) || check.ok !== true || check.component !== 'fleet-daemon' ||
        check.check !== 'probe_exec_alive' || check.agent_id !== agentId) return null
    }
  }
  if (index !== checks.length) return null
  return { target, definition_hashes: hashes }
}

function containsCanonicalSecret(value) {
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some(([, pattern]) => pattern.test(value))
  if (Array.isArray(value)) return value.some(containsCanonicalSecret)
  if (isPlainObject(value)) return Object.values(value).some(containsCanonicalSecret)
  return false
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function parseLaunchdArguments(content) {
  const array = String(content).match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (!array) return null
  const values = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1]))
  return values.length > 0 ? values : null
}

function parseSystemdArguments(content) {
  const line = String(content).split(/\r?\n/).find((entry) => entry.startsWith('ExecStart='))
  if (!line) return null
  const input = line.slice('ExecStart='.length)
  const values = []
  let index = 0
  while (index < input.length) {
    while (/\s/.test(input[index] ?? '')) index += 1
    if (index >= input.length) break
    let quoted = false
    if (input[index] === '"') {
      quoted = true
      index += 1
    }
    let value = ''
    while (index < input.length) {
      const character = input[index]
      if (quoted && character === '"') {
        index += 1
        break
      }
      if (!quoted && /\s/.test(character)) break
      if (character === '\\' && index + 1 < input.length) {
        const escaped = input[index + 1]
        value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped
        index += 2
        continue
      }
      value += character
      index += 1
    }
    if (quoted && input[index - 1] !== '"') return null
    values.push(value.replaceAll('%%', '%').replaceAll('$$', '$'))
    while (/\s/.test(input[index] ?? '')) index += 1
  }
  return values.length > 0 ? values : null
}

function readContainedDefinition(path, definitionRoot, deps = {}) {
  if (definitionRoot === null) return null
  const open = deps.openSync ?? openSync
  const close = deps.closeSync ?? closeSync
  const fstat = deps.fstatSync ?? fstatSync
  const lstat = deps.lstatSync ?? lstatSync
  const realpath = deps.realpathSync ?? realpathSync
  const stat = deps.statSync ?? statSync
  const read = deps.readFileSync ?? readFileSync
  let fd = null
  try {
    fd = open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const opened = fstat(fd)
    const named = lstat(path)
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) return null
    const realPath = realpath(path)
    const fromRoot = relative(definitionRoot, realPath)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null
    const confirmed = stat(path)
    if (!confirmed.isFile() || opened.dev !== confirmed.dev || opened.ino !== confirmed.ino) return null
    return read(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { close(fd) } catch {}
    }
  }
}

function definitionEvidence(context, serviceReceipt, configPaths, readDeps = {}) {
  const definitions = Array.isArray(serviceReceipt?.definitions) ? serviceReceipt.definitions : []
  const uniqueDefinitions = new Map(definitions.map((definition) => [definition?.service, definition]))
  const rendered = (context.manager === 'launchd' ? renderLaunchd(context) : renderSystemd(context))
  const renderedByKey = new Map(rendered.map((definition) => [definition.key, definition]))
  let definitionRoot = null
  try {
    const dirStat = lstatSync(context.definitionDir)
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) definitionRoot = realpathSync(context.definitionDir)
  } catch {
    // Each definition below records the directory as unsafe/unreadable.
  }
  const evidence = context.services.map((service) => {
    const definition = uniqueDefinitions.get(service.key)
    const current = renderedByKey.get(service.key)
    const content = readContainedDefinition(service.definitionPath, definitionRoot, readDeps)
    const regularContainedFile = content !== null
    const actualSha256 = content === null ? null : sha256(content)
    const renderedSha256 = current ? sha256(current.content) : null
    const argv = content === null
      ? null
      : context.manager === 'launchd' ? parseLaunchdArguments(content) : parseSystemdArguments(content)
    const expectedArgv = [context.nodePath, service.scriptPath, configPaths[service.key]]
    const pathMatches = definition?.path === service.definitionPath && current?.path === service.definitionPath
    const hashMatches = /^[a-f0-9]{64}$/.test(definition?.sha256 ?? '') &&
      actualSha256 === renderedSha256 && renderedSha256 === definition.sha256
    const argumentsMatch = Array.isArray(argv) && JSON.stringify(argv) === JSON.stringify(expectedArgv)
    return {
      service: service.key,
      path: service.definitionPath,
      expected_sha256: definition?.sha256 ?? null,
      rendered_sha256: renderedSha256,
      actual_sha256: actualSha256,
      argv,
      expected_argv: expectedArgv,
      ok: regularContainedFile && pathMatches && hashMatches && argumentsMatch,
    }
  })
  return {
    ok: definitions.length === context.services.length && uniqueDefinitions.size === context.services.length && evidence.every((entry) => entry.ok),
    definitions: evidence,
  }
}

function serviceStateEvidence(context, serviceReceipt, key) {
  const services = Array.isArray(serviceReceipt?.services) ? serviceReceipt.services : []
  const matches = services.filter((service) => service?.key === key)
  const expected = context.services.find((service) => service.key === key)
  const service = matches[0]
  return {
    ok: matches.length === 1 && service?.name === expected?.name && service?.loaded === true &&
      service?.running === true && Number.isInteger(service?.pid) && service.pid > 0,
    service: service ?? null,
  }
}

function validServiceReceiptEnvelope(receipt, context, platformName) {
  const topKeys = ['receipt_type', 'generated_at', 'status', 'platform', 'service_manager', 'action', 'definitions', 'services', 'linger', 'commands', 'preserved_data', 'next_steps', 'checks']
  if (!hasExactKeys(receipt, topKeys) || containsCanonicalSecret(receipt)) return false
  if (receipt.receipt_type !== 'mupot-fleet-service-receipt/v1' || receipt.status !== 'pass' || receipt.action !== 'status') return false
  if (receipt.service_manager !== context.manager || receipt.platform !== platformName || Number.isNaN(Date.parse(receipt.generated_at))) return false
  if (!Array.isArray(receipt.definitions) || receipt.definitions.length !== context.services.length) return false
  const definitionKeys = new Set()
  for (const definition of receipt.definitions) {
    if (!hasExactKeys(definition, ['service', 'path', 'sha256']) || definitionKeys.has(definition.service)) return false
    const expected = context.services.find((service) => service.key === definition.service)
    if (!expected || definition.path !== expected.definitionPath || !/^[a-f0-9]{64}$/.test(definition.sha256)) return false
    definitionKeys.add(definition.service)
  }
  if (!Array.isArray(receipt.services) || receipt.services.length !== context.services.length) return false
  const serviceKeys = new Set()
  for (const service of receipt.services) {
    if (!hasExactKeys(service, ['key', 'name', 'loaded', 'enabled', 'running', 'pid']) || serviceKeys.has(service.key)) return false
    const expected = context.services.find((entry) => entry.key === service.key)
    if (!expected || service.name !== expected.name || service.loaded !== true || typeof service.enabled !== 'boolean' ||
      service.running !== true || !Number.isInteger(service.pid) || service.pid <= 0) return false
    serviceKeys.add(service.key)
  }
  if (!Array.isArray(receipt.commands) || receipt.commands.some((command) =>
    !hasExactKeys(command, ['executable', 'argv', 'code', 'stdout_summary', 'stderr_summary']) ||
    typeof command.executable !== 'string' || command.executable.length === 0 || !Array.isArray(command.argv) ||
    command.argv.some((arg) => typeof arg !== 'string') || !Number.isInteger(command.code) ||
    typeof command.stdout_summary !== 'string' || typeof command.stderr_summary !== 'string')) return false
  const expectedCommands = context.manager === 'systemd'
    ? [
        ...context.services.map((service) => ['systemctl', ['--user', 'show', service.systemdUnit, '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value']]),
        ['loginctl', ['show-user', context.username, '-p', 'Linger', '--value']],
      ]
    : context.services.map((service) => ['launchctl', ['print', `${context.domain}/${service.launchdLabel}`]])
  if (receipt.commands.length !== expectedCommands.length || receipt.commands.some((command, index) =>
    command.executable !== expectedCommands[index][0] || JSON.stringify(command.argv) !== JSON.stringify(expectedCommands[index][1]) || command.code !== 0)) return false
  const preservedKeys = ['configs', 'private_keys', 'runtime', 'inbox', 'receipts']
  if (!hasExactKeys(receipt.preserved_data, preservedKeys) || preservedKeys.some((key) => receipt.preserved_data[key] !== true)) return false
  if (!Array.isArray(receipt.next_steps) || receipt.next_steps.length !== 0) return false
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== 2 ||
    !hasExactKeys(receipt.checks[0], ['ok', 'check']) || receipt.checks[0].ok !== true || receipt.checks[0].check !== 'services_loaded_and_running' ||
    !hasExactKeys(receipt.checks[1], ['ok', 'check']) || receipt.checks[1].ok !== true || receipt.checks[1].check !== 'command_output_secret_free') return false
  if (context.manager === 'systemd') return hasExactKeys(receipt.linger, ['enabled', 'raw']) && receipt.linger.enabled === true && receipt.linger.raw === 'yes'
  return receipt.linger === null
}

async function collectServiceChecks(opts, checks) {
  const requestedManager = opts.serviceManager ?? 'auto'
  const platformName = opts.platformName ?? process.platform
  if (requestedManager === 'launchd' && platformName !== 'darwin') throw new Error('launchd requires darwin')
  if (requestedManager === 'systemd' && platformName !== 'linux') throw new Error('systemd requires linux')
  const manager = resolveServiceManager(requestedManager, platformName)
  const prefix = resolve(opts.prefix ?? dirname(opts.daemonPath))
  const runtimeDir = resolve(opts.runtimeDir ?? join(prefix, 'runtime'))
  const nodePath = resolve(opts.nodePath ?? process.execPath)
  const context = createServiceContext({
    manager,
    platformName,
    homeDir: opts.homeDir,
    prefix,
    runtimeDir,
    definitionDir: opts.serviceDefinitionDir ?? undefined,
    nodePath,
    uid: opts.uid,
    username: opts.username,
  })
  const definitionOption = manager === 'launchd'
    ? { launchdDir: context.definitionDir }
    : { systemdDir: context.definitionDir }
  let serviceReceipt = null
  let failure = null
  try {
    const builder = opts.buildServiceReceipt ?? buildDefaultServiceReceipt
    serviceReceipt = await builder({
      action: 'status',
      serviceManager: manager,
      prefix: context.prefix,
      runtimeDir: context.runtimeDir,
      nodePath: context.nodePath,
      homeDir: context.homeDir,
      uid: context.uid,
      username: context.username,
      ...definitionOption,
    }, { platformName, ...(opts.serviceDeps ?? {}) })
  } catch (error) {
    failure = String(error?.message ?? error)
  }

  const metadataOk = validServiceReceiptEnvelope(serviceReceipt, context, platformName)
  const definitions = definitionEvidence(context, serviceReceipt, {
    heartbeat: resolve(opts.daemonPath),
    control: resolve(opts.controlPath),
  }, opts.definitionReadDeps)
  const heartbeat = serviceStateEvidence(context, serviceReceipt, 'heartbeat')
  const control = serviceStateEvidence(context, serviceReceipt, 'control')
  const lingerOk = manager === 'systemd'
    ? serviceReceipt?.linger?.enabled === true && serviceReceipt?.linger?.raw === 'yes'
    : serviceReceipt?.linger === null

  checks.push({
    ok: metadataOk && definitions.ok,
    component: 'host-services',
    check: 'service_definitions_current',
    service_manager: manager,
    definition_dir: context.definitionDir,
    definitions: definitions.definitions,
    ...(failure ? { reason: failure } : {}),
  })
  checks.push({ ok: metadataOk && heartbeat.ok, component: 'host-services', check: 'heartbeat_service_running', service: heartbeat.service })
  checks.push({ ok: metadataOk && control.ok, component: 'host-services', check: 'control_service_running', service: control.service })
  checks.push({
    ok: metadataOk && lingerOk,
    component: 'host-services',
    check: 'systemd_linger_enabled',
    service_manager: manager,
    applicable: manager === 'systemd',
    linger: serviceReceipt?.linger ?? null,
  })
  return { manager, definitionDir: context.definitionDir }
}

export async function buildReceipt(opts) {
  const checks = []
  const daemonCfg = collectDaemonChecks(opts, checks)
  collectInboxChecks(opts, checks, daemonCfg)
  const controlCfg = await collectControlChecks(opts, checks)
  addHostTargetConsistencyChecks(checks, daemonCfg, controlCfg)
  let serviceInputs = null
  if (opts.requireServices) serviceInputs = await collectServiceChecks(opts, checks)

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
      ...(opts.requireServices ? {
        service_manager: serviceInputs.manager,
        service_definition_dir: serviceInputs.definitionDir,
      } : {}),
    },
    target: {
      base_url: daemonCfg?.baseUrl ?? controlCfg?.baseUrl ?? null,
      tenant: daemonCfg?.tenant ?? controlCfg?.tenant ?? null,
      daemon_agents: (daemonCfg?.agents ?? []).map((agent) => agent.agent_id),
      control_consumer_agent: controlCfg?.consumerAgent ?? null,
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

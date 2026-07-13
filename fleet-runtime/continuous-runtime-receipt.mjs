#!/usr/bin/env node

import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readRuntimeState as defaultReadRuntimeState } from './runtime-state.mjs'
import { buildServiceReceipt as defaultBuildServiceReceipt } from './service-manager.mjs'
import { redactSecretValues, resolveServiceManager } from './service-context.mjs'

const RECEIPT_TYPE = 'mupot-fleet-continuous-runtime-receipt/v1'
const HEARTBEAT_SCHEMA = 'mupot-fleet-daemon-state/v1'
const CONTROL_SCHEMA = 'mupot-fleet-control-state/v1'
const SERVICE_RECEIPT_TYPE = 'mupot-fleet-service-receipt/v1'
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const CONTROL_VERBS = new Set(['start', 'stop', 'restart', 'status'])
const ACCEPTED_CONTROL_RESULTS = Object.freeze({ start: 'open', stop: 'close', restart: 'restart_open', status: 'status_noop' })
const REQUESTLESS_CONTROL_FAILURES = new Set([
  'peek_failed',
  'consume_failed',
  'invalid_json',
  'request_not_object',
  'bad_agent_id',
  'bad_verb',
  'bad_nonce',
  'bad_ts',
  'bad_sig',
  'stale',
  'bad_signature',
  'replay',
])
const REQUEST_CONTROL_FAILURES = Object.freeze({
  start: new Set(['consume_failed', 'flight_command_failed']),
  stop: new Set(['consume_failed', 'flight_command_failed']),
  restart: new Set(['consume_failed', 'flight_command_failed']),
  status: new Set(['consume_failed']),
})
const PROBE_VALUES = new Set(['alive', 'dead'])
const CONSUME_VALUES = new Set([
  'consumed',
  'not_configured',
  'not_attempted',
  'inbox_empty',
  'inbox_peek_fail',
  'inbox_handler_fail',
  'inbox_consume_fail',
  'not_attempted_probe_dead',
  'not_attempted_heartbeat_failed',
])
const CONSUME_FAILURES = new Set(['inbox_peek_fail', 'inbox_handler_fail', 'inbox_consume_fail'])
const SERVICE_CHECKS = new Set(['services_loaded_and_running', 'service_operation_failed', 'command_output_secret_free'])
const SERVICE_NAMES = Object.freeze({
  launchd: Object.freeze({ heartbeat: 'com.mumega.mupot-fleet-daemon', control: 'com.mumega.mupot-fleet-control' }),
  systemd: Object.freeze({ heartbeat: 'fleet-daemon.service', control: 'fleet-control-daemon.service' }),
})
const SERVICE_KEYS = Object.freeze(['heartbeat', 'control'])
const PRESERVED_DATA_KEYS = Object.freeze(['configs', 'private_keys', 'runtime', 'inbox', 'receipts'])
const SHA256_RE = /^[a-f0-9]{64}$/
const MAX_TTL_SEC = 86_400
const MAX_GRACE_SEC = 3_600
const MAX_POLL_MS = 60_000
const LINGER_NEXT_STEP = 'run loginctl enable-linger <username> with suitable host privileges, then rerun status'

class ReceiptFailure extends Error {
  constructor(reason, check) {
    super(reason)
    this.reason = reason
    this.check = check
  }
}

function pathArg(value) {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(expanded)
}

function parsedNumber(value, option, { integer = false, min, max }) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    const kind = integer ? 'integer' : 'number'
    throw new Error(`${option} requires a ${kind} from ${min} through ${max}`)
  }
  return parsed
}

function requireOptionValue(argv, index, option) {
  const nextIndex = index + 1
  if (nextIndex >= argv.length || argv[nextIndex].startsWith('-')) throw new Error(`${option} requires a value`)
  return { value: argv[nextIndex], index: nextIndex }
}

export function parseArgs(argv) {
  const opts = {
    agentId: null,
    heartbeatStatePath: join(homedir(), '.fleet', 'state', 'fleet-daemon.json'),
    controlStatePath: join(homedir(), '.fleet', 'state', 'fleet-control.json'),
    serviceManager: 'auto',
    definitionDir: null,
    ttlSec: 180,
    graceSec: 15,
    pollMs: 1_000,
    requireControl: [],
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const result = requireOptionValue(argv, i, arg)
      i = result.index
      return result.value
    }
    if (arg === '--agent') opts.agentId = next()
    else if (arg === '--heartbeat-state') opts.heartbeatStatePath = pathArg(next())
    else if (arg === '--control-state') opts.controlStatePath = pathArg(next())
    else if (arg === '--service-manager') opts.serviceManager = next()
    else if (arg === '--definition-dir') opts.definitionDir = pathArg(next())
    else if (arg === '--ttl-sec') opts.ttlSec = parsedNumber(next(), '--ttl-sec', { min: 1, max: MAX_TTL_SEC })
    else if (arg === '--grace-sec') opts.graceSec = parsedNumber(next(), '--grace-sec', { min: 0, max: MAX_GRACE_SEC })
    else if (arg === '--poll-ms') opts.pollMs = parsedNumber(next(), '--poll-ms', { integer: true, min: 1, max: MAX_POLL_MS })
    else if (arg === '--require-control') {
      const verb = next()
      if (!CONTROL_VERBS.has(verb)) throw new Error('unsupported control verb; expected start, stop, restart, or status')
      opts.requireControl.push(verb)
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (opts.help) return opts
  return validateBuildOptions(opts)
}

function usage() {
  return [
    'Usage: node fleet-runtime/continuous-runtime-receipt.mjs --agent <agent_id> [options]',
    '',
    'Options:',
    '  --agent <agent_id>             selected agent to observe (required)',
    '  --heartbeat-state <path>       heartbeat daemon state file',
    '  --control-state <path>         control daemon state file',
    '  --service-manager <auto|launchd|systemd>',
    '  --definition-dir <path>        service definition directory',
    '  --ttl-sec <seconds>            heartbeat freshness TTL (default: 180)',
    '  --grace-sec <seconds>          observation grace after one heartbeat interval (default: 15)',
    '  --poll-ms <milliseconds>       state poll interval (default: 1000)',
    '  --require-control <verb>       require start, stop, restart, or status; repeatable',
    '  -h, --help                     show this help',
  ].join('\n')
}

function safeString(value) {
  if (typeof value !== 'string') return null
  const redacted = redactSecretValues(value)
  return redacted.secretFound ? null : redacted.text
}

function safeErrorMessage(error) {
  return redactSecretValues(error?.message ?? String(error)).text.slice(0, 500)
}

function normalizeTimestamp(value) {
  const safe = safeString(value)
  if (safe === null) return null
  const ms = Date.parse(safe)
  if (!Number.isFinite(ms)) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function nullableHttpStatus(value) {
  return value === null || (Number.isInteger(value) && value >= 100 && value <= 599)
}

function nullableBoolean(value) {
  return value === null || typeof value === 'boolean'
}

function validateSafePath(value, option, { nullable = false } = {}) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !value || !isAbsolute(value) || safeString(value) === null) {
    throw new Error(`${option} requires a secret-free absolute path`)
  }
  return value
}

function validateObservationOptions(input = {}) {
  const heartbeatStatePath = validateSafePath(input.heartbeatStatePath ?? join(homedir(), '.fleet', 'state', 'fleet-daemon.json'), 'heartbeatStatePath')
  const controlStatePath = validateSafePath(input.controlStatePath ?? join(homedir(), '.fleet', 'state', 'fleet-control.json'), 'controlStatePath')
  const graceSec = input.graceSec ?? 15
  const pollMs = input.pollMs ?? 1_000
  if (typeof graceSec !== 'number') throw new Error('graceSec must be a number')
  if (typeof pollMs !== 'number') throw new Error('pollMs must be a number')
  parsedNumber(graceSec, 'graceSec', { min: 0, max: MAX_GRACE_SEC })
  parsedNumber(pollMs, 'pollMs', { integer: true, min: 1, max: MAX_POLL_MS })
  return { heartbeatStatePath, controlStatePath, graceSec, pollMs }
}

function validateBuildOptions(input = {}) {
  const observation = validateObservationOptions(input)
  const agentId = safeString(input.agentId)
  if (agentId === null || !AGENT_ID_RE.test(agentId)) throw new Error('--agent requires an agent slug')
  const serviceManager = input.serviceManager ?? 'auto'
  if (!['auto', 'launchd', 'systemd'].includes(serviceManager)) throw new Error('unsupported service manager')
  const definitionDir = validateSafePath(input.definitionDir ?? null, 'definitionDir', { nullable: true })
  const ttlSec = input.ttlSec ?? 180
  if (typeof ttlSec !== 'number') throw new Error('ttlSec must be a number')
  parsedNumber(ttlSec, 'ttlSec', { min: 1, max: MAX_TTL_SEC })
  const requireControl = input.requireControl ?? []
  if (!Array.isArray(requireControl) || requireControl.some((verb) => typeof verb !== 'string' || !CONTROL_VERBS.has(verb))) {
    throw new Error('unsupported control verb; expected start, stop, restart, or status')
  }
  return { ...observation, agentId, serviceManager, definitionDir, ttlSec, requireControl: [...requireControl] }
}

function normalizeHeartbeatState(state) {
  if (!isPlainObject(state) || state.schema !== HEARTBEAT_SCHEMA) throw new Error('wrong heartbeat schema')
  const startedAt = normalizeTimestamp(state.started_at)
  const lastTickAt = normalizeTimestamp(state.last_tick_at)
  if (!isPositiveInteger(state.pid) || startedAt === null || lastTickAt === null) throw new Error('invalid heartbeat metadata')
  if (!isNonNegativeInteger(state.tick) || !Number.isFinite(state.interval_sec) || state.interval_sec < 15 || state.interval_sec > 120) {
    throw new Error('invalid heartbeat cadence')
  }
  if (!Array.isArray(state.agents) || state.agents.length === 0) throw new Error('invalid heartbeat agents')
  const seen = new Set()
  const agents = state.agents.map((agent) => {
    if (!isPlainObject(agent)) throw new Error('invalid heartbeat agent')
    const agentId = safeString(agent.agent_id)
    if (agentId === null || !AGENT_ID_RE.test(agentId) || seen.has(agentId)) throw new Error('invalid heartbeat agent id')
    seen.add(agentId)
    if (!PROBE_VALUES.has(agent.probe) || !nullableHttpStatus(agent.heartbeat_status)) throw new Error('invalid heartbeat agent status')
    if (!isNonNegativeInteger(agent.inbox_count) || !CONSUME_VALUES.has(agent.consume)) throw new Error('invalid heartbeat inbox state')
    return {
      agent_id: agentId,
      probe: agent.probe,
      heartbeat_status: agent.heartbeat_status,
      inbox_count: agent.inbox_count,
      consume: agent.consume,
    }
  })
  return {
    schema: HEARTBEAT_SCHEMA,
    pid: state.pid,
    started_at: startedAt,
    interval_sec: state.interval_sec,
    tick: state.tick,
    last_tick_at: lastTickAt,
    agents,
  }
}

function normalizeControlState(state) {
  if (!isPlainObject(state) || state.schema !== CONTROL_SCHEMA) throw new Error('wrong control schema')
  const startedAt = normalizeTimestamp(state.started_at)
  const lastPollAt = normalizeTimestamp(state.last_poll_at)
  if (!isPositiveInteger(state.pid) || startedAt === null || lastPollAt === null) throw new Error('invalid control metadata')
  if (!isNonNegativeInteger(state.poll) || !Number.isFinite(state.poll_sec) || state.poll_sec < 2 || state.poll_sec > 120) {
    throw new Error('invalid control cadence')
  }
  const outcome = state.last_outcome
  if (!isPlainObject(outcome) || ['agent_id', 'verb', 'accepted', 'result'].some((key) => !Object.hasOwn(outcome, key)) || typeof outcome.accepted !== 'boolean') {
    throw new Error('invalid control outcome')
  }
  const rawAgentId = outcome.agent_id
  if (rawAgentId !== null && typeof rawAgentId !== 'string') throw new Error('invalid control agent id')
  const agentId = rawAgentId === null ? null : safeString(rawAgentId)
  if (agentId !== null && !AGENT_ID_RE.test(agentId)) throw new Error('invalid control agent id')
  const verb = outcome.verb
  if (verb !== null && !CONTROL_VERBS.has(verb)) throw new Error('invalid control verb')
  const result = safeString(outcome.result)
  if (result === null) throw new Error('invalid control result')
  const accepted = outcome.accepted
  let validTuple = false
  if (accepted) {
    validTuple = agentId === null && verb === null && result === 'idle'
    if (agentId !== null && verb !== null) validTuple = ACCEPTED_CONTROL_RESULTS[verb] === result
  } else if (agentId === null && verb === null) {
    validTuple = REQUESTLESS_CONTROL_FAILURES.has(result)
  } else if (agentId !== null && verb !== null) {
    validTuple = REQUEST_CONTROL_FAILURES[verb].has(result)
  }
  if (!validTuple) throw new Error('invalid control outcome tuple')
  return {
    schema: CONTROL_SCHEMA,
    pid: state.pid,
    started_at: startedAt,
    poll: state.poll,
    last_poll_at: lastPollAt,
    poll_sec: state.poll_sec,
    last_outcome: { agent_id: agentId, verb, accepted, result },
  }
}

function readState(readRuntimeState, path, kind) {
  let raw
  try {
    raw = readRuntimeState(path)
  } catch {
    throw new ReceiptFailure(`${kind}_state_read_failed`, `${kind}_state_readable`)
  }
  try {
    return kind === 'heartbeat' ? normalizeHeartbeatState(raw) : normalizeControlState(raw)
  } catch {
    throw new ReceiptFailure(`${kind}_state_malformed`, `${kind}_state_v1`)
  }
}

function stateHasAdvance(before, after) {
  return Number.isInteger(before) && Number.isInteger(after) && after > before
}

function clockReader(now) {
  if (typeof now !== 'function') throw new ReceiptFailure('invalid_clock', 'clock_valid')
  let previous = Number.NEGATIVE_INFINITY
  return () => {
    let value
    try {
      value = now()
    } catch {
      throw new ReceiptFailure('invalid_clock', 'clock_valid')
    }
    if (!Number.isFinite(value) || value < previous || Math.abs(value) > 8.64e15) {
      throw new ReceiptFailure('invalid_clock', 'clock_valid')
    }
    previous = value
    return value
  }
}

export async function observeAdvance(input, deps = {}) {
  let opts
  try {
    opts = validateObservationOptions(input)
  } catch {
    throw new ReceiptFailure('invalid_options', 'options_valid')
  }
  const readRuntimeState = deps.readRuntimeState ?? defaultReadRuntimeState
  const sleep = deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  if (typeof readRuntimeState !== 'function' || typeof sleep !== 'function') throw new ReceiptFailure('invalid_options', 'options_valid')
  const readNow = clockReader(deps.now ?? Date.now)
  const beforeHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath, 'heartbeat')
  const beforeControl = readState(readRuntimeState, opts.controlStatePath, 'control')
  const startedMs = readNow()
  const windowMs = (beforeHeartbeat.interval_sec + opts.graceSec) * 1_000
  const deadlineMs = startedMs + windowMs
  if (!Number.isFinite(deadlineMs) || Math.abs(deadlineMs) > 8.64e15) throw new ReceiptFailure('invalid_clock', 'clock_valid')
  const maxIterations = Math.ceil(windowMs / opts.pollMs) + 1
  let afterHeartbeat = beforeHeartbeat
  let afterControl = beforeControl
  let completedMs = startedMs
  let timedOut = false

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const beforeReadMs = readNow()
    if (beforeReadMs >= deadlineMs) {
      completedMs = beforeReadMs
      timedOut = true
      break
    }
    afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath, 'heartbeat')
    afterControl = readState(readRuntimeState, opts.controlStatePath, 'control')
    completedMs = readNow()
    if (completedMs >= deadlineMs) {
      timedOut = true
      break
    }
    if (stateHasAdvance(beforeHeartbeat.tick, afterHeartbeat.tick) && stateHasAdvance(beforeControl.poll, afterControl.poll)) break
    if (iteration === maxIterations - 1) {
      throw new ReceiptFailure('invalid_clock', 'clock_valid')
    }
    const sleepStartedMs = completedMs
    await sleep(Math.min(opts.pollMs, deadlineMs - completedMs))
    completedMs = readNow()
    if (completedMs <= sleepStartedMs) throw new ReceiptFailure('invalid_clock', 'clock_valid')
  }

  // A timeout is already established; final read failures cannot replace its last valid evidence.
  if (timedOut) {
    try { afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath, 'heartbeat') } catch { /* retain prior evidence */ }
    try { afterControl = readState(readRuntimeState, opts.controlStatePath, 'control') } catch { /* retain prior evidence */ }
  } else {
    afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath, 'heartbeat')
    afterControl = readState(readRuntimeState, opts.controlStatePath, 'control')
  }

  return {
    started_ms: startedMs,
    deadline_ms: deadlineMs,
    completed_ms: completedMs,
    timed_out: timedOut,
    heartbeat: { before: beforeHeartbeat, after: afterHeartbeat },
    control: { before: beforeControl, after: afterControl },
  }
}

function serviceReceiptMalformed() {
  throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function safeNonEmptyString(value) {
  const safe = safeString(value)
  return safe !== null && safe.length > 0 ? safe : null
}

function normalizeServiceReceipt(receipt, expectedManager) {
  const topLevelKeys = ['receipt_type', 'generated_at', 'status', 'platform', 'service_manager', 'action', 'definitions', 'services', 'linger', 'commands', 'preserved_data', 'next_steps', 'checks']
  const rawScan = sanitizeReceiptValue(receipt)
  if (rawScan.secretFound || !hasExactKeys(receipt, topLevelKeys)) serviceReceiptMalformed()
  if (receipt.receipt_type !== SERVICE_RECEIPT_TYPE || receipt.action !== 'status') serviceReceiptMalformed()
  if (!['pass', 'fail'].includes(receipt.status) || receipt.service_manager !== expectedManager) serviceReceiptMalformed()
  if (safeNonEmptyString(receipt.platform) === null || normalizeTimestamp(receipt.generated_at) === null) serviceReceiptMalformed()

  if (!Array.isArray(receipt.definitions) || receipt.definitions.length > SERVICE_KEYS.length) serviceReceiptMalformed()
  const definitions = new Set()
  for (const definition of receipt.definitions) {
    if (!hasExactKeys(definition, ['service', 'path', 'sha256']) || !SERVICE_KEYS.includes(definition.service) || definitions.has(definition.service)) serviceReceiptMalformed()
    const path = safeNonEmptyString(definition.path)
    const expectedFile = expectedManager === 'launchd' ? `${SERVICE_NAMES.launchd[definition.service]}.plist` : SERVICE_NAMES.systemd[definition.service]
    if (path === null || !isAbsolute(path) || basename(path) !== expectedFile || !SHA256_RE.test(definition.sha256)) serviceReceiptMalformed()
    definitions.add(definition.service)
  }

  if (!Array.isArray(receipt.services) || receipt.services.length > SERVICE_KEYS.length) serviceReceiptMalformed()
  const expectedNames = SERVICE_NAMES[expectedManager]
  const servicesByKey = new Map()
  for (const service of receipt.services) {
    if (!hasExactKeys(service, ['key', 'name', 'loaded', 'enabled', 'running', 'pid']) || !SERVICE_KEYS.includes(service.key) || servicesByKey.has(service.key)) serviceReceiptMalformed()
    if (safeString(service.name) !== expectedNames[service.key] || !nullableBoolean(service.loaded) || !nullableBoolean(service.enabled) || !nullableBoolean(service.running)) serviceReceiptMalformed()
    if (service.pid !== null && !isPositiveInteger(service.pid)) serviceReceiptMalformed()
    servicesByKey.set(service.key, {
      key: service.key,
      name: expectedNames[service.key],
      loaded: service.loaded,
      enabled: service.enabled,
      running: service.running,
      pid: service.pid,
    })
  }

  if (!Array.isArray(receipt.commands)) serviceReceiptMalformed()
  for (const command of receipt.commands) {
    if (!hasExactKeys(command, ['executable', 'argv', 'code', 'stdout_summary', 'stderr_summary'])) serviceReceiptMalformed()
    if (safeNonEmptyString(command.executable) === null || !Array.isArray(command.argv) || command.argv.some((arg) => safeString(arg) === null)) serviceReceiptMalformed()
    if (!Number.isInteger(command.code) || safeString(command.stdout_summary) === null || safeString(command.stderr_summary) === null) serviceReceiptMalformed()
  }

  if (!hasExactKeys(receipt.preserved_data, PRESERVED_DATA_KEYS) || PRESERVED_DATA_KEYS.some((key) => receipt.preserved_data[key] !== true)) serviceReceiptMalformed()
  if (!Array.isArray(receipt.next_steps) || receipt.next_steps.some((step) => safeNonEmptyString(step) === null)) serviceReceiptMalformed()

  if (!Array.isArray(receipt.checks) || receipt.checks.length !== 2) serviceReceiptMalformed()
  const checks = []
  for (const entry of receipt.checks) {
    const allowedKeys = entry?.check === 'service_operation_failed' ? ['ok', 'check', 'reason'] : ['ok', 'check']
    if (!hasExactKeys(entry, allowedKeys) || !SERVICE_CHECKS.has(entry.check) || typeof entry.ok !== 'boolean') serviceReceiptMalformed()
    if (entry.check === 'service_operation_failed' && (entry.ok !== false || safeNonEmptyString(entry.reason) === null)) serviceReceiptMalformed()
    checks.push({ check: entry.check, ok: entry.ok })
  }
  if (new Set(checks.map((entry) => entry.check)).size !== checks.length) serviceReceiptMalformed()
  const operationalCheck = checks.find((entry) => entry.check === 'services_loaded_and_running')
  const operationFailureCheck = checks.find((entry) => entry.check === 'service_operation_failed')
  const secretCheck = checks.find((entry) => entry.check === 'command_output_secret_free')
  if (secretCheck === undefined || (operationalCheck === undefined) === (operationFailureCheck === undefined)) serviceReceiptMalformed()

  const services = SERVICE_KEYS.flatMap((key) => servicesByKey.has(key) ? [servicesByKey.get(key)] : [])
  if (receipt.status === 'pass') {
    if (definitions.size !== SERVICE_KEYS.length || services.length !== SERVICE_KEYS.length) serviceReceiptMalformed()
    if (services.some((service) => service.loaded !== true || service.running !== true) || operationalCheck?.ok !== true || secretCheck.ok !== true) serviceReceiptMalformed()
  } else if (!checks.some((entry) => entry.ok === false)) {
    serviceReceiptMalformed()
  }

  let linger = null
  if (receipt.linger !== null) {
    if (expectedManager !== 'systemd' || !hasExactKeys(receipt.linger, ['enabled', 'raw'])) serviceReceiptMalformed()
    if (receipt.linger.enabled === null && receipt.linger.raw === null) linger = { enabled: null, raw: null }
    else {
      if (typeof receipt.linger.enabled !== 'boolean') serviceReceiptMalformed()
      const expectedRaw = receipt.linger.enabled ? 'yes' : 'no'
      if (receipt.linger.raw !== expectedRaw) serviceReceiptMalformed()
      linger = { enabled: receipt.linger.enabled, raw: expectedRaw }
    }
  } else if (expectedManager === 'systemd' && receipt.status === 'pass') {
    serviceReceiptMalformed()
  }
  return { status: receipt.status, service_manager: expectedManager, services, linger, checks }
}

function serviceOptions(opts, platformName) {
  const manager = resolveServiceManager(opts.serviceManager, platformName)
  const options = { action: 'status', serviceManager: opts.serviceManager }
  if (opts.definitionDir) {
    if (manager === 'launchd') options.launchdDir = opts.definitionDir
    else options.systemdDir = opts.definitionDir
  }
  return options
}

function check(name, ok, reason) {
  return reason && !ok ? { check: name, ok, reason } : { check: name, ok }
}

function firstFailureReason(checks) {
  return checks.find((entry) => entry.ok === false)?.reason ?? 'continuous_runtime_check_failed'
}

function selectedAgent(state, agentId) {
  const agent = state.agents.find((entry) => entry.agent_id === agentId)
  return agent ?? { agent_id: agentId, probe: null, heartbeat_status: null, inbox_count: null, consume: null }
}

function heartbeatProjection(state) {
  return {
    schema: HEARTBEAT_SCHEMA,
    pid: state.pid,
    started_at: state.started_at,
    interval_sec: state.interval_sec,
    last_tick_at: state.last_tick_at,
  }
}

function controlProjection(state) {
  return {
    schema: CONTROL_SCHEMA,
    pid: state.pid,
    started_at: state.started_at,
    last_poll_at: state.last_poll_at,
    poll_sec: state.poll_sec,
    last_outcome: state.last_outcome,
  }
}

function sanitizeReceiptValue(value) {
  if (typeof value === 'string') {
    const redacted = redactSecretValues(value)
    return { value: redacted.text, secretFound: redacted.secretFound }
  }
  if (Array.isArray(value)) {
    let secretFound = false
    const sanitized = value.map((entry) => {
      const result = sanitizeReceiptValue(entry)
      secretFound ||= result.secretFound
      return result.value
    })
    return { value: sanitized, secretFound }
  }
  if (isPlainObject(value)) {
    let secretFound = false
    const sanitized = {}
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeReceiptValue(entry)
      secretFound ||= result.secretFound
      sanitized[key] = result.value
    }
    return { value: sanitized, secretFound }
  }
  return { value, secretFound: false }
}

function finalizeReceipt(receipt) {
  const sanitized = sanitizeReceiptValue(receipt)
  if (!sanitized.secretFound) return sanitized.value
  sanitized.value.status = 'fail'
  sanitized.value.reason = 'unsafe_evidence'
  sanitized.value.checks.unshift({ check: 'receipt_secret_free', ok: false, reason: 'unsafe_evidence' })
  return sanitized.value
}

function failureTimestamp(now) {
  try {
    const value = now()
    if (Number.isFinite(value) && Math.abs(value) <= 8.64e15) return new Date(value).toISOString()
  } catch {
    // Use a deterministic safe timestamp when the clock itself is invalid.
  }
  return new Date(0).toISOString()
}

function failedReceipt(failure, opts, now) {
  const reason = failure instanceof ReceiptFailure ? failure.reason : 'continuous_runtime_observation_failed'
  const failedCheck = failure instanceof ReceiptFailure ? failure.check : 'continuous_runtime_observation'
  const agentId = safeString(opts?.agentId)
  return finalizeReceipt({
    receipt_type: RECEIPT_TYPE,
    generated_at: failureTimestamp(now),
    status: 'fail',
    reason,
    agent: { agent_id: agentId !== null && AGENT_ID_RE.test(agentId) ? agentId : null, probe: null, heartbeat_status: null, inbox_count: null, consume: null },
    observation: null,
    service: null,
    next_steps: [],
    checks: [{ check: failedCheck, ok: false, reason }],
  })
}

function timeoutReason(timedOut, heartbeatAdvanced, controlAdvanced) {
  if (!timedOut) return null
  if (!heartbeatAdvanced && controlAdvanced) return 'heartbeat_tick_not_advanced'
  if (heartbeatAdvanced && !controlAdvanced) return 'control_poll_not_advanced'
  return 'timeout'
}

export async function buildContinuousRuntimeReceipt(input, deps = {}) {
  const now = deps.now ?? Date.now
  let opts
  try {
    opts = validateBuildOptions(input)
    const observation = await observeAdvance(opts, deps)
    const buildServiceReceipt = deps.buildServiceReceipt ?? defaultBuildServiceReceipt
    if (typeof buildServiceReceipt !== 'function') throw new ReceiptFailure('invalid_options', 'options_valid')
    const servicePlatform = deps.serviceDeps?.platformName ?? process.platform
    const expectedServiceManager = resolveServiceManager(opts.serviceManager, servicePlatform)
    let rawServiceReceipt
    try {
      rawServiceReceipt = await buildServiceReceipt(serviceOptions(opts, servicePlatform), deps.serviceDeps ?? {})
    } catch {
      throw new ReceiptFailure('service_status_failed', 'service_status_readable')
    }
    const services = normalizeServiceReceipt(rawServiceReceipt, expectedServiceManager)
    const heartbeatBefore = observation.heartbeat.before
    const heartbeatAfter = observation.heartbeat.after
    const controlBefore = observation.control.before
    const controlAfter = observation.control.after
    const agent = selectedAgent(heartbeatAfter, opts.agentId)
    const heartbeatAdvanced = stateHasAdvance(heartbeatBefore.tick, heartbeatAfter.tick)
    const controlAdvanced = stateHasAdvance(controlBefore.poll, controlAfter.poll)
    const ageMs = observation.completed_ms - Date.parse(heartbeatAfter.last_tick_at)
    const heartbeatFresh = Number.isFinite(ageMs) && ageMs <= opts.ttlSec * 1_000
    const requiredControlOk = opts.requireControl.length === 0 || (
      controlAfter.last_outcome.agent_id === opts.agentId &&
      controlAfter.last_outcome.accepted === true &&
      opts.requireControl.includes(controlAfter.last_outcome.verb)
    )
    const lingerDisabled = services.service_manager === 'systemd' && services.linger?.enabled === false
    const deadlineFailure = timeoutReason(observation.timed_out, heartbeatAdvanced, controlAdvanced)
    const checks = [
      check('linger_enabled', !lingerDisabled, 'linger_disabled'),
      check('observation_completed_before_deadline', !observation.timed_out, deadlineFailure),
      check('services_running', services.status === 'pass', 'services_not_running'),
      check('heartbeat_tick_advanced', heartbeatAdvanced, 'heartbeat_tick_not_advanced'),
      check('control_poll_advanced', controlAdvanced, 'control_poll_not_advanced'),
      check('agent_probe_alive', agent.probe === 'alive', 'agent_probe_dead'),
      check('signed_heartbeat_2xx', agent.heartbeat_status >= 200 && agent.heartbeat_status < 300, 'heartbeat_not_2xx'),
      check('heartbeat_fresh_under_ttl', heartbeatFresh, 'heartbeat_stale'),
      check('inbox_consume_not_failed', agent.consume !== null && !CONSUME_FAILURES.has(agent.consume), 'inbox_consume_failed'),
    ]
    if (opts.requireControl.length > 0) checks.push(check('required_control_accepted', requiredControlOk, 'required_control_not_accepted'))
    const status = checks.some((entry) => entry.ok === false) ? 'fail' : 'pass'
    return finalizeReceipt({
      receipt_type: RECEIPT_TYPE,
      generated_at: new Date(observation.completed_ms).toISOString(),
      status,
      ...(status === 'fail' ? { reason: firstFailureReason(checks) } : {}),
      agent,
      observation: {
        started_at: new Date(observation.started_ms).toISOString(),
        deadline_at: new Date(observation.deadline_ms).toISOString(),
        timed_out: observation.timed_out,
        heartbeat: { ...heartbeatProjection(heartbeatAfter), tick: { before: heartbeatBefore.tick, after: heartbeatAfter.tick } },
        control: { ...controlProjection(controlAfter), poll: { before: controlBefore.poll, after: controlAfter.poll } },
      },
      service: services,
      next_steps: lingerDisabled ? [LINGER_NEXT_STEP] : [],
      checks,
    })
  } catch (error) {
    const failure = error instanceof ReceiptFailure ? error : new ReceiptFailure('invalid_options', 'options_valid')
    return failedReceipt(failure, opts ?? input, now)
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((value) => process.stdout.write(value))
  const stderr = deps.stderr ?? ((value) => process.stderr.write(value))
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    stderr(`continuous-runtime-receipt: ${safeErrorMessage(error)}\n`)
    stderr(`${usage()}\n`)
    return 2
  }
  if (opts.help) {
    stdout(`${usage()}\n`)
    return 0
  }
  try {
    const receipt = await buildContinuousRuntimeReceipt(opts, deps)
    stdout(`${JSON.stringify(receipt, null, 2)}\n`)
    return receipt.status === 'pass' ? 0 : 1
  } catch (error) {
    stderr(`continuous-runtime-receipt: ${safeErrorMessage(error)}\n`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main()

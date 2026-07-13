#!/usr/bin/env node

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readRuntimeState as defaultReadRuntimeState } from './runtime-state.mjs'
import { buildServiceReceipt as defaultBuildServiceReceipt } from './service-manager.mjs'
import { redactSecretValues, resolveServiceManager } from './service-context.mjs'

const RECEIPT_TYPE = 'mupot-fleet-continuous-runtime-receipt/v1'
const HEARTBEAT_SCHEMA = 'mupot-fleet-daemon-state/v1'
const CONTROL_SCHEMA = 'mupot-fleet-control-state/v1'
const SERVICE_RECEIPT_TYPE = 'mupot-fleet-service-receipt/v1'
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const RESULT_RE = /^[a-z][a-z0-9_]{0,63}$/
const CONTROL_VERBS = new Set(['start', 'stop', 'restart', 'status'])
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
  if (!isPlainObject(state.last_outcome) || typeof state.last_outcome.accepted !== 'boolean') throw new Error('invalid control outcome')
  const rawAgentId = state.last_outcome.agent_id
  const agentId = rawAgentId === null ? null : safeString(rawAgentId)
  if (agentId !== null && !AGENT_ID_RE.test(agentId)) throw new Error('invalid control agent id')
  const verb = state.last_outcome.verb
  if (verb !== null && !CONTROL_VERBS.has(verb)) throw new Error('invalid control verb')
  const result = safeString(state.last_outcome.result)
  if (result === null || !RESULT_RE.test(result)) throw new Error('invalid control result')
  if (state.last_outcome.accepted && (agentId === null || verb === null)) throw new Error('incomplete accepted control outcome')
  return {
    schema: CONTROL_SCHEMA,
    pid: state.pid,
    started_at: startedAt,
    poll: state.poll,
    last_poll_at: lastPollAt,
    poll_sec: state.poll_sec,
    last_outcome: { agent_id: agentId, verb, accepted: state.last_outcome.accepted, result },
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
      timedOut = true
      break
    }
    const sleepStartedMs = completedMs
    await sleep(Math.min(opts.pollMs, deadlineMs - completedMs))
    completedMs = readNow()
    if (completedMs <= sleepStartedMs) throw new ReceiptFailure('invalid_clock', 'clock_valid')
  }

  // Preserve the latest evidence without allowing a post-deadline read to prove success.
  afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath, 'heartbeat')
  afterControl = readState(readRuntimeState, opts.controlStatePath, 'control')

  return {
    started_ms: startedMs,
    deadline_ms: deadlineMs,
    completed_ms: completedMs,
    timed_out: timedOut,
    heartbeat: { before: beforeHeartbeat, after: afterHeartbeat },
    control: { before: beforeControl, after: afterControl },
  }
}

function normalizeServiceReceipt(receipt) {
  if (!isPlainObject(receipt) || receipt.receipt_type !== SERVICE_RECEIPT_TYPE || receipt.action !== 'status') {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  if (!['pass', 'fail'].includes(receipt.status) || !['launchd', 'systemd'].includes(receipt.service_manager)) {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  if (normalizeTimestamp(receipt.generated_at) === null || !Array.isArray(receipt.services) || receipt.services.length !== 2) {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  const expectedNames = SERVICE_NAMES[receipt.service_manager]
  const servicesByKey = new Map()
  for (const service of receipt.services) {
    if (!isPlainObject(service) || !['heartbeat', 'control'].includes(service.key) || servicesByKey.has(service.key)) {
      throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
    }
    if (safeString(service.name) !== expectedNames[service.key] || !nullableBoolean(service.loaded) || !nullableBoolean(service.enabled) || !nullableBoolean(service.running)) {
      throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
    }
    if (service.pid !== null && !isPositiveInteger(service.pid)) throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
    servicesByKey.set(service.key, {
      key: service.key,
      name: expectedNames[service.key],
      loaded: service.loaded,
      enabled: service.enabled,
      running: service.running,
      pid: service.pid,
    })
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== 2 || receipt.checks.some((entry) => !isPlainObject(entry) || !SERVICE_CHECKS.has(entry.check) || typeof entry.ok !== 'boolean')) {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  const checks = receipt.checks.map((entry) => ({ check: entry.check, ok: entry.ok }))
  if (new Set(checks.map((entry) => entry.check)).size !== checks.length) {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  const operationalCheck = checks.find((entry) => entry.check === 'services_loaded_and_running')
  const secretCheck = checks.find((entry) => entry.check === 'command_output_secret_free')
  const services = ['heartbeat', 'control'].map((key) => servicesByKey.get(key))
  if (services.some((service) => service === undefined)) throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  if (receipt.status === 'pass' && (
    services.some((service) => service.loaded !== true || service.running !== true) ||
    operationalCheck?.ok !== true ||
    secretCheck?.ok !== true
  )) {
    throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
  }
  let linger = null
  if (receipt.linger !== null && receipt.linger !== undefined) {
    if (receipt.service_manager !== 'systemd' || !isPlainObject(receipt.linger)) {
      throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
    }
    if (receipt.linger.enabled === null && receipt.linger.raw === null) linger = { enabled: null, raw: null }
    else {
      if (typeof receipt.linger.enabled !== 'boolean') throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
      const expectedRaw = receipt.linger.enabled ? 'yes' : 'no'
      if (receipt.linger.raw !== expectedRaw) throw new ReceiptFailure('service_receipt_malformed', 'service_receipt_v1')
      linger = { enabled: receipt.linger.enabled, raw: expectedRaw }
    }
  }
  return { status: receipt.status, service_manager: receipt.service_manager, services, linger, checks }
}

function serviceOptions(opts) {
  const manager = resolveServiceManager(opts.serviceManager, process.platform)
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
    let rawServiceReceipt
    try {
      rawServiceReceipt = await buildServiceReceipt(serviceOptions(opts), deps.serviceDeps ?? {})
    } catch {
      throw new ReceiptFailure('service_status_failed', 'service_status_readable')
    }
    const services = normalizeServiceReceipt(rawServiceReceipt)
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

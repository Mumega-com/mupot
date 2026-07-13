#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readRuntimeState as defaultReadRuntimeState } from './runtime-state.mjs'
import { buildServiceReceipt as defaultBuildServiceReceipt } from './service-manager.mjs'
import { resolveServiceManager } from './service-context.mjs'

const CONTROL_VERBS = new Set(['start', 'stop', 'restart', 'open', 'close'])
const LINGER_NEXT_STEP = 'run loginctl enable-linger <username> with suitable host privileges, then rerun status'

function pathArg(value) {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(expanded)
}

function positiveNumber(value, option, { integer = false, min = 0 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${option} requires a ${integer ? 'positive integer' : 'positive number'}`)
  }
  return parsed
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
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--agent') opts.agentId = next()
    else if (arg === '--heartbeat-state') opts.heartbeatStatePath = pathArg(next())
    else if (arg === '--control-state') opts.controlStatePath = pathArg(next())
    else if (arg === '--service-manager') {
      const manager = next()
      if (!['auto', 'launchd', 'systemd'].includes(manager)) throw new Error('unsupported service manager')
      opts.serviceManager = manager
    } else if (arg === '--definition-dir') opts.definitionDir = pathArg(next())
    else if (arg === '--ttl-sec') opts.ttlSec = positiveNumber(next(), '--ttl-sec')
    else if (arg === '--grace-sec') opts.graceSec = positiveNumber(next(), '--grace-sec', { min: -1 })
    else if (arg === '--poll-ms') opts.pollMs = positiveNumber(next(), '--poll-ms', { integer: true })
    else if (arg === '--require-control') {
      const verb = next()
      if (!CONTROL_VERBS.has(verb)) throw new Error('unsupported control verb')
      opts.requireControl.push(verb)
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!opts.help && (!opts.agentId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(opts.agentId))) {
    throw new Error('--agent requires an agent slug')
  }
  return opts
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
    '  --require-control <verb>       require the latest accepted control verb; repeatable',
    '  -h, --help                     show this help',
  ].join('\n')
}

function asDateMs(value) {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function readState(readRuntimeState, path) {
  const state = readRuntimeState(path)
  if (!state || typeof state !== 'object') throw new Error('runtime state must be an object')
  return state
}

function heartbeatProjection(state) {
  return {
    schema: state?.schema ?? null,
    pid: Number.isInteger(state?.pid) ? state.pid : null,
    started_at: typeof state?.started_at === 'string' ? state.started_at : null,
    interval_sec: Number.isFinite(state?.interval_sec) ? state.interval_sec : null,
    tick: Number.isInteger(state?.tick) ? state.tick : null,
    last_tick_at: typeof state?.last_tick_at === 'string' ? state.last_tick_at : null,
  }
}

function controlProjection(state) {
  return {
    schema: state?.schema ?? null,
    pid: Number.isInteger(state?.pid) ? state.pid : null,
    started_at: typeof state?.started_at === 'string' ? state.started_at : null,
    poll: Number.isInteger(state?.poll) ? state.poll : null,
    last_poll_at: typeof state?.last_poll_at === 'string' ? state.last_poll_at : null,
    poll_sec: Number.isFinite(state?.poll_sec) ? state.poll_sec : null,
    last_outcome: {
      agent_id: typeof state?.last_outcome?.agent_id === 'string' ? state.last_outcome.agent_id : null,
      verb: typeof state?.last_outcome?.verb === 'string' ? state.last_outcome.verb : null,
      accepted: state?.last_outcome?.accepted === true,
      result: typeof state?.last_outcome?.result === 'string' ? state.last_outcome.result : null,
    },
  }
}

function selectedAgent(state, agentId) {
  const agent = Array.isArray(state?.agents) ? state.agents.find((entry) => entry?.agent_id === agentId) : null
  return {
    agent_id: agentId,
    probe: typeof agent?.probe === 'string' ? agent.probe : null,
    heartbeat_status: Number.isInteger(agent?.heartbeat_status) ? agent.heartbeat_status : null,
    inbox_count: Number.isInteger(agent?.inbox_count) ? agent.inbox_count : null,
    consume: typeof agent?.consume === 'string' ? agent.consume : null,
  }
}

function stateHasAdvance(before, after) {
  return Number.isInteger(before) && Number.isInteger(after) && after > before
}

export async function observeAdvance(opts, deps = {}) {
  const readRuntimeState = deps.readRuntimeState ?? defaultReadRuntimeState
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  const beforeHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath)
  const beforeControl = readState(readRuntimeState, opts.controlStatePath)
  const intervalSec = Number.isFinite(beforeHeartbeat.interval_sec) && beforeHeartbeat.interval_sec > 0 ? beforeHeartbeat.interval_sec : 0
  const startedMs = now()
  const deadlineMs = startedMs + (intervalSec + opts.graceSec) * 1_000
  let afterHeartbeat = beforeHeartbeat
  let afterControl = beforeControl
  let timedOut = false

  while (true) {
    afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath)
    afterControl = readState(readRuntimeState, opts.controlStatePath)
    if (stateHasAdvance(beforeHeartbeat.tick, afterHeartbeat.tick) && stateHasAdvance(beforeControl.poll, afterControl.poll)) break
    const currentMs = now()
    if (currentMs >= deadlineMs) {
      timedOut = true
      break
    }
    await sleep(Math.min(opts.pollMs, deadlineMs - currentMs))
  }

  // Capture final evidence after the bounded observation has ended.
  afterHeartbeat = readState(readRuntimeState, opts.heartbeatStatePath)
  afterControl = readState(readRuntimeState, opts.controlStatePath)

  return {
    started_ms: startedMs,
    deadline_ms: deadlineMs,
    timed_out: timedOut,
    heartbeat: { before: beforeHeartbeat, after: afterHeartbeat },
    control: { before: beforeControl, after: afterControl },
  }
}

function projectServiceReceipt(receipt) {
  return {
    status: receipt?.status === 'pass' ? 'pass' : 'fail',
    service_manager: typeof receipt?.service_manager === 'string' ? receipt.service_manager : null,
    services: (Array.isArray(receipt?.services) ? receipt.services : []).map((service) => ({
      key: typeof service?.key === 'string' ? service.key : null,
      name: typeof service?.name === 'string' ? service.name : null,
      loaded: service?.loaded === true,
      enabled: service?.enabled === true,
      running: service?.running === true,
      pid: Number.isInteger(service?.pid) ? service.pid : null,
    })),
    linger: receipt?.linger && typeof receipt.linger === 'object'
      ? { enabled: receipt.linger.enabled === true ? true : receipt.linger.enabled === false ? false : null, raw: receipt.linger.raw === 'yes' || receipt.linger.raw === 'no' ? receipt.linger.raw : null }
      : null,
    next_steps: Array.isArray(receipt?.next_steps) ? receipt.next_steps.filter((step) => step === LINGER_NEXT_STEP) : [],
    checks: (Array.isArray(receipt?.checks) ? receipt.checks : []).map((check) => ({ check: typeof check?.check === 'string' ? check.check : 'unknown', ok: check?.ok === true })),
  }
}

function serviceOptions(opts) {
  const manager = resolveServiceManager(opts.serviceManager, process.platform)
  const options = { action: 'status', serviceManager: opts.serviceManager }
  if (opts.definitionDir) {
    if (manager === 'launchd') options.launchdDir = opts.definitionDir
    else if (manager === 'systemd') options.systemdDir = opts.definitionDir
  }
  return options
}

function check(check, ok, reason) {
  return reason && !ok ? { check, ok, reason } : { check, ok }
}

function firstFailureReason(checks) {
  return checks.find((entry) => entry.ok === false)?.reason ?? 'continuous_runtime_check_failed'
}

export async function buildContinuousRuntimeReceipt(opts, deps = {}) {
  const now = deps.now ?? Date.now
  const requiredControls = opts.requireControl ?? []
  const observation = await observeAdvance(opts, deps)
  const buildServiceReceipt = deps.buildServiceReceipt ?? defaultBuildServiceReceipt
  const rawServiceReceipt = await buildServiceReceipt(serviceOptions(opts), deps.serviceDeps ?? {})
  const services = projectServiceReceipt(rawServiceReceipt)
  const heartbeatBefore = heartbeatProjection(observation.heartbeat.before)
  const heartbeatAfter = heartbeatProjection(observation.heartbeat.after)
  const controlBefore = controlProjection(observation.control.before)
  const controlAfter = controlProjection(observation.control.after)
  const agent = selectedAgent(observation.heartbeat.after, opts.agentId)
  const heartbeatAdvanced = stateHasAdvance(heartbeatBefore.tick, heartbeatAfter.tick)
  const controlAdvanced = stateHasAdvance(controlBefore.poll, controlAfter.poll)
  const heartbeatFresh = Number.isFinite(asDateMs(heartbeatAfter.last_tick_at)) && now() - asDateMs(heartbeatAfter.last_tick_at) <= opts.ttlSec * 1_000
  const consumeFailed = ['failed', 'consume_failed', 'handler_failed'].includes(agent.consume)
  const requiredControlOk = requiredControls.length === 0 || (
    controlAfter.last_outcome.agent_id === opts.agentId &&
    controlAfter.last_outcome.accepted === true &&
    requiredControls.includes(controlAfter.last_outcome.verb)
  )
  const lingerDisabled = services.service_manager === 'systemd' && services.linger?.enabled === false
  const bothMissing = observation.timed_out && !heartbeatAdvanced && !controlAdvanced
  const checks = [
    check('linger_enabled', !lingerDisabled, 'linger_disabled'),
    check('observation_completed_before_deadline', !bothMissing, 'timeout'),
    check('services_running', services.status === 'pass', 'services_not_running'),
    check('heartbeat_tick_advanced', heartbeatAdvanced, 'heartbeat_tick_not_advanced'),
    check('control_poll_advanced', controlAdvanced, 'control_poll_not_advanced'),
    check('agent_probe_alive', agent.probe === 'alive', 'agent_probe_dead'),
    check('signed_heartbeat_2xx', agent.heartbeat_status >= 200 && agent.heartbeat_status < 300, 'heartbeat_not_2xx'),
    check('heartbeat_fresh_under_ttl', heartbeatFresh, 'heartbeat_stale'),
    check('inbox_consume_not_failed', !consumeFailed, 'inbox_consume_failed'),
  ]
  if (requiredControls.length > 0) checks.push(check('required_control_accepted', requiredControlOk, 'required_control_not_accepted'))

  const status = checks.some((entry) => entry.ok === false) ? 'fail' : 'pass'
  return {
    receipt_type: 'mupot-fleet-continuous-runtime-receipt/v1',
    generated_at: new Date(now()).toISOString(),
    status,
    ...(status === 'fail' ? { reason: firstFailureReason(checks) } : {}),
    agent,
    observation: {
      started_at: new Date(observation.started_ms).toISOString(),
      deadline_at: new Date(observation.deadline_ms).toISOString(),
      timed_out: observation.timed_out,
      heartbeat: { ...heartbeatAfter, tick: { before: heartbeatBefore.tick, after: heartbeatAfter.tick } },
      control: { ...controlAfter, poll: { before: controlBefore.poll, after: controlAfter.poll } },
    },
    service: services,
    next_steps: lingerDisabled ? [LINGER_NEXT_STEP] : [],
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch {
    console.error('continuous-runtime-receipt: invalid options')
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  try {
    const receipt = await buildContinuousRuntimeReceipt(opts)
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status === 'fail') process.exitCode = 1
  } catch {
    console.error('continuous-runtime-receipt: observation failed')
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

#!/usr/bin/env node
// fleet-runtime control receipt — lifecycle control evidence from one authoritative consumer.
//
// host-receipt.mjs proves control-daemon config exists. This command is the
// The default standalone mode performs one signed poll. Active service flows
// use --observe-state so the service daemon remains the sole inbox consumer.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateConfig as validateControlConfig, pollOnce } from './fleet-control-daemon.mjs'
import { importPanelPublicKey, JsonNonceLedger } from './control-request.mjs'
import { loadPrivKey } from './fleet-sign.mjs'
import { readRuntimeState as defaultReadRuntimeState } from './runtime-state.mjs'

const CONTROL_VERBS = new Set(['start', 'stop', 'restart', 'status'])
const SHA256_RE = /^[a-f0-9]{64}$/

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function parseArgs(argv) {
  const opts = {
    controlPath: join(homedir(), '.fleet', 'control.json'),
    observeState: false,
    probePath: '',
    statePath: '',
    verb: '',
    waitSec: 30,
    pollMs: 250,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const nextValue = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--control') opts.controlPath = pathArg(nextValue())
    else if (arg === '--observe-state') opts.observeState = true
    else if (arg === '--probe-receipt') opts.probePath = pathArg(nextValue())
    else if (arg === '--state') opts.statePath = pathArg(nextValue())
    else if (arg === '--verb') {
      opts.verb = nextValue()
      if (!CONTROL_VERBS.has(opts.verb)) throw new Error('unsupported control verb')
    } else if (arg === '--wait-sec') {
      opts.waitSec = Number(nextValue())
      if (!Number.isFinite(opts.waitSec) || opts.waitSec < 0 || opts.waitSec > 600) throw new Error('--wait-sec requires a number from 0 through 600')
    } else if (arg === '--poll-ms') {
      opts.pollMs = Number(nextValue())
      if (!Number.isInteger(opts.pollMs) || opts.pollMs < 10 || opts.pollMs > 60_000) throw new Error('--poll-ms requires an integer from 10 through 60000')
    }
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (opts.observeState && !opts.help && (!opts.probePath || !opts.verb)) {
    throw new Error('--observe-state requires --probe-receipt and --verb')
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/control-receipt.mjs [options]',
    '',
    'Options:',
    '  --control <path>      fleet-control-daemon config (default: ~/.fleet/control.json)',
    '  --observe-state       observe the service daemon state instead of polling its inbox',
    '  --probe-receipt <path> queued cutover-probe receipt (required with --observe-state)',
    '  --state <path>        daemon state file (default: config state_file)',
    '  --verb <verb>         queued control verb to correlate',
    '  --wait-sec <seconds>  maximum observation wait (default: 30)',
    '  --poll-ms <ms>        state observation interval (default: 250)',
    '  -h, --help            show this help',
    '',
    'Default: run one signed control poll. With --observe-state: correlate the queued probe to the service daemon outcome without consuming the inbox.',
  ].join('\n')
}

function readProbe(path, cfg, verb, checks) {
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    const action = Array.isArray(receipt?.actions)
      ? receipt.actions.find((entry) => entry?.kind === 'control_request' && entry?.verb === verb && entry?.ok === true)
      : null
    const valid = receipt?.receipt_type === 'mupot-fleet-cutover-probe/v1' && receipt?.status === 'pass' &&
      receipt?.inputs?.base_url === cfg.baseUrl && typeof receipt?.inputs?.agent === 'string' &&
      action?.target_agent === receipt.inputs.agent && typeof action?.nonce === 'string' && action.nonce.length > 0
    if (!valid) throw new Error('probe receipt does not contain the queued control request')
    const generatedMs = Date.parse(receipt.generated_at)
    if (!Number.isFinite(generatedMs)) throw new Error('probe receipt generated_at is invalid')
    const requestRef = createHash('sha256').update(action.nonce).digest('hex')
    checks.push({ ok: true, component: 'control-receipt', check: 'probe_receipt_valid', path, agent_id: action.target_agent, verb, request_ref: requestRef })
    return { agentId: action.target_agent, requestRef, probeGeneratedAt: receipt.generated_at, probeGeneratedMs: generatedMs }
  } catch (err) {
    checks.push({ ok: false, component: 'control-receipt', check: 'probe_receipt_valid', path, reason: String(err?.message ?? err) })
    return null
  }
}

function validAcceptedState(state, expected, currentMs) {
  const accepted = state?.last_accepted
  const observedMs = Date.parse(accepted?.observed_at)
  const expectedAction = expected.verb === 'start' ? 'open' : expected.verb === 'stop' ? 'close' : expected.verb === 'restart' ? 'restart_open' : 'status_noop'
  return state?.schema === 'mupot-fleet-control-state/v1' && Number.isInteger(state.pid) && state.pid > 0 &&
    Number.isInteger(state.poll) && state.poll >= 0 && Number.isFinite(state.poll_sec) && state.poll_sec >= 2 && state.poll_sec <= 120 &&
    typeof state.started_at === 'string' && !Number.isNaN(Date.parse(state.started_at)) &&
    typeof state.last_poll_at === 'string' && !Number.isNaN(Date.parse(state.last_poll_at)) &&
    accepted?.agent_id === expected.agentId && accepted?.verb === expected.verb && accepted?.result === expectedAction &&
    accepted?.request_ref === expected.requestRef && SHA256_RE.test(accepted.request_ref) &&
    typeof accepted.observed_at === 'string' && Number.isFinite(observedMs) && observedMs >= expected.probeGeneratedMs &&
    observedMs <= currentMs && currentMs - expected.probeGeneratedMs <= 600_000
}

async function observeAcceptedState(opts, cfg, expected, checks) {
  const statePath = opts.statePath || cfg.statePath
  const readRuntimeState = opts.readRuntimeState ?? defaultReadRuntimeState
  const sleep = opts.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.waitSec ?? 30) * 1_000
  const maxReads = Math.ceil(((opts.waitSec ?? 30) * 1_000) / (opts.pollMs ?? 250)) + 1
  let state = null
  let reason = 'matching accepted control state was not observed'
  for (let attempt = 0; attempt < maxReads; attempt += 1) {
    try {
      state = readRuntimeState(statePath)
      if (validAcceptedState(state, expected, now())) {
        checks.push({ ok: true, component: 'control-receipt', check: 'control_state_read', path: statePath, pid: state.pid, poll: state.poll })
        return state
      }
      reason = 'daemon state does not match the queued control request'
    } catch (err) {
      reason = String(err?.message ?? err)
    }
    if (now() >= deadline || attempt === maxReads - 1) break
    await sleep(Math.min(opts.pollMs ?? 250, Math.max(0, deadline - now())))
  }
  checks.push({ ok: false, component: 'control-receipt', check: 'control_state_read', path: statePath, reason })
  return null
}

async function buildStateReceipt(opts, cfg, checks) {
  const expected = cfg ? readProbe(opts.probePath, cfg, opts.verb, checks) : null
  const state = expected ? await observeAcceptedState(opts, cfg, { ...expected, verb: opts.verb }, checks) : null
  const accepted = state?.last_accepted ?? null
  const action = accepted?.result ?? null
  checks.push({
    ok: Boolean(state),
    component: 'fleet-control-daemon',
    check: 'control_request_observed',
    agent_id: expected?.agentId ?? null,
    verb: opts.verb,
    action,
    pid: state?.pid ?? null,
    poll: state?.poll ?? null,
    request_ref: expected?.requestRef ?? null,
  })
  return { expected, state }
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

function readControlConfig(path, checks) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    checks.push({ ok: false, component: 'control-receipt', check: 'control_config_read', path, reason: String(err && err.message ? err.message : err) })
    return null
  }
  try {
    const cfg = validateControlConfig(raw)
    checks.push({ ok: true, component: 'control-receipt', check: 'control_config_valid', path })
    return cfg
  } catch (err) {
    checks.push({ ok: false, component: 'control-receipt', check: 'control_config_valid', path, reason: String(err && err.message ? err.message : err) })
    return null
  }
}

async function loadInputs(cfg, checks, opts) {
  let consumerKey = null
  let publicKey = null
  try {
    consumerKey = await (opts.keyLoader ?? loadPrivKey)(cfg.consumerAgent)
    checks.push({ ok: true, component: 'control-receipt', check: 'consumer_private_key_loaded', agent_id: cfg.consumerAgent })
  } catch (err) {
    checks.push({ ok: false, component: 'control-receipt', check: 'consumer_private_key_loaded', agent_id: cfg.consumerAgent, reason: String(err && err.message ? err.message : err) })
  }

  try {
    const publicKeyText = readFileSync(cfg.panelPublicKeyPath, 'utf8')
    publicKey = await (opts.panelKeyImporter ?? importPanelPublicKey)(publicKeyText)
    checks.push({ ok: true, component: 'control-receipt', check: 'panel_public_key_loaded', path: cfg.panelPublicKeyPath })
  } catch (err) {
    checks.push({ ok: false, component: 'control-receipt', check: 'panel_public_key_loaded', path: cfg.panelPublicKeyPath, reason: String(err && err.message ? err.message : err) })
  }

  return { consumerKey, publicKey }
}

function addPollChecks(result, checks) {
  if (result.action === 'idle') {
    checks.push({ ok: true, component: 'fleet-control-daemon', check: 'signed_control_inbox_peek_ok' })
    checks.push({ ok: null, component: 'fleet-control-daemon', check: 'control_inbox_idle' })
    return
  }
  checks.push({
    ok: result.ok === true,
    component: 'fleet-control-daemon',
    check: 'control_request_executed',
    agent_id: result.request?.agent_id ?? null,
    verb: result.request?.verb ?? null,
    action: result.action,
    status: result.status ?? null,
    retry: result.retry ?? null,
  })
}

export async function buildReceipt(opts) {
  const checks = []
  const cfg = readControlConfig(opts.controlPath, checks)
  let pollResult = null
  let stateEvidence = null

  if (cfg) {
    if (opts.observeState) {
      stateEvidence = await buildStateReceipt(opts, cfg, checks)
      if (stateEvidence.state) {
        pollResult = {
          ok: true,
          action: stateEvidence.state.last_accepted.result,
          request: {
            agent_id: stateEvidence.expected.agentId,
            verb: opts.verb,
            request_ref: stateEvidence.expected.requestRef,
          },
          state: stateEvidence.state,
        }
      }
    } else {
      const { consumerKey, publicKey } = await loadInputs(cfg, checks, opts)
      if (consumerKey && publicKey) {
        const ledger = opts.ledger ?? new JsonNonceLedger(cfg.nonceLedgerPath)
        const poll = opts.pollOnce ?? pollOnce
        pollResult = await poll(cfg, consumerKey, publicKey, ledger, {
          ...(opts.pollOptions ?? {}),
          log: opts.log ?? (() => {}),
        })
        addPollChecks(pollResult, checks)
      } else {
        checks.push({ ok: false, component: 'control-receipt', check: 'poll_inputs_ready' })
      }
    }
  }

  const summary = summarize(checks)
  const generatedAt = new Date((opts.now ?? Date.now)()).toISOString()
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: generatedAt,
    status: summary.status,
    summary,
    inputs: {
      control_config: opts.controlPath,
      consumer_agent: cfg?.consumerAgent ?? null,
      ...(opts.observeState ? {
        evidence_mode: 'daemon_state',
        control_state: opts.statePath || cfg?.statePath || null,
        probe_receipt: opts.probePath,
        probe_generated_at: stateEvidence?.expected?.probeGeneratedAt ?? null,
        request_ref: stateEvidence?.expected?.requestRef ?? null,
      } : {}),
    },
    target: {
      base_url: cfg?.baseUrl ?? null,
      tenant: cfg?.tenant ?? null,
      consumer_agent: cfg?.consumerAgent ?? null,
      executed_agents: pollResult?.request?.agent_id ? [pollResult.request.agent_id] : [],
    },
    checks,
    poll: pollResult,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`control-receipt: ${err && err.message ? err.message : err}`)
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

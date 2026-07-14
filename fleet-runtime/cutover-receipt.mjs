#!/usr/bin/env node
// fleet-runtime cutover receipt — final local gate before removing SOS for an agent.
//
// This command does not touch Mupot. It verifies the JSON receipts produced by
// host-receipt.mjs, runtime-receipt.mjs, and control-receipt.mjs and emits one
// go/no-go receipt for the selected agent(s).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const EXPECTED = {
  host: 'mupot-fleet-host-receipt/v1',
  runtime: 'mupot-fleet-runtime-receipt/v1',
  control: 'mupot-fleet-control-receipt/v1',
}

const CONTROL_VERBS = new Set(['start', 'stop', 'restart'])

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function splitValues(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function parseArgs(argv) {
  const opts = {
    hostPath: '',
    runtimePaths: [],
    controlPaths: [],
    agents: [],
    requiredControlVerbs: ['start', 'stop'],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--host') opts.hostPath = pathArg(next())
    else if (arg === '--runtime') opts.runtimePaths.push(...splitValues(next()).map(pathArg))
    else if (arg === '--control') opts.controlPaths.push(...splitValues(next()).map(pathArg))
    else if (arg === '--agent') opts.agents.push(...splitValues(next()))
    else if (arg === '--require-control-verb') {
      const verbs = splitValues(next())
      for (const verb of verbs) {
        if (!CONTROL_VERBS.has(verb)) throw new Error(`unsupported control verb: ${verb}`)
      }
      opts.requiredControlVerbs = verbs
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/cutover-receipt.mjs --agent <id> --host <host.json> --runtime <runtime.json> --control <control.json> [options]',
    '',
    'Options:',
    '  --agent <id>                  required; repeat or comma-separate for multiple agents',
    '  --host <path>                 host-receipt JSON file',
    '  --runtime <path>              runtime-receipt JSON file; repeatable',
    '  --control <path>              control-receipt JSON file; repeatable',
    '  --require-control-verb <verb> default: start,stop; values: start, stop, restart',
    '  -h, --help                    show this help',
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

function readReceipt(path, label, checks) {
  if (!path) {
    checks.push({ ok: false, component: 'cutover-receipt', check: `${label}_receipt_path_present` })
    return null
  }
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    checks.push({ ok: true, component: 'cutover-receipt', check: `${label}_receipt_read`, path })
    return receipt
  } catch (err) {
    checks.push({ ok: false, component: 'cutover-receipt', check: `${label}_receipt_read`, path, reason: String(err && err.message ? err.message : err) })
    return null
  }
}

function validateReceipt(receipt, label, expectedType, path, checks) {
  if (!receipt) return false
  const typeOk = receipt.receipt_type === expectedType
  checks.push({
    ok: typeOk,
    component: 'cutover-receipt',
    check: `${label}_receipt_type`,
    path,
    expected: expectedType,
    actual: receipt.receipt_type ?? null,
  })
  checks.push({
    ok: receipt.status === 'pass',
    component: 'cutover-receipt',
    check: `${label}_receipt_status_pass`,
    path,
    actual: receipt.status ?? null,
  })
  return typeOk && receipt.status === 'pass'
}

function runtimeAgents(receipt) {
  const agents = new Set()
  for (const agent of receipt?.inputs?.selected_agents ?? []) {
    if (typeof agent === 'string' && agent) agents.add(agent)
  }
  for (const row of receipt?.agents ?? []) {
    if (typeof row?.agent === 'string' && row.agent) agents.add(row.agent)
  }
  return agents
}

function runtimeHasCheck(receipt, check, agentId) {
  return Array.isArray(receipt?.checks) && receipt.checks.some((c) =>
    c?.ok === true &&
    c?.component === 'fleet-daemon' &&
    c?.check === check &&
    c?.agent_id === agentId
  )
}

function controlRuns(receipts) {
  const runs = []
  for (const receipt of receipts) {
    for (const c of receipt?.checks ?? []) {
      if (c?.ok !== true || c?.component !== 'fleet-control-daemon' || !['control_request_executed', 'control_request_observed'].includes(c?.check)) continue
      runs.push({
        agent_id: c.agent_id ?? receipt?.poll?.request?.agent_id ?? null,
        verb: c.verb ?? receipt?.poll?.request?.verb ?? null,
        action: c.action ?? receipt?.poll?.action ?? null,
      })
    }
  }
  return runs
}

function verbSatisfied(run, requiredVerb) {
  if (run.agent_id == null || run.verb == null) return false
  if (requiredVerb === 'start') return run.verb === 'start' || run.verb === 'restart'
  if (requiredVerb === 'stop') return run.verb === 'stop' || run.verb === 'restart'
  return run.verb === requiredVerb
}

export async function buildReceipt(opts) {
  const checks = []
  const requestedAgents = [...new Set(opts.agents ?? [])]
  if (requestedAgents.length === 0) {
    checks.push({ ok: false, component: 'cutover-receipt', check: 'selected_agents_present' })
  }

  const host = readReceipt(opts.hostPath, 'host', checks)
  validateReceipt(host, 'host', EXPECTED.host, opts.hostPath, checks)

  const runtimeReceipts = []
  if ((opts.runtimePaths ?? []).length === 0) {
    checks.push({ ok: false, component: 'cutover-receipt', check: 'runtime_receipt_path_present' })
  }
  for (const path of opts.runtimePaths ?? []) {
    const receipt = readReceipt(path, 'runtime', checks)
    validateReceipt(receipt, 'runtime', EXPECTED.runtime, path, checks)
    if (receipt) runtimeReceipts.push({ path, receipt })
  }

  const controlReceipts = []
  if ((opts.controlPaths ?? []).length === 0) {
    checks.push({ ok: false, component: 'cutover-receipt', check: 'control_receipt_path_present' })
  }
  for (const path of opts.controlPaths ?? []) {
    const receipt = readReceipt(path, 'control', checks)
    validateReceipt(receipt, 'control', EXPECTED.control, path, checks)
    if (receipt) controlReceipts.push({ path, receipt })
  }

  const controlEvidence = controlRuns(controlReceipts.map((r) => r.receipt))
  for (const agentId of requestedAgents) {
    const runtimeForAgent = runtimeReceipts.find(({ receipt }) => runtimeAgents(receipt).has(agentId))
    checks.push({
      ok: Boolean(runtimeForAgent),
      component: 'cutover-receipt',
      check: 'runtime_receipt_for_agent',
      agent_id: agentId,
      path: runtimeForAgent?.path ?? null,
    })
    if (runtimeForAgent) {
      checks.push({
        ok: runtimeHasCheck(runtimeForAgent.receipt, 'signed_attach_ok', agentId),
        component: 'cutover-receipt',
        check: 'runtime_signed_attach_for_agent',
        agent_id: agentId,
        path: runtimeForAgent.path,
      })
      checks.push({
        ok: runtimeHasCheck(runtimeForAgent.receipt, 'signed_inbox_handoff_consumed', agentId),
        component: 'cutover-receipt',
        check: 'runtime_inbox_handoff_for_agent',
        agent_id: agentId,
        path: runtimeForAgent.path,
      })
    }

    for (const requiredVerb of opts.requiredControlVerbs ?? ['start', 'stop']) {
      const match = controlEvidence.find((run) => run.agent_id === agentId && verbSatisfied(run, requiredVerb))
      checks.push({
        ok: Boolean(match),
        component: 'cutover-receipt',
        check: 'control_verb_for_agent',
        agent_id: agentId,
        required_verb: requiredVerb,
        matched_verb: match?.verb ?? null,
        matched_action: match?.action ?? null,
      })
    }
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-sos-cutover-gate/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      agents: requestedAgents,
      host_receipt: opts.hostPath || null,
      runtime_receipts: opts.runtimePaths ?? [],
      control_receipts: opts.controlPaths ?? [],
      required_control_verbs: opts.requiredControlVerbs ?? ['start', 'stop'],
    },
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`cutover-receipt: ${err && err.message ? err.message : err}`)
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

export { parseArgs, summarize, controlRuns }

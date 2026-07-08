#!/usr/bin/env node
// fleet-runtime control receipt — one signed fleet-control poll as JSON evidence.
//
// host-receipt.mjs proves control-daemon config exists. This command is the
// live lifecycle-control gate: it signs one consumer inbox read, verifies a
// queued fleet-control.v1 request, runs the mapped flight verb, consumes the
// request, and emits a receipt.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateConfig as validateControlConfig, pollOnce } from './fleet-control-daemon.mjs'
import { importPanelPublicKey, JsonNonceLedger } from './control-request.mjs'
import { loadPrivKey } from './fleet-sign.mjs'

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function parseArgs(argv) {
  const opts = {
    controlPath: join(homedir(), '.fleet', 'control.json'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a path`)
      return pathArg(argv[i])
    }
    if (arg === '--control') opts.controlPath = next()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/control-receipt.mjs [options]',
    '',
    'Options:',
    '  --control <path>      fleet-control-daemon config (default: ~/.fleet/control.json)',
    '  -h, --help            show this help',
    '',
    'Runs one live control poll: signed inbox read -> verify fleet-control.v1 -> flight verb -> consume.',
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
    action: result.action,
    status: result.status ?? null,
    retry: result.retry ?? null,
  })
}

export async function buildReceipt(opts) {
  const checks = []
  const cfg = readControlConfig(opts.controlPath, checks)
  let pollResult = null

  if (cfg) {
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

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      control_config: opts.controlPath,
      consumer_agent: cfg?.consumerAgent ?? null,
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

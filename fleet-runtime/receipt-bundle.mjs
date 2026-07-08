#!/usr/bin/env node
// fleet-runtime receipt bundle — resumable host-side evidence pack for SOS cutover.
//
// This command runs the existing receipt tools, saves their JSON output under one
// directory, and writes a final cutover-gate receipt plus manifest. It is intended
// for the live host rollout where start/stop control receipts may be gathered in
// separate operator steps.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { buildReceipt as buildHostReceipt } from './host-receipt.mjs'
import { buildReceipt as buildRuntimeReceipt } from './runtime-receipt.mjs'
import { buildReceipt as buildControlReceipt } from './control-receipt.mjs'
import { buildReceipt as buildCutoverReceipt } from './cutover-receipt.mjs'

const EXPECTED = {
  install: 'mupot-fleet-install-receipt/v1',
  probe: 'mupot-fleet-cutover-probe/v1',
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

function defaultStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function splitValues(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function safeName(v) {
  return String(v).replace(/[^A-Za-z0-9_.-]+/g, '_')
}

function parseArgs(argv) {
  const opts = {
    agents: [],
    daemonPath: join(homedir(), '.fleet', 'daemon.json'),
    inboxPath: join(homedir(), '.fleet', 'inbox-handler.json'),
    controlPath: join(homedir(), '.fleet', 'control.json'),
    installReceiptPath: '',
    probeReceiptPaths: [],
    outDir: '',
    controlLabel: '',
    requiredControlVerbs: ['start', 'stop'],
    skipHost: false,
    skipRuntime: false,
    skipControl: false,
    verifyOnly: false,
    execProbes: false,
    force: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--agent') opts.agents.push(...splitValues(next()))
    else if (arg === '--daemon') opts.daemonPath = pathArg(next())
    else if (arg === '--inbox') opts.inboxPath = pathArg(next())
    else if (arg === '--control') opts.controlPath = pathArg(next())
    else if (arg === '--install-receipt') opts.installReceiptPath = pathArg(next())
    else if (arg === '--probe-receipt') opts.probeReceiptPaths.push(...splitValues(next()).map(pathArg))
    else if (arg === '--out-dir') opts.outDir = pathArg(next())
    else if (arg === '--control-label') opts.controlLabel = safeName(next())
    else if (arg === '--require-control-verb') {
      const verbs = splitValues(next())
      for (const verb of verbs) {
        if (!CONTROL_VERBS.has(verb)) throw new Error(`unsupported control verb: ${verb}`)
      }
      opts.requiredControlVerbs = verbs
    } else if (arg === '--skip-host') opts.skipHost = true
    else if (arg === '--skip-runtime') opts.skipRuntime = true
    else if (arg === '--skip-control') opts.skipControl = true
    else if (arg === '--verify-only') {
      opts.verifyOnly = true
      opts.skipHost = true
      opts.skipRuntime = true
      opts.skipControl = true
    }
    else if (arg === '--exec-probes') opts.execProbes = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/receipt-bundle.mjs --agent <id> [options]',
    '',
    'Options:',
    '  --agent <id>                  required; repeat or comma-separate for multiple agents',
    '  --out-dir <path>              bundle directory (default: ~/.fleet/receipts/<timestamp>)',
    '  --daemon <path>               fleet-daemon config (default: ~/.fleet/daemon.json)',
    '  --inbox <path>                inbox-handler config (default: ~/.fleet/inbox-handler.json)',
    '  --control <path>              fleet-control-daemon config (default: ~/.fleet/control.json)',
    '  --install-receipt <path>      optional install.mjs receipt to copy into install.json',
    '  --probe-receipt <path>        optional cutover-probe.mjs receipt; repeat or comma-separate',
    '  --control-label <label>       filename label for this live control receipt, e.g. start or stop',
    '  --skip-host                   reuse existing host.json from the bundle directory',
    '  --skip-runtime                reuse existing runtime-*.json receipts from the bundle directory',
    '  --skip-control                do not run a live control poll; reuse existing control-*.json',
    '  --verify-only                 read-only recheck; reuse host/runtime/control receipts',
    '  --require-control-verb <verb> default: start,stop; values: start, stop, restart',
    '  --exec-probes                 pass through to host-receipt.mjs',
    '  --force                       overwrite same-name receipt files',
    '  -h, --help                    show this help',
    '',
    'Typical sequence:',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --agent my-agent --out-dir ~/.fleet/receipts/my-agent --install-receipt ~/.fleet/receipts/install.json --skip-runtime --skip-control',
    '  queue inbox + start with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-start.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-start.json --skip-host --control-label start',
    '  queue stop with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-stop.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-stop.json --skip-host --skip-runtime --control-label stop',
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

function ensureDir(path, checks) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    checks.push({ ok: true, component: 'receipt-bundle', check: 'out_dir_ready', path })
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'out_dir_ready', path, reason: String(err && err.message ? err.message : err) })
  }
}

function writeJson(path, value, opts, checks, label) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
    checks.push({ ok: true, component: 'receipt-bundle', check: `${label}_receipt_written`, path })
    return true
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: `${label}_receipt_written`, path, reason: String(err && err.message ? err.message : err) })
    return false
  }
}

function writeJsonUnchecked(path, value, opts) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function receiptMeta(path) {
  const receipt = readReceipt(path)
  return {
    path,
    receipt_type: receipt?.receipt_type ?? null,
    status: receipt?.status ?? null,
    sha256: fileSha256(path),
  }
}

function addReceiptStatusCheck(checks, label, path, receipt, expectedType) {
  checks.push({
    ok: receipt?.receipt_type === expectedType,
    component: 'receipt-bundle',
    check: `${label}_receipt_type`,
    path,
    expected: expectedType,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass',
    component: 'receipt-bundle',
    check: `${label}_receipt_status_pass`,
    path,
    actual: receipt?.status ?? null,
  })
}

function addInstallReceiptStatusChecks(checks, path, receipt) {
  checks.push({
    ok: receipt?.receipt_type === EXPECTED.install,
    component: 'receipt-bundle',
    check: 'install_receipt_type',
    path,
    expected: EXPECTED.install,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass' || receipt?.status === 'warn',
    component: 'receipt-bundle',
    check: 'install_receipt_status_non_fail',
    path,
    accepted: ['pass', 'warn'],
    actual: receipt?.status ?? null,
  })
}

function addProbeReceiptStatusChecks(checks, path, receipt) {
  checks.push({
    ok: receipt?.receipt_type === EXPECTED.probe,
    component: 'receipt-bundle',
    check: 'probe_receipt_type',
    path,
    expected: EXPECTED.probe,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass',
    component: 'receipt-bundle',
    check: 'probe_receipt_status_pass',
    path,
    actual: receipt?.status ?? null,
  })
}

async function runAndWrite(label, path, builder, builderOpts, opts, checks) {
  try {
    const receipt = await builder(builderOpts)
    const wrote = writeJson(path, receipt, opts, checks, label)
    if (wrote) addReceiptStatusCheck(checks, label, path, receipt, EXPECTED[label])
    return { path, receipt, wrote }
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: `${label}_receipt_build`, path, reason: String(err && err.message ? err.message : err) })
    return { path, receipt: null, wrote: false }
  }
}

function includeInstallReceipt(outDir, opts, checks) {
  const dest = join(outDir, 'install.json')
  const source = opts.installReceiptPath ? pathArg(opts.installReceiptPath) : ''
  if (!source) {
    if (!existsSync(dest)) return null
    const receipt = readReceipt(dest)
    checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_reused', path: dest })
    addInstallReceiptStatusChecks(checks, dest, receipt)
    return receiptMeta(dest)
  }

  const receipt = readReceipt(source)
  if (!receipt) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'install_receipt_read', path: source, reason: 'invalid_or_unreadable_json' })
    return { path: dest, receipt_type: null, status: null }
  }
  checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_read', path: source })

  if (resolve(source) === resolve(dest)) {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_reused', path: dest })
    addInstallReceiptStatusChecks(checks, dest, receipt)
    return receiptMeta(dest)
  }

  const wrote = writeJson(dest, receipt, opts, checks, 'install')
  if (!wrote) return existsSync(dest) ? receiptMeta(dest) : { path: dest, receipt_type: null, status: null }
  addInstallReceiptStatusChecks(checks, dest, receipt)
  return receiptMeta(dest)
}

function probeDestPath(outDir, source, index) {
  const raw = basename(source || `probe-${index + 1}.json`).replace(/\.json$/i, '')
  const safe = safeName(raw) || `probe-${index + 1}`
  const file = safe.startsWith('probe-') ? `${safe}.json` : `probe-${safe}.json`
  return join(outDir, file)
}

function includeProbeReceipts(outDir, opts, checks) {
  const sources = opts.probeReceiptPaths ?? []
  const metas = []
  if (sources.length === 0) {
    for (const path of listReceiptFiles(outDir, 'probe-')) {
      const receipt = readReceipt(path)
      checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_reused', path })
      addProbeReceiptStatusChecks(checks, path, receipt)
      metas.push(receiptMeta(path))
    }
    return metas
  }

  sources.forEach((source, index) => {
    const dest = probeDestPath(outDir, source, index)
    const receipt = readReceipt(source)
    if (!receipt) {
      checks.push({ ok: false, component: 'receipt-bundle', check: 'probe_receipt_read', path: source, reason: 'invalid_or_unreadable_json' })
      metas.push({ path: dest, receipt_type: null, status: null })
      return
    }
    checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_read', path: source })

    if (resolve(source) === resolve(dest)) {
      checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_reused', path: dest })
      addProbeReceiptStatusChecks(checks, dest, receipt)
      metas.push(receiptMeta(dest))
      return
    }

    const wrote = writeJson(dest, receipt, opts, checks, 'probe')
    if (wrote) addProbeReceiptStatusChecks(checks, dest, receipt)
    metas.push(existsSync(dest) ? receiptMeta(dest) : { path: dest, receipt_type: null, status: null })
  })
  return metas
}

function listReceiptFiles(outDir, prefix) {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => join(outDir, name))
    .sort()
}

function passPaths(paths, expectedType, checks, label) {
  const selected = []
  for (const path of paths) {
    const meta = receiptMeta(path)
    const typeOk = meta.receipt_type === expectedType
    const passOk = meta.status === 'pass'
    if (typeOk && passOk) {
      selected.push(path)
      checks.push({ ok: true, component: 'receipt-bundle', check: `${label}_candidate_selected`, path })
    } else {
      checks.push({
        ok: null,
        component: 'receipt-bundle',
        check: `${label}_candidate_ignored`,
        path,
        receipt_type: meta.receipt_type,
        status: meta.status,
      })
    }
  }
  return selected
}

function hasPassingRuntimeForAgent(artifacts, agentId) {
  const expectedName = `runtime-${safeName(agentId)}.json`
  return (artifacts.runtimes ?? []).some((meta) =>
    meta?.status === 'pass' && typeof meta.path === 'string' && basename(meta.path) === expectedName
  )
}

function missingControlVerbs(gateReceipt) {
  const missing = []
  for (const check of gateReceipt?.checks ?? []) {
    if (check?.component !== 'cutover-receipt') continue
    if (check?.check !== 'control_verb_for_agent' || check?.ok !== false) continue
    const agent = check.agent_id ?? 'unknown-agent'
    const verb = check.required_verb ?? 'required-control'
    missing.push(`${agent}:${verb}`)
  }
  return [...new Set(missing)].sort()
}

function buildNextSteps({ artifacts, agents, gateReceipt, outDir, bundleStatus }) {
  const steps = []
  const add = (text) => {
    if (!steps.includes(text)) steps.push(text)
  }

  if ((agents ?? []).length === 0) {
    add('rerun receipt-bundle with --agent <agent_id>')
  }

  if (!artifacts.install) {
    add(`optional: save installer output as ${join(outDir, 'install.json')} and pass --install-receipt so install evidence travels with the bundle`)
  } else if (artifacts.install.status !== 'pass' && artifacts.install.status !== 'warn') {
    add('rerun fleet-runtime/install.mjs and pass a valid mupot-fleet-install-receipt/v1 with status pass or warn')
  }

  for (const probe of artifacts.probes ?? []) {
    if (probe?.status !== 'pass') {
      add('rerun cutover-probe.mjs for the failed probe and pass the new receipt with --probe-receipt')
    }
  }

  if (artifacts.host?.status !== 'pass') {
    add('edit host configs, place keys, then rerun receipt-bundle without --skip-host until host.json is status pass')
  }

  for (const agentId of agents ?? []) {
    if (!hasPassingRuntimeForAgent(artifacts, agentId)) {
      add(`queue an inbox probe for ${agentId}, then rerun receipt-bundle with --skip-host and --agent ${agentId} until runtime-${safeName(agentId)}.json is status pass`)
    }
  }

  const missingControls = missingControlVerbs(gateReceipt)
  if (missingControls.length > 0) {
    add(`queue missing lifecycle control evidence (${missingControls.join(', ')}) with cutover-probe.mjs, then rerun receipt-bundle with --probe-receipt and --control-label`)
  } else if ((artifacts.controls ?? []).length === 0) {
    add('queue lifecycle control with cutover-probe.mjs and rerun receipt-bundle with --control-label start/stop, or one restart receipt when acceptable')
  }

  if (bundleStatus !== 'pass' || gateReceipt?.status !== 'pass') {
    add('do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass')
  }

  if (bundleStatus === 'pass' && gateReceipt?.status === 'pass') {
    add('attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)')
  }

  return steps
}

async function buildBundle(opts) {
  const checks = []
  const stamp = opts.stamp ?? defaultStamp()
  const outDir = opts.outDir ? pathArg(opts.outDir) : join(homedir(), '.fleet', 'receipts', stamp)
  const agents = [...new Set(opts.agents ?? [])]
  const verifyOnly = Boolean(opts.verifyOnly)
  const skipHost = Boolean(opts.skipHost || verifyOnly)
  const skipRuntime = Boolean(opts.skipRuntime || verifyOnly)
  const skipControl = Boolean(opts.skipControl || verifyOnly)
  checks.push({ ok: agents.length > 0, component: 'receipt-bundle', check: 'selected_agents_present', agents })
  ensureDir(outDir, checks)

  const hostBuilder = opts.hostBuilder ?? buildHostReceipt
  const runtimeBuilder = opts.runtimeBuilder ?? buildRuntimeReceipt
  const controlBuilder = opts.controlBuilder ?? buildControlReceipt
  const cutoverBuilder = opts.cutoverBuilder ?? buildCutoverReceipt

  const artifacts = {
    out_dir: outDir,
    install: null,
    probes: [],
    host: null,
    runtimes: [],
    controls: [],
    cutover_gate: null,
    manifest: join(outDir, 'manifest.json'),
  }

  artifacts.install = includeInstallReceipt(outDir, opts, checks)
  artifacts.probes = includeProbeReceipts(outDir, opts, checks)

  if (!skipHost) {
    const path = join(outDir, 'host.json')
    const result = await runAndWrite('host', path, hostBuilder, {
      daemonPath: opts.daemonPath,
      inboxPath: opts.inboxPath,
      controlPath: opts.controlPath,
      skipInbox: false,
      skipControl: false,
      execProbes: Boolean(opts.execProbes),
      ...(opts.hostOptions ?? {}),
    }, opts, checks)
    artifacts.host = receiptMeta(result.path)
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'host_receipt_reused' })
    artifacts.host = receiptMeta(join(outDir, 'host.json'))
  }

  if (!skipRuntime) {
    for (const agentId of agents) {
      const path = join(outDir, `runtime-${safeName(agentId)}.json`)
      const result = await runAndWrite('runtime', path, runtimeBuilder, {
        daemonPath: opts.daemonPath,
        agents: [agentId],
        ...(opts.runtimeOptions ?? {}),
      }, opts, checks)
      artifacts.runtimes.push({ agent_id: agentId, ...receiptMeta(result.path) })
    }
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'runtime_receipts_reused' })
  }

  if (!skipControl) {
    const label = opts.controlLabel ? safeName(opts.controlLabel) : stamp
    const path = join(outDir, `control-${label}.json`)
    const result = await runAndWrite('control', path, controlBuilder, {
      controlPath: opts.controlPath,
      ...(opts.controlOptions ?? {}),
    }, opts, checks)
    artifacts.controls.push({ label, ...receiptMeta(result.path) })
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'control_receipts_reused' })
  }

  const hostPaths = passPaths([join(outDir, 'host.json')].filter(existsSync), EXPECTED.host, checks, 'host')
  const runtimePaths = passPaths(listReceiptFiles(outDir, 'runtime-'), EXPECTED.runtime, checks, 'runtime')
  const controlPaths = passPaths(listReceiptFiles(outDir, 'control-'), EXPECTED.control, checks, 'control')
  artifacts.host = receiptMeta(join(outDir, 'host.json'))
  artifacts.runtimes = listReceiptFiles(outDir, 'runtime-').map((path) => {
    const meta = receiptMeta(path)
    return { ...meta }
  })
  artifacts.controls = listReceiptFiles(outDir, 'control-').map((path) => {
    const meta = receiptMeta(path)
    return { ...meta }
  })

  const gatePath = join(outDir, 'cutover-gate.json')
  const gateReceipt = await cutoverBuilder({
    agents,
    hostPath: hostPaths[0] ?? '',
    runtimePaths,
    controlPaths,
    requiredControlVerbs: opts.requiredControlVerbs ?? ['start', 'stop'],
  })
  writeJson(gatePath, gateReceipt, { ...opts, force: true }, checks, 'cutover')
  checks.push({
    ok: gateReceipt.status === 'pass',
    component: 'receipt-bundle',
    check: 'cutover_gate_status_pass',
    path: gatePath,
    actual: gateReceipt.status,
  })
  artifacts.cutover_gate = receiptMeta(gatePath)

  const summary = summarize(checks)
  const bundle = {
    receipt_type: 'mupot-fleet-receipt-bundle/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    integrity: {
      algorithm: 'sha256',
      covers: 'receipt artifact files',
      excludes: ['manifest.json'],
    },
    inputs: {
      agents,
      out_dir: outDir,
      daemon_config: opts.daemonPath,
      inbox_handler_config: opts.inboxPath,
      control_config: opts.controlPath,
      install_receipt: opts.installReceiptPath || null,
      probe_receipts: opts.probeReceiptPaths ?? [],
      control_label: opts.controlLabel || null,
      required_control_verbs: opts.requiredControlVerbs ?? ['start', 'stop'],
      exec_probes: Boolean(opts.execProbes),
      verify_only: verifyOnly,
      skip_host: skipHost,
      skip_runtime: skipRuntime,
      skip_control: skipControl,
    },
    artifacts,
    next_steps: [],
    checks,
  }
  try {
    writeJsonUnchecked(artifacts.manifest, bundle, { ...opts, force: true })
    checks.push({ ok: true, component: 'receipt-bundle', check: 'manifest_written', path: artifacts.manifest })
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'manifest_written', path: artifacts.manifest, reason: String(err && err.message ? err.message : err) })
  }
  const finalSummary = summarize(checks)
  bundle.summary = finalSummary
  bundle.status = finalSummary.status
  bundle.next_steps = buildNextSteps({
    artifacts,
    agents,
    gateReceipt,
    outDir,
    bundleStatus: finalSummary.status,
  })
  try {
    writeJsonUnchecked(artifacts.manifest, bundle, { ...opts, force: true })
  } catch {
    // The recorded manifest_written check above already captures the failure.
  }
  return bundle
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`receipt-bundle: ${err && err.message ? err.message : err}`)
    console.error(usage())
    process.exit(2)
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const bundle = await buildBundle(opts)
  console.log(JSON.stringify(bundle, null, 2))
  process.exit(bundle.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { buildBundle, defaultStamp, parseArgs, safeName, summarize }

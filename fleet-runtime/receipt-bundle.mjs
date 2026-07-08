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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
  cutover_gate: 'mupot-sos-cutover-gate/v1',
}

const NEXT_STEP_ATTACH = 'attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)'
const NEXT_STEP_HOLD = 'do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass'

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
    manifestPath: '',
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
    else if (arg === '--manifest') opts.manifestPath = pathArg(next())
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
    else if (arg === '--check-manifest') opts.checkManifest = true
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
    '  --manifest <path>             manifest path for --check-manifest',
    '  --skip-host                   reuse existing host.json from the bundle directory',
    '  --skip-runtime                reuse existing runtime-*.json receipts from the bundle directory',
    '  --skip-control                do not run a live control poll; reuse existing control-*.json',
    '  --verify-only                 read-only recheck; reuse host/runtime/control receipts',
    '  --check-manifest              read-only hash/status check; writes nothing',
    '  --require-control-verb <verb> default: start,stop; values: start, stop, restart',
    '  --exec-probes                 pass through to host-receipt.mjs',
    '  --force                       overwrite same-name receipt files',
    '  -h, --help                    show this help',
    '',
    'Typical sequence:',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --agent my-agent --out-dir ~/.fleet/receipts/my-agent --install-receipt ~/.fleet/receipts/install.json --skip-runtime --skip-control',
    '  queue inbox + start with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-start.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-start.json --skip-host --control-label start',
    '  queue stop with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-stop.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-stop.json --skip-host --skip-runtime --control-label stop',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --out-dir ~/.fleet/receipts/my-agent --check-manifest',
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

function manifestPathForCheck(opts) {
  if (opts.manifestPath) return pathArg(opts.manifestPath)
  if (opts.outDir) return join(pathArg(opts.outDir), 'manifest.json')
  return ''
}

function resolveArtifactPath(manifestDir, declaredPath) {
  if (typeof declaredPath !== 'string' || declaredPath.length === 0) return ''
  const localPath = join(manifestDir, basename(declaredPath))
  if (existsSync(localPath)) return localPath
  if (declaredPath.startsWith('~/') || isAbsolute(declaredPath)) return pathArg(declaredPath)
  return resolve(manifestDir, declaredPath)
}

function bundleArtifactEntries(manifest) {
  const artifacts = manifest?.artifacts ?? {}
  const entries = []
  const add = (label, meta) => {
    if (!meta || typeof meta !== 'object') return
    entries.push({
      label,
      path: meta.path,
      sha256: meta.sha256 ?? null,
      receipt_type: meta.receipt_type ?? null,
      status: meta.status ?? null,
    })
  }

  add('install', artifacts.install)
  for (const [index, probe] of (artifacts.probes ?? []).entries()) add(`probe:${index + 1}`, probe)
  add('host', artifacts.host)
  for (const [index, runtime] of (artifacts.runtimes ?? []).entries()) add(`runtime:${index + 1}`, runtime)
  for (const [index, control] of (artifacts.controls ?? []).entries()) add(`control:${index + 1}`, control)
  add('cutover_gate', artifacts.cutover_gate)
  return entries
}

function expectedArtifactType(label) {
  if (label === 'install') return EXPECTED.install
  if (label.startsWith('probe:')) return EXPECTED.probe
  if (label === 'host') return EXPECTED.host
  if (label.startsWith('runtime:')) return EXPECTED.runtime
  if (label.startsWith('control:')) return EXPECTED.control
  if (label === 'cutover_gate') return EXPECTED.cutover_gate
  return null
}

function artifactStatusOk(label, status) {
  if (label === 'install') return status === 'pass' || status === 'warn'
  return status === 'pass'
}

function receiptBaseUrl(label, receipt) {
  if (label.startsWith('probe:')) return receipt?.inputs?.base_url ?? null
  return receipt?.target?.base_url ?? null
}

function receiptTenant(label, receipt) {
  if (label.startsWith('probe:')) return null
  return receipt?.target?.tenant ?? null
}

function receiptTargetAgents(label, receipt) {
  const agents = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) agents.push(value)
  }
  if (label.startsWith('probe:')) {
    add(receipt?.inputs?.agent)
    for (const action of receipt?.actions ?? []) {
      add(action?.target_agent)
      add(action?.agent_id)
    }
  } else if (label.startsWith('runtime:')) {
    for (const agent of receipt?.target?.agents ?? []) add(agent)
    for (const agent of receipt?.inputs?.selected_agents ?? []) add(agent)
    for (const result of receipt?.agents ?? []) add(result?.agent)
  } else if (label.startsWith('control:')) {
    for (const agent of receipt?.target?.executed_agents ?? []) add(agent)
    add(receipt?.poll?.request?.agent_id)
    for (const check of receipt?.checks ?? []) {
      if (check?.component === 'fleet-control-daemon' && check?.check === 'control_request_executed') {
        add(check?.agent_id)
      }
    }
  } else if (label === 'host') {
    for (const agent of receipt?.target?.daemon_agents ?? []) add(agent)
  }
  return sortStrings(agents)
}

function addTargetConsistencyChecks(checks, manifestPath, entries, receiptRecords, agents) {
  const targetLabels = new Set(['host'])
  for (const entry of entries) {
    if (entry.label.startsWith('probe:') || entry.label.startsWith('runtime:') || entry.label.startsWith('control:')) {
      targetLabels.add(entry.label)
    }
  }

  const baseUrlRecords = []
  const tenantRecords = []
  for (const record of receiptRecords) {
    if (!targetLabels.has(record.label)) continue
    const baseUrl = receiptBaseUrl(record.label, record.receipt)
    const tenant = receiptTenant(record.label, record.receipt)
    checks.push({
      ok: typeof baseUrl === 'string' && baseUrl.length > 0,
      component: 'receipt-bundle-check',
      check: 'artifact_target_base_url_recorded',
      path: manifestPath,
      artifact: record.label,
      base_url: baseUrl,
    })
    if (baseUrl) baseUrlRecords.push({ label: record.label, value: baseUrl })

    if (!record.label.startsWith('probe:')) {
      checks.push({
        ok: typeof tenant === 'string' && tenant.length > 0,
        component: 'receipt-bundle-check',
        check: 'artifact_target_tenant_recorded',
        path: manifestPath,
        artifact: record.label,
        tenant,
      })
      if (tenant) tenantRecords.push({ label: record.label, value: tenant })
    }
  }

  const baseUrls = sortStrings(baseUrlRecords.map((entry) => entry.value))
  checks.push({
    ok: baseUrls.length === 1,
    component: 'receipt-bundle-check',
    check: 'artifact_target_base_urls_match',
    path: manifestPath,
    base_urls: baseUrls,
    artifacts: baseUrlRecords.map((entry) => entry.label),
  })

  const tenants = sortStrings(tenantRecords.map((entry) => entry.value))
  checks.push({
    ok: tenants.length === 1,
    component: 'receipt-bundle-check',
    check: 'artifact_target_tenants_match',
    path: manifestPath,
    tenants,
    artifacts: tenantRecords.map((entry) => entry.label),
  })

  const selected = new Set(agents)
  for (const record of receiptRecords) {
    const targetAgents = receiptTargetAgents(record.label, record.receipt)
    if (!(record.label.startsWith('probe:') || record.label.startsWith('runtime:') || record.label.startsWith('control:'))) continue
    checks.push({
      ok: targetAgents.length > 0 && targetAgents.every((agent) => selected.has(agent)),
      component: 'receipt-bundle-check',
      check: 'artifact_target_agents_selected',
      path: manifestPath,
      artifact: record.label,
      agents: targetAgents,
      selected_agents: sortStrings(agents),
    })
  }

  const passingProbeRecords = receiptRecords.filter((record) => record.label.startsWith('probe:') && record.receipt?.status === 'pass')
  for (const agentId of agents) {
    checks.push({
      ok: passingProbeRecords.some((record) => receiptTargetAgents(record.label, record.receipt).includes(agentId)),
      component: 'receipt-bundle-check',
      check: 'probe_artifact_for_agent',
      path: manifestPath,
      agent_id: agentId,
    })
  }
}

function sameSummary(actual, expected) {
  return actual?.status === expected?.status &&
    actual?.passed === expected?.passed &&
    actual?.failed === expected?.failed &&
    actual?.warnings === expected?.warnings
}

function nextSteps(manifest) {
  return Array.isArray(manifest?.next_steps) ? manifest.next_steps.filter((step) => typeof step === 'string') : []
}

function addNextStepChecks(checks, manifestPath, manifest, hardGateSummary) {
  const steps = nextSteps(manifest)
  const ready = hardGateSummary?.status === 'pass'
  checks.push({
    ok: Array.isArray(manifest?.next_steps),
    component: 'receipt-bundle-check',
    check: 'next_steps_present',
    path: manifestPath,
    count: steps.length,
  })
  checks.push({
    ok: !ready || steps.includes(NEXT_STEP_ATTACH),
    component: 'receipt-bundle-check',
    check: 'next_steps_attach_when_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: ready || !steps.includes(NEXT_STEP_ATTACH),
    component: 'receipt-bundle-check',
    check: 'next_steps_no_attach_when_not_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: ready || steps.includes(NEXT_STEP_HOLD),
    component: 'receipt-bundle-check',
    check: 'next_steps_hold_when_not_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: !ready || !steps.includes(NEXT_STEP_HOLD),
    component: 'receipt-bundle-check',
    check: 'next_steps_no_hold_when_ready',
    path: manifestPath,
    ready,
  })
}

function manifestAgents(manifest) {
  return Array.isArray(manifest?.inputs?.agents) ? manifest.inputs.agents.filter(Boolean) : []
}

function manifestRequiredControlVerbs(manifest) {
  return Array.isArray(manifest?.inputs?.required_control_verbs)
    ? manifest.inputs.required_control_verbs.filter(Boolean)
    : ['start', 'stop']
}

function hasArtifact(entries, predicate) {
  return entries.some((entry) => predicate(entry))
}

function sortStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.length > 0))].sort()
}

function sameStringSet(a, b) {
  return JSON.stringify(sortStrings(a)) === JSON.stringify(sortStrings(b))
}

function artifactBasenames(entries, predicate) {
  return entries
    .filter((entry) => predicate(entry))
    .map((entry) => typeof entry.path === 'string' ? basename(entry.path) : '')
    .filter(Boolean)
}

function receiptInputBasenames(paths) {
  return (paths ?? [])
    .map((path) => typeof path === 'string' ? basename(path) : '')
    .filter(Boolean)
}

function addRequiredEvidenceChecks(checks, manifestPath, entries, agents) {
  const probeEntries = entries.filter((entry) => entry.label.startsWith('probe:'))
  const runtimeEntries = entries.filter((entry) => entry.label.startsWith('runtime:'))
  const controlEntries = entries.filter((entry) => entry.label.startsWith('control:'))
  checks.push({
    ok: agents.length > 0,
    component: 'receipt-bundle-check',
    check: 'selected_agents_recorded',
    path: manifestPath,
    agents,
  })
  checks.push({
    ok: hasArtifact(entries, (entry) => entry.label === 'host'),
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'host',
  })
  checks.push({
    ok: probeEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'probe',
    count: probeEntries.length,
  })
  checks.push({
    ok: runtimeEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'runtime',
    count: runtimeEntries.length,
  })
  checks.push({
    ok: controlEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'control',
    count: controlEntries.length,
  })
  checks.push({
    ok: hasArtifact(entries, (entry) => entry.label === 'cutover_gate'),
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'cutover_gate',
  })

  for (const agentId of agents) {
    const expectedRuntime = `runtime-${safeName(agentId)}.json`
    checks.push({
      ok: runtimeEntries.some((entry) => typeof entry.path === 'string' && basename(entry.path) === expectedRuntime),
      component: 'receipt-bundle-check',
      check: 'runtime_artifact_for_agent',
      path: manifestPath,
      agent_id: agentId,
      expected_file: expectedRuntime,
    })
  }
}

function addCutoverGateConsistencyChecks(checks, manifestPath, manifest, entries, receipt) {
  const agents = manifestAgents(manifest)
  const requiredControlVerbs = manifestRequiredControlVerbs(manifest)
  const passingArtifact = (kind) => (entry) =>
    expectedArtifactType(entry.label) === kind && entry.status === 'pass'
  const expectedHost = artifactBasenames(entries, (entry) => entry.label === 'host' && passingArtifact(EXPECTED.host)(entry))
  const actualHost = receipt?.inputs?.host_receipt ? [basename(receipt.inputs.host_receipt)] : []
  const expectedRuntimes = artifactBasenames(entries, passingArtifact(EXPECTED.runtime))
  const actualRuntimes = receiptInputBasenames(receipt?.inputs?.runtime_receipts)
  const expectedControls = artifactBasenames(entries, passingArtifact(EXPECTED.control))
  const actualControls = receiptInputBasenames(receipt?.inputs?.control_receipts)

  checks.push({
    ok: sameStringSet(receipt?.inputs?.agents, agents),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_agents_match_manifest',
    path: manifestPath,
    expected: sortStrings(agents),
    actual: sortStrings(receipt?.inputs?.agents),
  })
  checks.push({
    ok: sameStringSet(receipt?.inputs?.required_control_verbs, requiredControlVerbs),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_required_control_verbs_match_manifest',
    path: manifestPath,
    expected: sortStrings(requiredControlVerbs),
    actual: sortStrings(receipt?.inputs?.required_control_verbs),
  })
  checks.push({
    ok: sameStringSet(actualHost, expectedHost),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_host_artifact_matches_manifest',
    path: manifestPath,
    expected: sortStrings(expectedHost),
    actual: sortStrings(actualHost),
  })
  checks.push({
    ok: sameStringSet(actualRuntimes, expectedRuntimes),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_runtime_artifacts_match_manifest',
    path: manifestPath,
    expected: sortStrings(expectedRuntimes),
    actual: sortStrings(actualRuntimes),
  })
  checks.push({
    ok: sameStringSet(actualControls, expectedControls),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_control_artifacts_match_manifest',
    path: manifestPath,
    expected: sortStrings(expectedControls),
    actual: sortStrings(actualControls),
  })
}

function checkBundleManifest(opts = {}) {
  const checks = []
  const manifestPath = manifestPathForCheck(opts)
  const manifestDir = manifestPath ? dirname(manifestPath) : ''
  let manifest = null

  checks.push({
    ok: Boolean(manifestPath),
    component: 'receipt-bundle-check',
    check: 'manifest_path_selected',
    path: manifestPath || null,
  })

  if (manifestPath) {
    manifest = readReceipt(manifestPath)
    checks.push({
      ok: Boolean(manifest),
      component: 'receipt-bundle-check',
      check: 'manifest_read',
      path: manifestPath,
    })
  }

  if (manifest) {
    const manifestChecks = Array.isArray(manifest.checks) ? manifest.checks : null
    const computedManifestSummary = manifestChecks ? summarize(manifestChecks) : null
    checks.push({
      ok: manifest.receipt_type === 'mupot-fleet-receipt-bundle/v1',
      component: 'receipt-bundle-check',
      check: 'manifest_receipt_type',
      path: manifestPath,
      expected: 'mupot-fleet-receipt-bundle/v1',
      actual: manifest.receipt_type ?? null,
    })
    checks.push({
      ok: manifest.status === 'pass',
      component: 'receipt-bundle-check',
      check: 'manifest_status_pass',
      path: manifestPath,
      actual: manifest.status ?? null,
    })
    checks.push({
      ok: manifest.integrity?.algorithm === 'sha256',
      component: 'receipt-bundle-check',
      check: 'manifest_integrity_algorithm',
      path: manifestPath,
      expected: 'sha256',
      actual: manifest.integrity?.algorithm ?? null,
    })
    checks.push({
      ok: Boolean(manifestChecks),
      component: 'receipt-bundle-check',
      check: 'manifest_checks_present',
      path: manifestPath,
      count: manifestChecks?.length ?? 0,
    })
    checks.push({
      ok: computedManifestSummary?.status === manifest.status,
      component: 'receipt-bundle-check',
      check: 'manifest_status_matches_checks',
      path: manifestPath,
      expected: computedManifestSummary?.status ?? null,
      actual: manifest.status ?? null,
    })
    checks.push({
      ok: sameSummary(manifest.summary, computedManifestSummary),
      component: 'receipt-bundle-check',
      check: 'manifest_summary_matches_checks',
      path: manifestPath,
      expected: computedManifestSummary,
      actual: manifest.summary ?? null,
    })
    const entries = bundleArtifactEntries(manifest)
    const agents = manifestAgents(manifest)
    const receiptRecords = []
    checks.push({
      ok: entries.length > 0,
      component: 'receipt-bundle-check',
      check: 'artifact_entries_present',
      path: manifestPath,
      count: entries.length,
    })
    addRequiredEvidenceChecks(checks, manifestPath, entries, agents)

    for (const entry of entries) {
      const checkedPath = resolveArtifactPath(manifestDir, entry.path)
      const receipt = checkedPath ? readReceipt(checkedPath) : null
      if (receipt) receiptRecords.push({ label: entry.label, receipt, checkedPath })
      const actual = checkedPath ? fileSha256(checkedPath) : null
      const expectedOk = typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
      const expectedType = expectedArtifactType(entry.label)
      checks.push({
        ok: typeof entry.path === 'string' && entry.path.length > 0,
        component: 'receipt-bundle-check',
        check: 'artifact_path_recorded',
        artifact: entry.label,
        declared_path: entry.path ?? null,
      })
      checks.push({
        ok: expectedOk,
        component: 'receipt-bundle-check',
        check: 'artifact_sha256_recorded',
        artifact: entry.label,
        declared_path: entry.path ?? null,
      })
      checks.push({
        ok: Boolean(actual),
        component: 'receipt-bundle-check',
        check: 'artifact_file_readable',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
      })
      checks.push({
        ok: expectedOk && actual === entry.sha256,
        component: 'receipt-bundle-check',
        check: 'artifact_sha256_match',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.sha256,
        actual,
      })
      checks.push({
        ok: Boolean(receipt),
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_json_read',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
      })
      checks.push({
        ok: receipt?.receipt_type === entry.receipt_type,
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_type_matches_manifest',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.receipt_type,
        actual: receipt?.receipt_type ?? null,
      })
      checks.push({
        ok: !expectedType || receipt?.receipt_type === expectedType,
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_type_expected',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: expectedType,
        actual: receipt?.receipt_type ?? null,
      })
      checks.push({
        ok: receipt?.status === entry.status,
        component: 'receipt-bundle-check',
        check: 'artifact_status_matches_manifest',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.status,
        actual: receipt?.status ?? null,
      })
      checks.push({
        ok: artifactStatusOk(entry.label, receipt?.status),
        component: 'receipt-bundle-check',
        check: 'artifact_status_cutover_ready',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        actual: receipt?.status ?? null,
        accepted: entry.label === 'install' ? ['pass', 'warn'] : ['pass'],
      })
      if (entry.label === 'cutover_gate' && receipt) {
        addCutoverGateConsistencyChecks(checks, manifestPath, manifest, entries, receipt)
      }
    }

    addTargetConsistencyChecks(checks, manifestPath, entries, receiptRecords, agents)
    addNextStepChecks(checks, manifestPath, manifest, summarize(checks))
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-receipt-bundle-check/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      manifest: manifestPath || null,
      out_dir: opts.outDir ? pathArg(opts.outDir) : null,
    },
    manifest: manifest ? {
      path: manifestPath,
      receipt_type: manifest.receipt_type ?? null,
      status: manifest.status ?? null,
      generated_at: manifest.generated_at ?? null,
      sha256: fileSha256(manifestPath),
    } : null,
    checks,
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

  if ((artifacts.probes ?? []).length === 0) {
    add('queue inbox and lifecycle evidence with cutover-probe.mjs, save probe-*.json, and rerun receipt-bundle with --probe-receipt')
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
    add(NEXT_STEP_HOLD)
  }

  if (bundleStatus === 'pass' && gateReceipt?.status === 'pass') {
    add(NEXT_STEP_ATTACH)
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
  checks.push({
    ok: artifacts.probes.some((probe) => probe?.status === 'pass'),
    component: 'receipt-bundle',
    check: 'probe_receipt_present',
    count: artifacts.probes.length,
  })

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

  const targetEntries = bundleArtifactEntries({ artifacts })
  const targetReceiptRecords = []
  for (const entry of targetEntries) {
    const receipt = readReceipt(entry.path)
    if (receipt) targetReceiptRecords.push({ label: entry.label, receipt, checkedPath: entry.path })
  }
  addTargetConsistencyChecks(checks, artifacts.manifest, targetEntries, targetReceiptRecords, agents)

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
  if (opts.checkManifest) {
    const receipt = checkBundleManifest(opts)
    console.log(JSON.stringify(receipt, null, 2))
    process.exit(receipt.status === 'fail' ? 1 : 0)
  }
  const bundle = await buildBundle(opts)
  console.log(JSON.stringify(bundle, null, 2))
  process.exit(bundle.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { buildBundle, checkBundleManifest, defaultStamp, parseArgs, safeName, summarize }

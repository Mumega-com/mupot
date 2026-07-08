// node --test receipt-bundle.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBundle, checkBundleManifest, parseArgs, safeName } from './receipt-bundle.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-receipt-bundle-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return path
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function installReceipt(status = 'warn') {
  return {
    receipt_type: 'mupot-fleet-install-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status,
    summary: { status, passed: 1, failed: 0, warnings: status === 'warn' ? 1 : 0 },
    checks: [
      { ok: status === 'warn' ? null : true, component: 'fleet-install', check: 'config_needs_edit' },
    ],
  }
}

function probeReceipt(status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-08T00:00:30.000Z',
    status,
    summary: { status, passed: status === 'pass' ? 2 : 1, failed: status === 'pass' ? 0 : 1, warnings: 0 },
    actions: [
      { kind: 'inbox_probe', target_agent: 'agent-one', request_id: 'probe-1-inbox', ok: status === 'pass' },
      { kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: status === 'pass' },
    ],
    checks: [
      { ok: status === 'pass', component: 'cutover-probe', check: 'inbox_probe_queued' },
    ],
  }
}

function hostReceipt(status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-host-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status,
    summary: { status, passed: 1, failed: status === 'pass' ? 0 : 1, warnings: 0 },
    checks: [],
  }
}

function runtimeReceipt(agentId, status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: '2026-07-08T00:01:00.000Z',
    status,
    inputs: { selected_agents: [agentId] },
    agents: [{ agent: agentId }],
    checks: [
      { ok: true, component: 'fleet-daemon', check: 'signed_attach_ok', agent_id: agentId },
      { ok: true, component: 'fleet-daemon', check: 'signed_inbox_handoff_consumed', agent_id: agentId },
    ],
  }
}

function controlReceipt(agentId, verb, status = 'pass') {
  const action = verb === 'start' ? 'open' : verb === 'stop' ? 'close' : 'restart_open'
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: '2026-07-08T00:02:00.000Z',
    status,
    checks: [
      { ok: true, component: 'fleet-control-daemon', check: 'control_request_executed', agent_id: agentId, verb, action },
    ],
    poll: { ok: true, action, request: { agent_id: agentId, verb } },
  }
}

test('receipt bundle writes host, runtime, control, cutover gate, and manifest', async () => {
  const outDir = tmpDir()
  const installPath = writeJson(join(tmpDir(), 'install.json'), installReceipt())
  const probePath = writeJson(join(tmpDir(), 'start-probe.json'), probeReceipt())
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    installReceiptPath: installPath,
    probeReceiptPaths: [probePath],
    controlLabel: 'restart',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'restart'),
  })

  assert.equal(bundle.receipt_type, 'mupot-fleet-receipt-bundle/v1')
  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.summary.failed, 0)
  assert.equal(bundle.artifacts.install.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(bundle.artifacts.install.status, 'warn')
  assert.equal(bundle.artifacts.probes.length, 1)
  assert.equal(bundle.artifacts.probes[0].receipt_type, 'mupot-fleet-cutover-probe/v1')
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.next_steps.some((s) => s.includes('SOS removal is permitted only for the proven agent')))
  assert.ok(existsSync(join(outDir, 'install.json')))
  assert.ok(existsSync(join(outDir, 'probe-start-probe.json')))
  assert.ok(existsSync(join(outDir, 'host.json')))
  assert.ok(existsSync(join(outDir, 'runtime-agent-one.json')))
  assert.ok(existsSync(join(outDir, 'control-restart.json')))
  assert.ok(existsSync(join(outDir, 'cutover-gate.json')))
  assert.ok(existsSync(join(outDir, 'manifest.json')))

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'pass')
  assert.equal(manifest.integrity.algorithm, 'sha256')
  assert.deepEqual(manifest.integrity.excludes, ['manifest.json'])
  assert.equal(manifest.artifacts.install.status, 'warn')
  assert.equal(manifest.artifacts.probes[0].status, 'pass')
  assert.equal(manifest.artifacts.install.sha256, sha256(join(outDir, 'install.json')))
  assert.equal(manifest.artifacts.probes[0].sha256, sha256(join(outDir, 'probe-start-probe.json')))
  assert.equal(manifest.artifacts.host.sha256, sha256(join(outDir, 'host.json')))
  assert.equal(manifest.artifacts.runtimes[0].sha256, sha256(join(outDir, 'runtime-agent-one.json')))
  assert.equal(manifest.artifacts.controls[0].sha256, sha256(join(outDir, 'control-restart.json')))
  assert.equal(manifest.artifacts.cutover_gate.sha256, sha256(join(outDir, 'cutover-gate.json')))
  assert.ok(manifest.next_steps.some((s) => s.includes('manifest.json and cutover-gate.json')))
  assert.ok(manifest.checks.some((c) => c.check === 'install_receipt_status_non_fail' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'probe_receipt_status_pass' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'cutover_gate_status_pass' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'manifest_written' && c.ok === true))
})

test('receipt bundle fails when an included probe receipt did not queue inputs', async () => {
  const outDir = tmpDir()
  const probePath = writeJson(join(tmpDir(), 'failed-probe.json'), probeReceipt('fail'))
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    probeReceiptPaths: [probePath],
    controlLabel: 'restart',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'restart'),
  })

  assert.equal(bundle.status, 'fail')
  assert.ok(bundle.checks.some((c) => c.check === 'probe_receipt_status_pass' && c.ok === false && c.actual === 'fail'))
  assert.ok(bundle.next_steps.some((s) => s.includes('rerun cutover-probe.mjs for the failed probe')))
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.artifacts.probes[0].status, 'fail')
  assert.ok(manifest.next_steps.some((s) => s.includes('do not remove SOS wiring yet')))
})

test('receipt bundle can reuse existing host, runtime, and control receipts', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))

  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    skipHost: true,
    skipRuntime: true,
    skipControl: true,
  })

  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.checks.some((c) => c.check === 'host_receipt_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'runtime_receipts_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'control_receipts_reused' && c.ok === true))
})

test('verify-only rechecks an existing bundle without live receipt builders', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))

  const liveBuilder = async () => {
    throw new Error('verify-only must not call live builders')
  }

  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    hostBuilder: liveBuilder,
    runtimeBuilder: liveBuilder,
    controlBuilder: liveBuilder,
  })

  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.inputs.verify_only, true)
  assert.equal(bundle.inputs.skip_host, true)
  assert.equal(bundle.inputs.skip_runtime, true)
  assert.equal(bundle.inputs.skip_control, true)
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.checks.some((c) => c.check === 'host_receipt_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'runtime_receipts_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'control_receipts_reused' && c.ok === true))

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.inputs.verify_only, true)
  assert.equal(manifest.artifacts.host.sha256, sha256(join(outDir, 'host.json')))
  assert.equal(manifest.artifacts.runtimes[0].sha256, sha256(join(outDir, 'runtime-agent-one.json')))
  assert.equal(manifest.artifacts.controls[0].sha256, sha256(join(outDir, 'control-start.json')))
  assert.equal(manifest.artifacts.cutover_gate.sha256, sha256(join(outDir, 'cutover-gate.json')))
  assert.ok(manifest.next_steps.some((s) => s.includes('attach manifest.json and cutover-gate.json')))
})

test('manifest check verifies copied bundle hashes without rewriting files', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const copiedDir = tmpDir()
  for (const name of readdirSync(outDir).filter((entry) => entry.endsWith('.json'))) {
    copyFileSync(join(outDir, name), join(copiedDir, name))
  }

  const manifestPath = join(copiedDir, 'manifest.json')
  const before = readFileSync(manifestPath, 'utf8')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.receipt_type, 'mupot-fleet-receipt-bundle-check/v1')
  assert.equal(check.status, 'pass')
  assert.equal(check.manifest.sha256, sha256(manifestPath))
  assert.equal(readFileSync(manifestPath, 'utf8'), before)
  assert.ok(check.checks.some((c) => c.check === 'manifest_status_matches_checks' && c.ok === true))
  assert.ok(check.checks.some((c) => c.check === 'manifest_summary_matches_checks' && c.ok === true))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_sha256_match' &&
    c.artifact === 'host' &&
    c.checked_path === join(copiedDir, 'host.json') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_receipt_type_expected' &&
    c.artifact === 'cutover_gate' &&
    c.expected === 'mupot-sos-cutover-gate/v1' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_status_cutover_ready' &&
    c.artifact === 'host' &&
    c.ok === true
  ))

  writeJson(join(copiedDir, 'host.json'), hostReceipt('fail'))
  const drift = checkBundleManifest({ manifestPath })

  assert.equal(drift.status, 'fail')
  assert.ok(drift.checks.some((c) =>
    c.check === 'artifact_sha256_match' &&
    c.artifact === 'host' &&
    c.checked_path === join(copiedDir, 'host.json') &&
    c.ok === false &&
    c.expected !== c.actual
  ))
})

test('manifest check fails when manifest status or summary disagrees with recorded checks', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const selected = manifest.checks.find((check) => check.check === 'host_candidate_selected')
  selected.ok = false
  manifest.status = 'pass'
  manifest.summary = { status: 'pass', passed: 999, failed: 0, warnings: 0 }
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'manifest_status_matches_checks' &&
    c.expected === 'fail' &&
    c.actual === 'pass' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'manifest_summary_matches_checks' &&
    c.expected.status === 'fail' &&
    c.actual.status === 'pass' &&
    c.ok === false
  ))
})

test('manifest check fails when manifest metadata disagrees with artifact content', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.host.status = 'warn'
  manifest.artifacts.host.receipt_type = 'wrong-receipt/v1'
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_receipt_type_matches_manifest' &&
    c.artifact === 'host' &&
    c.expected === 'wrong-receipt/v1' &&
    c.actual === 'mupot-fleet-host-receipt/v1' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_status_matches_manifest' &&
    c.artifact === 'host' &&
    c.expected === 'warn' &&
    c.actual === 'pass' &&
    c.ok === false
  ))
})

test('receipt bundle fails when the final cutover gate lacks stop evidence', async () => {
  const outDir = tmpDir()
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    controlLabel: 'start',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'start'),
  })

  assert.equal(bundle.status, 'fail')
  assert.ok(bundle.checks.some((c) => c.check === 'cutover_gate_status_pass' && c.ok === false && c.actual === 'fail'))
  assert.ok(bundle.next_steps.some((s) => s.includes('agent-one:stop')))
  const gate = JSON.parse(readFileSync(join(outDir, 'cutover-gate.json'), 'utf8'))
  assert.ok(gate.checks.some((c) => c.check === 'control_verb_for_agent' && c.required_verb === 'stop' && c.ok === false))
})

test('parseArgs accepts bundle controls and safe filenames', () => {
  const opts = parseArgs([
    '--agent', 'agent-one,agent-two',
    '--out-dir', './receipts',
    '--daemon', './daemon.json',
    '--inbox', './inbox.json',
    '--control', './control.json',
    '--install-receipt', './install.json',
    '--probe-receipt', './probe-start.json,./probe-stop.json',
    '--control-label', 'start/pass',
    '--require-control-verb', 'restart',
    '--skip-host',
    '--skip-runtime',
    '--skip-control',
    '--exec-probes',
    '--force',
  ])

  assert.deepEqual(opts.agents, ['agent-one', 'agent-two'])
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.installReceiptPath.endsWith('/install.json'))
  assert.equal(opts.probeReceiptPaths.length, 2)
  assert.ok(opts.probeReceiptPaths[0].endsWith('/probe-start.json'))
  assert.ok(opts.probeReceiptPaths[1].endsWith('/probe-stop.json'))
  assert.equal(opts.controlLabel, 'start_pass')
  assert.deepEqual(opts.requiredControlVerbs, ['restart'])
  assert.equal(opts.skipHost, true)
  assert.equal(opts.skipRuntime, true)
  assert.equal(opts.skipControl, true)
  assert.equal(opts.execProbes, true)
  assert.equal(opts.force, true)
  assert.equal(safeName('a/b c'), 'a_b_c')
})

test('parseArgs expands --verify-only to read-only reuse flags', () => {
  const opts = parseArgs(['--agent', 'agent-one', '--verify-only'])

  assert.deepEqual(opts.agents, ['agent-one'])
  assert.equal(opts.verifyOnly, true)
  assert.equal(opts.skipHost, true)
  assert.equal(opts.skipRuntime, true)
  assert.equal(opts.skipControl, true)
})

test('parseArgs accepts read-only manifest check options', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--manifest', './manifest.json', '--check-manifest'])

  assert.equal(opts.checkManifest, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.manifestPath.endsWith('/manifest.json'))
})

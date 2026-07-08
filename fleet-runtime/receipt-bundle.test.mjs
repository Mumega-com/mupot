// node --test receipt-bundle.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBundle, checkBundleManifest, exportBundle, formatStatusSummary, inspectBundleStatus, parseArgs, safeName } from './receipt-bundle.mjs'

const POT_URL = 'https://pot.example.org'
const POT_TENANT = 'tenant-a'

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

function checklistById(status, id) {
  return status.host_go_checklist.find((item) => item.id === id)
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
    inputs: {
      base_url: POT_URL,
      agent: 'agent-one',
      queue_inbox: true,
      control_verbs: ['start'],
    },
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
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      daemon_agents: ['agent-one'],
      control_consumer_agent: 'fleet-consumer',
    },
    checks: [],
  }
}

function runtimeReceipt(agentId, status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: '2026-07-08T00:01:00.000Z',
    status,
    inputs: { selected_agents: [agentId] },
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      agents: [agentId],
    },
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
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      consumer_agent: 'fleet-consumer',
      executed_agents: [agentId],
    },
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
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  assert.equal(manifest.artifacts.probes[0].sha256, sha256(join(outDir, 'probe-start.json')))
  assert.equal(manifest.artifacts.host.sha256, sha256(join(outDir, 'host.json')))
  assert.equal(manifest.artifacts.runtimes[0].sha256, sha256(join(outDir, 'runtime-agent-one.json')))
  assert.equal(manifest.artifacts.controls[0].sha256, sha256(join(outDir, 'control-start.json')))
  assert.equal(manifest.artifacts.cutover_gate.sha256, sha256(join(outDir, 'cutover-gate.json')))
  assert.ok(manifest.next_steps.some((s) => s.includes('attach manifest.json and cutover-gate.json')))
})

test('manifest check verifies copied bundle hashes without rewriting files', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  assert.ok(check.checks.some((c) => c.check === 'next_steps_attach_when_ready' && c.ready === true && c.ok === true))
  assert.ok(check.checks.some((c) => c.check === 'next_steps_no_hold_when_ready' && c.ready === true && c.ok === true))
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
  assert.ok(check.checks.some((c) =>
    c.check === 'selected_agents_recorded' &&
    c.agents.includes('agent-one') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'probe' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'runtime' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'probe_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_target_base_urls_match' &&
    c.base_urls.length === 1 &&
    c.base_urls[0] === POT_URL &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_target_tenants_match' &&
    c.tenants.length === 1 &&
    c.tenants[0] === POT_TENANT &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'runtime_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.expected_file === 'runtime-agent-one.json' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_agents_match_manifest' &&
    c.expected.includes('agent-one') &&
    c.actual.includes('agent-one') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_required_control_verbs_match_manifest' &&
    c.expected.includes('start') &&
    c.expected.includes('stop') &&
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
  assert.ok(drift.checks.some((c) =>
    c.check === 'next_steps_no_attach_when_not_ready' &&
    c.ready === false &&
    c.ok === false
  ))
  assert.ok(drift.checks.some((c) =>
    c.check === 'next_steps_hold_when_not_ready' &&
    c.ready === false &&
    c.ok === false
  ))
})

test('export writes a clean self-contained attachable bundle', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  writeJson(join(outDir, 'daemon.json'), { note: 'operator working file, not evidence' })

  const exportDir = tmpDir()
  const receipt = exportBundle({ outDir, exportDir })

  assert.equal(receipt.receipt_type, 'mupot-fleet-receipt-bundle-export/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.manifest_check.status, 'pass')
  assert.ok(receipt.artifacts.copied.some((artifact) => artifact.label === 'manifest'))
  assert.deepEqual(
    readdirSync(exportDir).sort(),
    ['control-start.json', 'control-stop.json', 'cutover-gate.json', 'host.json', 'manifest.json', 'probe-start.json', 'runtime-agent-one.json'],
  )
  const exportedManifestText = readFileSync(join(exportDir, 'manifest.json'), 'utf8')
  const exportedManifest = JSON.parse(exportedManifestText)
  assert.equal(exportedManifest.inputs.out_dir, '.')
  assert.equal(exportedManifest.artifacts.out_dir, '.')
  assert.equal(exportedManifest.artifacts.manifest, 'manifest.json')
  assert.equal(exportedManifest.artifacts.host.path, 'host.json')
  assert.equal(exportedManifest.artifacts.runtimes[0].path, 'runtime-agent-one.json')
  assert.equal(exportedManifest.artifacts.controls[0].path, 'control-start.json')
  assert.equal(exportedManifest.artifacts.host.receipt_type, 'mupot-fleet-host-receipt/v1')
  assert.equal(exportedManifestText.includes(outDir), false)
  assert.equal(existsSync(join(exportDir, 'daemon.json')), false)
  assert.equal(checkBundleManifest({ outDir: exportDir }).status, 'pass')
  assert.equal(checkBundleManifest({ outDir }).status, 'fail')
})

test('manifest check fails when copied bundle is not self-contained', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  copyFileSync(join(outDir, 'manifest.json'), join(copiedDir, 'manifest.json'))
  const manifestPath = join(copiedDir, 'manifest.json')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_file_readable' &&
    c.artifact === 'host' &&
    c.ok === true &&
    c.checked_path === join(outDir, 'host.json')
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_file_in_bundle_dir' &&
    c.artifact === 'host' &&
    c.expected_path === join(copiedDir, 'host.json') &&
    c.ok === false
  ))

  const status = inspectBundleStatus({ outDir: copiedDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) =>
    c.check === 'copied_bundle_only_manifest_artifacts' &&
    c.ok === false &&
    c.failed > 0
  ))
  assert.ok(status.next_steps.some((step) => step.includes('copy only manifest.json')))
})

test('manifest check fails when copied bundle contains extra files', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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

  writeJson(join(outDir, 'daemon.json'), { base_url: POT_URL, token: 'redacted' })
  const manifestPath = join(outDir, 'manifest.json')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'bundle_directory_only_manifest_artifacts' &&
    c.ok === false &&
    c.unexpected.includes('daemon.json')
  ))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.next_steps.some((step) => step.includes('copy only manifest.json')))
})

test('manifest check fails when copied bundle contains secret material', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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

  const rawSecret = 'Bearer mupot_host_secret_abcdefghijklmnopqrstuvwxyz'
  const runtimePath = join(outDir, 'runtime-agent-one.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.leaked = {
    authorization: rawSecret,
    privateKey: { kty: 'OKP', d: 'private-scalar' },
  }
  writeJson(runtimePath, runtime)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.runtimes[0].sha256 = sha256(runtimePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_no_secret_material' &&
    c.artifact === 'runtime:1' &&
    c.ok === false &&
    c.finding_count >= 2 &&
    c.findings.some((finding) => finding.reason === 'bearer_token') &&
    c.findings.some((finding) => finding.reason === 'jwk_private_key')
  ))
  assert.equal(JSON.stringify(check).includes(rawSecret), false)

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) =>
    c.check === 'copied_bundle_no_secret_material' &&
    c.ok === false &&
    c.failed > 0
  ))
  assert.ok(status.next_steps.some((step) => step.includes('redact secret material')))
})

test('status reports a complete host-go bundle as pass', async () => {
  const outDir = tmpDir()
  const installPath = writeJson(join(tmpDir(), 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
    installReceiptPath: installPath,
    verifyOnly: true,
  })

  const status = inspectBundleStatus({ outDir })

  assert.equal(status.receipt_type, 'mupot-fleet-receipt-bundle-status/v1')
  assert.equal(status.status, 'pass')
  assert.deepEqual(status.inputs.agents, ['agent-one'])
  assert.deepEqual(status.inputs.required_control_verbs, ['start', 'stop'])
  assert.equal(status.manifest_check.status, 'pass')
  assert.equal(status.artifacts.install.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(status.artifacts.cutover_gate.status, 'pass')
  assert.equal(status.host_go_checklist.every((item) => item.status === 'pass'), true)
  assert.equal(checklistById(status, 'selected_agents_named').agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'attachable_manifest_check_passed').manifest_check_status, 'pass')
  assert.equal(checklistById(status, 'attachable_bundle_safe').secret_scan_passed, true)
  assert.equal(checklistById(status, 'attachable_bundle_safe').directory_scope_passed, true)
  assert.ok(status.checks.some((c) => c.check === 'manifest_check_pass' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'copied_bundle_no_secret_material' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'copied_bundle_only_manifest_artifacts' && c.ok === true))
  assert.ok(status.next_steps.some((s) => s.includes('SOS removal is permitted only for the proven agent')))
})

test('status reports missing host-go evidence and next steps for a partial bundle', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  const summary = formatStatusSummary(status)

  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) => c.check === 'host_receipt_pass' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'install_receipt_present' && c.ok === false))
  assert.ok(status.checks.some((c) => c.check === 'probe_receipt_pass_present' && c.ok === false))
  assert.ok(status.checks.some((c) =>
    c.check === 'runtime_receipt_pass_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.ok === false
  ))
  assert.ok(status.checks.some((c) => c.check === 'manifest_check_pass' && c.ok === false))
  assert.equal(checklistById(status, 'bundle_directory_ready').status, 'pass')
  assert.equal(checklistById(status, 'install_receipt_saved').status, 'fail')
  assert.equal(checklistById(status, 'probe_receipts_passed_for_agents').missing_agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'runtime_receipts_passed_for_agents').missing_agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'control_receipts_passed_for_required_verbs').missing.includes('agent-one:start'), true)
  assert.equal(checklistById(status, 'control_receipts_passed_for_required_verbs').missing.includes('agent-one:stop'), true)
  assert.equal(checklistById(status, 'attachable_manifest_check_passed').status, 'fail')
  assert.equal(checklistById(status, 'attachable_bundle_safe').status, 'fail')
  assert.ok(summary.includes('Host-go status: fail'))
  assert.ok(summary.includes('[PASS] bundle_directory_ready'))
  assert.ok(summary.includes('[FAIL] install_receipt_saved'))
  assert.ok(summary.includes('missing: agent-one:start, agent-one:stop'))
  assert.ok(summary.includes('Next steps:'))
  assert.ok(status.next_steps.some((s) => s.includes('save installer output')))
  assert.ok(status.next_steps.some((s) => s.includes('queue inbox and lifecycle inputs')))
  assert.ok(status.next_steps.some((s) => s.includes('runtime-agent-one.json')))
  assert.ok(status.next_steps.some((s) => s.includes('do not remove SOS wiring yet')))
})

test('status reports missing lifecycle control verbs before the gate is rebuilt', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })

  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) => c.check === 'control_receipt_pass_present' && c.ok === true))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'start' &&
    c.matched_verb === 'start' &&
    c.ok === true
  ))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'stop' &&
    c.evidence_verbs.includes('start') &&
    c.ok === false
  ))
  assert.ok(status.next_steps.some((s) => s.includes('agent-one:stop')))
})

test('status treats restart control receipts as start and stop evidence', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-restart.json'), controlReceipt('agent-one', 'restart'))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })

  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'start' &&
    c.matched_verb === 'restart' &&
    c.ok === true
  ))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'stop' &&
    c.matched_verb === 'restart' &&
    c.ok === true
  ))
  assert.ok(!status.next_steps.some((s) => s.includes('queue missing lifecycle control evidence')))
})

test('manifest check fails when next_steps contradict readiness', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  manifest.next_steps = ['do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass']
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'next_steps_attach_when_ready' &&
    c.ready === true &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'next_steps_no_hold_when_ready' &&
    c.ready === true &&
    c.ok === false
  ))
})

test('manifest check fails when cutover gate inputs disagree with manifest evidence', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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

  const gatePath = join(outDir, 'cutover-gate.json')
  const gate = JSON.parse(readFileSync(gatePath, 'utf8'))
  gate.inputs.agents = ['other-agent']
  gate.inputs.required_control_verbs = ['restart']
  gate.inputs.runtime_receipts = []
  writeJson(gatePath, gate)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.cutover_gate.sha256 = sha256(gatePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_agents_match_manifest' &&
    c.expected.includes('agent-one') &&
    c.actual.includes('other-agent') &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_required_control_verbs_match_manifest' &&
    c.expected.includes('start') &&
    c.actual.includes('restart') &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_runtime_artifacts_match_manifest' &&
    c.expected.includes('runtime-agent-one.json') &&
    c.actual.length === 0 &&
    c.ok === false
  ))
})

test('manifest check fails when required evidence categories are missing', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  manifest.artifacts.probes = []
  manifest.artifacts.host = null
  manifest.artifacts.runtimes = []
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'probe' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'host' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'runtime' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'runtime_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.expected_file === 'runtime-agent-one.json' &&
    c.ok === false
  ))
})

test('manifest check fails when manifest status or summary disagrees with recorded checks', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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

test('manifest check fails when receipt target identity mixes pots', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
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

  const runtimePath = join(outDir, 'runtime-agent-one.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.target.base_url = 'https://staging-pot.example.org'
  writeJson(runtimePath, runtime)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.runtimes[0].sha256 = sha256(runtimePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })
  const mismatch = check.checks.find((c) => c.check === 'artifact_target_base_urls_match')

  assert.equal(check.status, 'fail')
  assert.equal(mismatch.ok, false)
  assert.deepEqual(mismatch.base_urls, [POT_URL, 'https://staging-pot.example.org'].sort())
})

test('receipt bundle fails when the final cutover gate lacks stop evidence', async () => {
  const outDir = tmpDir()
  const probePath = writeJson(join(tmpDir(), 'start-probe.json'), probeReceipt())
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    probeReceiptPaths: [probePath],
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

test('parseArgs accepts attachable bundle export options', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--export-dir', './attachable', '--export'])

  assert.equal(opts.export, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.exportDir.endsWith('/attachable'))
})

test('parseArgs accepts read-only host-go status', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--agent', 'agent-one', '--status', '--status-summary'])

  assert.equal(opts.status, true)
  assert.equal(opts.statusSummary, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.deepEqual(opts.agents, ['agent-one'])
})

// node --test receipt-bundle.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBundle, parseArgs, safeName } from './receipt-bundle.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-receipt-bundle-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return path
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
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    installReceiptPath: installPath,
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
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(existsSync(join(outDir, 'install.json')))
  assert.ok(existsSync(join(outDir, 'host.json')))
  assert.ok(existsSync(join(outDir, 'runtime-agent-one.json')))
  assert.ok(existsSync(join(outDir, 'control-restart.json')))
  assert.ok(existsSync(join(outDir, 'cutover-gate.json')))
  assert.ok(existsSync(join(outDir, 'manifest.json')))

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'pass')
  assert.equal(manifest.artifacts.install.status, 'warn')
  assert.ok(manifest.checks.some((c) => c.check === 'install_receipt_status_non_fail' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'cutover_gate_status_pass' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'manifest_written' && c.ok === true))
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
  assert.equal(opts.controlLabel, 'start_pass')
  assert.deepEqual(opts.requiredControlVerbs, ['restart'])
  assert.equal(opts.skipHost, true)
  assert.equal(opts.skipRuntime, true)
  assert.equal(opts.skipControl, true)
  assert.equal(opts.execProbes, true)
  assert.equal(opts.force, true)
  assert.equal(safeName('a/b c'), 'a_b_c')
})

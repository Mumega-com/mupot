import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  renderStarterPlan,
  validateStarterManifest,
  verifyStarterBundle,
} from './starter-manifest.mjs'
import {
  STARTER_ARTIFACT_ROLES,
} from './starter-contract.mjs'

const EXPECTED_TYPES = Object.freeze({
  install: 'mupot-fleet-install-receipt/v1',
  service: 'mupot-fleet-service-receipt/v1',
  host: 'mupot-fleet-host-receipt/v1',
  continuous: 'mupot-fleet-continuous-runtime-receipt/v1',
  runtime_inbox: 'mupot-fleet-runtime-receipt/v1',
  lifecycle_control_start: 'mupot-fleet-control-receipt/v1',
  lifecycle_control_stop: 'mupot-fleet-control-receipt/v1',
  receipt_bundle_manifest: 'mupot-fleet-receipt-bundle/v1',
})

function sterileManifest() {
  return {
    version: 1,
    tenant: 'customer-pot',
    base_url: 'https://pot.customer.example',
    service_manager: 'auto',
    agents: [
      { agent_id: 'manager', runtime: 'hermes', probe: 'pgrep -f hermes', handler: 'node ~/.fleet/handlers/hermes.mjs' },
      { agent_id: 'builder', runtime: 'codex', probe: 'pgrep -f codex', handler: 'node ~/.fleet/handlers/codex.mjs' },
    ],
    control_consumer_agent_id: 'manager',
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-starter-'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function seedBundle(overrides = {}) {
  const bundleDir = tempDir()
  const manifest = overrides.manifest ?? sterileManifest()
  writeJson(join(bundleDir, 'starter.example.json'), manifest)
  mkdirSync(join(bundleDir, 'evidence'), { mode: 0o700 })
  const artifacts = {}
  for (const role of STARTER_ARTIFACT_ROLES) {
    const path = `evidence/${role}.json`
    const receipt = {
      receipt_type: EXPECTED_TYPES[role],
      generated_at: '2026-07-13T20:05:00.000Z',
      status: 'pass',
      evidence: { role },
      ...(overrides.receipts?.[role] ?? {}),
    }
    writeJson(join(bundleDir, path), receipt)
    artifacts[role] = path
  }
  return { bundleDir, artifacts, manifest }
}

test('starter manifest validates and renders co-resident and distributed host plans', () => {
  const manifest = sterileManifest()
  assert.deepEqual(validateStarterManifest(manifest), manifest)

  const coResident = renderStarterPlan(manifest)
  assert.match(coResident, /Host agents: manager, builder/)
  assert.match(coResident, /Control consumer: manager/)
  assert.match(coResident, /--agent manager/)
  assert.match(coResident, /--agent builder/)

  const mac = renderStarterPlan(manifest, { agents: ['manager'] })
  assert.match(mac, /Host agents: manager/)
  assert.doesNotMatch(mac, /--agent builder/)
  assert.match(mac, /Control consumer: manager/)

  const vps = renderStarterPlan(manifest, { agents: ['builder'] })
  assert.match(vps, /Host agents: builder/)
  assert.doesNotMatch(vps, /--agent manager/)
  assert.match(vps, /Control consumer: manager/)
  assert.match(vps, /Tenant: customer-pot/)
  assert.match(vps, /Base URL: https:\/\/pot\.customer\.example/)
})

test('starter plan covers the credential-free install, proof, export, rollback, and recovery lifecycle', () => {
  const plan = renderStarterPlan(sterileManifest(), {
    agents: ['manager'],
    manifestPath: 'customer starter.json',
  })
  for (const required of [
    'fleet-runtime/install.mjs --service-manager auto > ~/.fleet/receipts/install.json',
    'edit ~/.fleet/daemon.json',
    'fleet-runtime/trust-bootstrap.mjs',
    'fleet-runtime/service-manager.mjs install',
    'fleet-runtime/host-receipt.mjs',
    'fleet-runtime/cutover-probe.mjs --base-url https://pot.customer.example --agent manager --agent-token-env MUPOT_AGENT_TOKEN_MANAGER --queue-inbox --control start',
    'fleet-runtime/cutover-probe.mjs --base-url https://pot.customer.example --agent manager --control stop',
    'fleet-runtime/control-receipt.mjs --observe-state',
    'fleet-runtime/continuous-runtime-receipt.mjs',
    'prior-bundle-manifest.json',
    "cp 'customer starter.json' ~/.fleet/receipts/manager/starter.example.json",
    'for(const d of r.definitions)',
    'fleet-runtime/starter-manifest.mjs --verify',
    '--artifact receipt_bundle_manifest=prior-bundle-manifest.json',
    '--service-receipt ~/.fleet/receipts/manager/service.json',
    '--continuous-receipt ~/.fleet/receipts/manager/continuous.json',
    '--starter-receipt ~/.fleet/receipts/manager/starter-receipt.json',
    'fleet-runtime/receipt-bundle.mjs --export',
    'fleet-runtime/receipt-bundle.mjs --check-manifest',
    'fleet-runtime/service-manager.mjs uninstall',
    'fleet-runtime/install.mjs --activate',
  ]) assert.ok(plan.includes(required), required)

  assert.match(plan, /\$\{MUPOT_AGENT_TOKEN_MANAGER\}/)
  assert.match(plan, /\$\{MUPOT_OWNER_TOKEN\}/)
  assert.doesNotMatch(plan, /Bearer\s+[A-Za-z0-9._-]{12,}/i)
  assert.doesNotMatch(plan, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
  assert.doesNotMatch(plan, /mupot_[A-Za-z0-9._-]{12,}/)

  const installReceiptCommand = 'node fleet-runtime/install.mjs --service-manager auto > ~/.fleet/receipts/install.json'
  assert.notEqual(plan.indexOf(installReceiptCommand), plan.lastIndexOf(installReceiptCommand))
  assert.ok(plan.indexOf('edit ~/.fleet/daemon.json') < plan.lastIndexOf(installReceiptCommand))
  assert.ok(plan.indexOf('fleet-runtime/trust-bootstrap.mjs') < plan.lastIndexOf(installReceiptCommand))
  assert.ok(plan.lastIndexOf(installReceiptCommand) < plan.indexOf('fleet-runtime/service-manager.mjs install'))

  const startProbe = plan.indexOf('--queue-inbox --control start')
  const continuous = plan.indexOf('fleet-runtime/continuous-runtime-receipt.mjs')
  const stopProbe = plan.indexOf('--control stop')
  assert.ok(startProbe < continuous)
  assert.ok(continuous < stopProbe)
  assert.match(plan, /control-receipt\.mjs --observe-state[\s\S]*--skip-host --skip-runtime --skip-control/)
  assert.match(plan, /--require-control-verb start --install-receipt ~\/\.fleet\/receipts\/install\.json --probe-receipt/)
  assert.match(plan, /--require-control-verb start,stop --probe-receipt .*probe-stop\.json/)
  assert.match(plan, /Requires MUPOT_AGENT_TOKEN_MANAGER and MUPOT_OWNER_TOKEN/)
  assert.doesNotMatch(plan, /--control-label/)
  assert.match(plan, /control-receipt\.mjs --observe-state --probe-receipt .*probe-start\.json --verb start/)
  assert.match(plan, /control-receipt\.mjs --observe-state --probe-receipt .*probe-stop\.json --verb stop/)

  const recovery = plan.indexOf('8. Recovery reinstall')
  const recoveryInstall = plan.indexOf('install.mjs --activate', recovery)
  const recoveryStart = plan.indexOf('--control start', recovery)
  const recoveryContinuous = plan.indexOf('continuous-runtime-receipt.mjs', recovery)
  assert.ok(recoveryInstall < recoveryStart)
  assert.ok(recoveryStart < recoveryContinuous)
})

test('starter plan enables systemd linger without applying the flag to launchd', () => {
  const systemd = sterileManifest()
  systemd.service_manager = 'systemd'
  const systemdPlan = renderStarterPlan(systemd, { agents: ['manager'] })
  assert.match(systemdPlan, /service-manager\.mjs install --service-manager systemd --enable-linger/)
  assert.match(systemdPlan, /install\.mjs --activate --service-manager systemd --enable-linger/)

  const launchd = sterileManifest()
  launchd.service_manager = 'launchd'
  const launchdPlan = renderStarterPlan(launchd, { agents: ['manager'] })
  assert.doesNotMatch(launchdPlan, /--enable-linger/)

  const automatic = renderStarterPlan(sterileManifest(), { agents: ['manager'] })
  assert.match(automatic, /Linux\) node fleet-runtime\/service-manager\.mjs install --service-manager systemd --enable-linger ;;/)
  assert.match(automatic, /Darwin\) node fleet-runtime\/service-manager\.mjs install --service-manager launchd ;;/)
})

test('starter plan shell-quotes manifest-derived URL values', () => {
  const manifest = sterileManifest()
  manifest.base_url = 'https://pot.customer.example/;printf-INJECTED'
  const plan = renderStarterPlan(manifest, { agents: ['manager'] })

  assert.match(plan, /--base-url 'https:\/\/pot\.customer\.example\/;printf-INJECTED'/)
  assert.doesNotMatch(plan, /--base-url https:\/\/pot\.customer\.example\/;printf-INJECTED/)
})

test('starter planning rejects invalid topology and unknown host filters', () => {
  const invalid = [
    (() => { const value = sterileManifest(); value.agents[1].agent_id = 'manager'; return value })(),
    (() => { const value = sterileManifest(); value.agents[0].runtime = 'other'; return value })(),
    (() => { const value = sterileManifest(); value.service_manager = 'other'; return value })(),
    (() => { const value = sterileManifest(); value.control_consumer_agent_id = 'missing'; return value })(),
    (() => { const value = sterileManifest(); value.agents[0].handler = 'node handler.mjs --authorization Bearer abcdefghijklmnopqrstuvwxyz'; return value })(),
    (() => { const value = sterileManifest(); value.tenant = 'mumega'; value.base_url = 'https://mupot.mumega.com'; return value })(),
  ]
  for (const manifest of invalid) assert.throws(() => validateStarterManifest(manifest), /starter manifest/i)
  assert.throws(() => renderStarterPlan(sterileManifest(), { agents: ['unknown'] }), /unknown agent/i)
})

test('starter bundle verification rejects self-asserted passing envelopes', () => {
  const fixture = seedBundle()
  assert.throws(() => verifyStarterBundle({
    bundleDir: fixture.bundleDir,
    manifestPath: 'starter.example.json',
    artifacts: fixture.artifacts,
  }), /contracts|cross-bindings/i)
})

test('starter bundle verification rejects failed, wrong-type, external, linked, and secret-bearing evidence', () => {
  const failed = seedBundle({ receipts: { service: { status: 'fail' } } })
  assert.throws(() => verifyStarterBundle({ bundleDir: failed.bundleDir, manifestPath: 'starter.example.json', artifacts: failed.artifacts }), /service/i)

  const wrongType = seedBundle({ receipts: { host: { receipt_type: 'wrong/v1' } } })
  assert.throws(() => verifyStarterBundle({ bundleDir: wrongType.bundleDir, manifestPath: 'starter.example.json', artifacts: wrongType.artifacts }), /host/i)

  const secret = seedBundle({ receipts: { runtime_inbox: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } } })
  assert.throws(() => verifyStarterBundle({ bundleDir: secret.bundleDir, manifestPath: 'starter.example.json', artifacts: secret.artifacts }), /secret/i)

  const external = seedBundle()
  external.artifacts.install = join(tempDir(), 'install.json')
  writeJson(external.artifacts.install, { receipt_type: EXPECTED_TYPES.install, status: 'pass' })
  assert.throws(() => verifyStarterBundle({ bundleDir: external.bundleDir, manifestPath: 'starter.example.json', artifacts: external.artifacts }), /portable|relative|bundle/i)

  const linked = seedBundle()
  const target = join(tempDir(), 'service.json')
  writeJson(target, { receipt_type: EXPECTED_TYPES.service, status: 'pass' })
  writeFileSync(join(linked.bundleDir, linked.artifacts.service), '')
  symlinkSync(target, join(linked.bundleDir, 'service-link.json'))
  linked.artifacts.service = 'service-link.json'
  assert.throws(() => verifyStarterBundle({ bundleDir: linked.bundleDir, manifestPath: 'starter.example.json', artifacts: linked.artifacts }), /regular|linked|bundle/i)
})

test('starter CLI help succeeds and names validate, plan, and verify modes', () => {
  const result = spawnSync(process.execPath, ['fleet-runtime/starter-manifest.mjs', '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--validate/)
  assert.match(result.stdout, /--plan/)
  assert.match(result.stdout, /--verify/)
})

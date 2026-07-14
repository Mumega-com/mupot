import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
  STARTER_CHECKS,
  STARTER_RECEIPT_TYPE,
  validateStarterReceipt,
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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
  const plan = renderStarterPlan(sterileManifest(), { agents: ['manager'] })
  for (const required of [
    'fleet-runtime/install.mjs',
    'edit ~/.fleet/daemon.json',
    'fleet-runtime/trust-bootstrap.mjs',
    'fleet-runtime/service-manager.mjs install',
    'fleet-runtime/host-receipt.mjs',
    'fleet-runtime/continuous-runtime-receipt.mjs',
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

test('starter bundle verification returns the exact portable shared receipt', () => {
  const fixture = seedBundle()
  const receipt = verifyStarterBundle({
    bundleDir: fixture.bundleDir,
    manifestPath: 'starter.example.json',
    artifacts: fixture.artifacts,
    now: () => new Date('2026-07-13T20:06:00.000Z'),
  })

  assert.equal(receipt.receipt_type, STARTER_RECEIPT_TYPE)
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.generated_at, '2026-07-13T20:06:00.000Z')
  assert.deepEqual(receipt.manifest, {
    path: 'starter.example.json',
    sha256: sha256(join(fixture.bundleDir, 'starter.example.json')),
  })
  assert.deepEqual(receipt.artifacts.map((artifact) => artifact.role), STARTER_ARTIFACT_ROLES)
  assert.deepEqual(receipt.artifacts.map((artifact) => artifact.path), STARTER_ARTIFACT_ROLES.map((role) => fixture.artifacts[role]))
  assert.deepEqual(receipt.checks, STARTER_CHECKS.map((check) => ({ check, ok: true })))
  assert.deepEqual(validateStarterReceipt(receipt), receipt)
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

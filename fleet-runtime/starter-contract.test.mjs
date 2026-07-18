import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STARTER_ARTIFACT_ROLES,
  STARTER_CHECKS,
  STARTER_RECEIPT_TYPE,
  normalizeStarterManifest,
  normalizeStarterReceipt,
  validateStarterManifest,
  validateStarterReceipt,
} from './starter-contract.mjs'

const DIGESTS = Object.freeze({
  manifest: 'a'.repeat(64),
  install: 'b'.repeat(64),
  service: 'c'.repeat(64),
  host: 'd'.repeat(64),
  continuous: 'e'.repeat(64),
  runtime_inbox: 'f'.repeat(64),
  lifecycle_control_start: '1'.repeat(64),
  lifecycle_control_stop: '2'.repeat(64),
  receipt_bundle_manifest: '3'.repeat(64),
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

function policyProfile(agentId = 'manager') {
  return {
    schema: 'mupot.agent-profile/v1',
    agent_id: agentId,
    adapter: agentId === 'manager' ? 'hermes' : 'codex',
    command: agentId === 'manager' ? ['/usr/local/bin/hermes', 'chat'] : ['/usr/local/bin/codex', 'exec'],
    allowed_senders: [agentId === 'manager' ? 'builder' : 'manager'],
    run_for: ['request'],
    timeout_ms: 120000,
  }
}

function starterReceipt() {
  return {
    receipt_type: STARTER_RECEIPT_TYPE,
    generated_at: '2026-07-13T20:05:00.000Z',
    status: 'pass',
    manifest: { path: 'starter.example.json', sha256: DIGESTS.manifest },
    artifacts: STARTER_ARTIFACT_ROLES.map((role) => ({
      role,
      path: `${role}.json`,
      sha256: DIGESTS[role],
    })),
    checks: STARTER_CHECKS.map((check) => ({ check, ok: true })),
  }
}

function clone(value) {
  return structuredClone(value)
}

test('shared starter contract accepts and normalizes the exact Task 8 fixture', () => {
  const manifest = sterileManifest()
  const receipt = starterReceipt()

  assert.deepEqual(normalizeStarterManifest(manifest), manifest)
  assert.deepEqual(validateStarterManifest(manifest), manifest)
  assert.deepEqual(normalizeStarterReceipt(receipt), receipt)
  assert.deepEqual(validateStarterReceipt(receipt), receipt)
  assert.deepEqual(STARTER_ARTIFACT_ROLES, [
    'install',
    'service',
    'host',
    'continuous',
    'runtime_inbox',
    'lifecycle_control_start',
    'lifecycle_control_stop',
    'receipt_bundle_manifest',
  ])
})

test('shared starter contract accepts optional policy profiles bound to declared agents', () => {
  const manifest = sterileManifest()
  manifest.profiles = [policyProfile('manager'), policyProfile('builder')]

  assert.deepEqual(normalizeStarterManifest(manifest), manifest)
  assert.deepEqual(validateStarterManifest(manifest), manifest)
})

test('shared starter contract rejects duplicate, undeclared, and secret-bearing policy profiles', () => {
  const duplicate = sterileManifest()
  duplicate.profiles = [policyProfile('manager'), policyProfile('manager')]
  const undeclared = sterileManifest()
  undeclared.profiles = [policyProfile('outside-agent')]
  const secret = sterileManifest()
  secret.profiles = [{ ...policyProfile('manager'), command: ['/usr/local/bin/hermes', '--token=mupot_example_secret'] }]

  for (const manifest of [duplicate, undeclared, secret]) {
    assert.equal(normalizeStarterManifest(manifest), null)
  }
})

test('shared starter contract rejects unknown fields recursively', () => {
  const manifest = sterileManifest()
  manifest.agents[0].fabricated = true
  const receipt = starterReceipt()
  receipt.artifacts[0].fabricated = true

  assert.equal(normalizeStarterManifest(manifest), null)
  assert.equal(normalizeStarterReceipt(receipt), null)
  assert.throws(() => validateStarterManifest(manifest), /starter manifest/i)
  assert.throws(() => validateStarterReceipt(receipt), /starter receipt/i)
})

test('shared starter contract rejects duplicate and missing evidence roles', () => {
  const duplicate = starterReceipt()
  duplicate.artifacts[1].role = duplicate.artifacts[0].role
  const missing = starterReceipt()
  missing.artifacts.pop()

  assert.equal(normalizeStarterReceipt(duplicate), null)
  assert.equal(normalizeStarterReceipt(missing), null)
})

test('shared starter contract rejects absolute and traversing paths', () => {
  for (const path of ['/tmp/install.json', '../install.json', 'nested/../../install.json', '.', '']) {
    const receipt = starterReceipt()
    receipt.artifacts[0].path = path
    assert.equal(normalizeStarterReceipt(receipt), null, path)
  }

  const absoluteManifest = starterReceipt()
  absoluteManifest.manifest.path = '/tmp/starter.example.json'
  assert.equal(normalizeStarterReceipt(absoluteManifest), null)
})

test('shared starter contract accepts normalized nested relative paths', () => {
  const receipt = starterReceipt()
  receipt.manifest.path = 'manifest/starter.example.json'
  receipt.artifacts = receipt.artifacts.map((artifact) => ({
    ...artifact,
    path: `evidence/${artifact.path}`,
  }))

  assert.deepEqual(normalizeStarterReceipt(receipt), receipt)
})

test('shared starter contract rejects malformed digests and check records', () => {
  const badDigest = starterReceipt()
  badDigest.artifacts[0].sha256 = 'A'.repeat(64)
  const wrongCheck = starterReceipt()
  wrongCheck.checks[0].check = 'self_asserted_pass'
  const extraCheckField = starterReceipt()
  extraCheckField.checks[0].reason = 'fabricated'
  const failedCheck = starterReceipt()
  failedCheck.checks[0].ok = false

  for (const receipt of [badDigest, wrongCheck, extraCheckField, failedCheck]) {
    assert.equal(normalizeStarterReceipt(receipt), null)
  }
})

test('shared starter contract rejects secrets and private identity material', () => {
  const bearer = sterileManifest()
  bearer.agents[0].handler = 'node handler.mjs --authorization Bearer abcdefghijklmnopqrstuvwxyz'
  const privateJwk = starterReceipt()
  privateJwk.manifest = { ...privateJwk.manifest, private_key: { kty: 'OKP', d: 'private-scalar' } }
  const productionIdentity = sterileManifest()
  productionIdentity.tenant = 'mumega'
  productionIdentity.base_url = 'https://mupot.mumega.com'

  assert.equal(normalizeStarterManifest(bearer), null)
  assert.equal(normalizeStarterReceipt(privateJwk), null)
  assert.equal(normalizeStarterManifest(productionIdentity), null)
})

test('shared starter contract rejects incomplete and inconsistent sterile manifests', () => {
  const missingField = sterileManifest()
  delete missingField.base_url
  const duplicateAgent = sterileManifest()
  duplicateAgent.agents[1].agent_id = 'manager'
  const missingConsumer = sterileManifest()
  missingConsumer.control_consumer_agent_id = 'not-an-agent'
  const unsupportedRuntime = sterileManifest()
  unsupportedRuntime.agents[0].runtime = 'unknown'
  const unsupportedManager = sterileManifest()
  unsupportedManager.service_manager = 'windows-service'

  for (const manifest of [missingField, duplicateAgent, missingConsumer, unsupportedRuntime, unsupportedManager]) {
    assert.equal(normalizeStarterManifest(clone(manifest)), null)
  }
})

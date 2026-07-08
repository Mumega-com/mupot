// node --test host-receipt.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReceipt, hasPlaceholder, summarize } from './host-receipt.mjs'

const PANEL_PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'bqjg1QCM1_F1Oe4xxjDidrEkNzkgwbAUk65dJUYFaLI',
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'mupot-host-receipt-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function touch(path, mode = 0o600) {
  writeFileSync(path, '{}\n', { mode })
  chmodSync(path, mode)
}

function fixture(overrides = {}) {
  const root = tmp()
  const keys = join(root, 'keys')
  mkdirSync(keys)
  const daemonPath = join(root, 'daemon.json')
  const inboxPath = join(root, 'inbox.json')
  const controlPath = join(root, 'control.json')
  const panelPublicKey = join(root, 'panel.pub.jwk')
  const flightsConfig = join(root, 'flights.json')
  const flightScript = join(root, 'flight.mjs')

  const daemon = {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    interval_sec: 75,
    agents: [
      {
        agent_id: 'agent-one',
        type: 'builder',
        runtime: 'codex',
        probe: 'true',
        inbox: { command: 'node ~/.fleet/runtime/inbox-handler.mjs ~/.fleet/inbox-handler.json', limit: 20 },
      },
    ],
  }
  const inbox = {
    spool_dir: join(root, 'spool'),
    agents: [
      { agent_id: 'agent-one', command: 'true', run_for: ['request'] },
    ],
  }
  const control = {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    consumer_agent_id: 'fleet-consumer',
    panel_public_key: panelPublicKey,
    flights_config: flightsConfig,
    flight_script: flightScript,
  }

  writeJson(daemonPath, overrides.daemon ?? daemon)
  writeJson(inboxPath, overrides.inbox ?? inbox)
  writeJson(controlPath, overrides.control ?? control)
  touch(join(keys, 'agent-one.key'))
  touch(join(keys, 'fleet-consumer.key'))
  writeJson(panelPublicKey, overrides.panelPublicKey ?? PANEL_PUBLIC_JWK)
  touch(flightsConfig)
  touch(flightScript, 0o755)

  return {
    root,
    daemonPath,
    inboxPath,
    controlPath,
    keyPathFor: (agentId) => join(keys, `${agentId}.key`),
  }
}

test('host receipt passes for a complete local host layout without executing probes', async () => {
  const f = fixture()
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-host-receipt/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.summary.failed, 0)
  assert.deepEqual(receipt.target, {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    daemon_agents: ['agent-one'],
    control_consumer_agent: 'fleet-consumer',
  })
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'agent_private_key_present_0600' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'inbox-handler' && c.check === 'daemon_inbox_agent_has_handler_config' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'consumer_private_key_present_0600' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'panel_public_key_public_only' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'host-receipt' && c.check === 'daemon_control_base_url_match' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'host-receipt' && c.check === 'daemon_control_tenant_match' && c.ok))
})

test('host receipt fails when daemon inbox agents have no handler config', async () => {
  const f = fixture({ inbox: { spool_dir: join(tmp(), 'spool'), agents: [{ agent_id: 'other-agent' }] } })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'inbox-handler' &&
    c.check === 'daemon_inbox_agent_has_handler_config' &&
    c.agent_id === 'agent-one' &&
    c.ok === false
  ))
})

test('host receipt fails placeholder base_url and tenant values', async () => {
  const f = fixture({
    daemon: {
      base_url: 'https://YOUR-POT.example.com',
      tenant: 'YOUR_TENANT_SLUG',
      agents: [{ agent_id: 'agent-one', probe: 'true' }],
    },
  })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: true,
    skipControl: true,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'base_url_real' && !c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'tenant_real' && !c.ok))
})

test('host receipt fails when daemon and control config target different pots', async () => {
  const f = fixture({
    control: {
      base_url: 'https://staging-pot.example.org',
      tenant: 'tenant-b',
      consumer_agent_id: 'fleet-consumer',
      panel_public_key: join(tmp(), 'panel.pub.jwk'),
      flights_config: join(tmp(), 'flights.json'),
      flight_script: join(tmp(), 'flight.mjs'),
    },
  })
  const control = JSON.parse(readFileSync(f.controlPath, 'utf8'))
  touch(control.panel_public_key)
  touch(control.flights_config)
  touch(control.flight_script, 0o755)

  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'host-receipt' &&
    c.check === 'daemon_control_base_url_match' &&
    c.ok === false &&
    c.daemon_base_url === 'https://pot.example.org' &&
    c.control_base_url === 'https://staging-pot.example.org'
  ))
  assert.ok(receipt.checks.some((c) =>
    c.component === 'host-receipt' &&
    c.check === 'daemon_control_tenant_match' &&
    c.ok === false &&
    c.daemon_tenant === 'tenant-a' &&
    c.control_tenant === 'tenant-b'
  ))
})

test('host receipt fails when panel public key contains private JWK material', async () => {
  const f = fixture({ panelPublicKey: { ...PANEL_PUBLIC_JWK, d: 'private-scalar' } })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'fleet-control-daemon' &&
    c.check === 'panel_public_key_public_only' &&
    c.ok === false &&
    /PUBLIC Ed25519 OKP JWK/.test(c.reason)
  ))
})

test('summary and placeholder helpers keep receipt status deterministic', () => {
  assert.equal(hasPlaceholder('https://YOUR-POT.example.com'), true)
  assert.equal(hasPlaceholder('https://sub.example.com/runtime'), true)
  assert.equal(hasPlaceholder('https://pot.example.org'), false)
  assert.equal(hasPlaceholder('https://example.com.evil.invalid'), false)
  assert.equal(hasPlaceholder('https://notexample.com/runtime'), false)
  assert.deepEqual(summarize([{ ok: true }, { ok: null }]), { status: 'warn', passed: 1, failed: 0, warnings: 1 })
  assert.deepEqual(summarize([{ ok: true }, { ok: false }]), { status: 'fail', passed: 1, failed: 1, warnings: 0 })
})

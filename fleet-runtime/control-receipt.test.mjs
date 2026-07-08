// node --test control-receipt.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReceipt, parseArgs } from './control-receipt.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-control-receipt-'))
}

function writeControlConfig(raw = {}) {
  const dir = tmpDir()
  const panel = join(dir, 'panel.pub.jwk')
  const flights = join(dir, 'flights.json')
  const control = join(dir, 'control.json')
  writeFileSync(panel, '{"kty":"OKP","crv":"Ed25519","x":"test"}\n')
  writeFileSync(flights, '{"agents":[]}\n')
  writeFileSync(control, JSON.stringify({
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    consumer_agent_id: 'fleet-consumer',
    panel_public_key: panel,
    flights_config: flights,
    nonce_ledger: join(dir, 'nonces.json'),
    flight_script: join(dir, 'flight.mjs'),
    ...raw,
  }, null, 2))
  return { dir, panel, flights, control }
}

test('control receipt passes when one poll executes a signed flight action', async () => {
  const f = writeControlConfig()
  const calls = []
  const receipt = await buildReceipt({
    controlPath: f.control,
    keyLoader: async (agentId) => `key:${agentId}`,
    panelKeyImporter: async (text) => ({ imported: text.includes('Ed25519') }),
    ledger: { burn: () => true },
    pollOnce: async (cfg, consumerKey, publicKey, ledger, opts) => {
      calls.push({ cfg, consumerKey, publicKey, ledger, opts })
      return { ok: true, action: 'open' }
    },
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-control-receipt/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.summary.failed, 0)
  assert.equal(receipt.inputs.consumer_agent, 'fleet-consumer')
  assert.equal(calls[0].consumerKey, 'key:fleet-consumer')
  assert.equal(calls[0].publicKey.imported, true)
  assert.equal(typeof calls[0].opts.log, 'function')
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'control_request_executed' && c.ok && c.action === 'open'))
})

test('control receipt warns when the signed control inbox is idle', async () => {
  const f = writeControlConfig()
  const receipt = await buildReceipt({
    controlPath: f.control,
    keyLoader: async (agentId) => `key:${agentId}`,
    panelKeyImporter: async () => ({}),
    pollOnce: async () => ({ ok: true, action: 'idle' }),
  })

  assert.equal(receipt.status, 'warn')
  assert.ok(receipt.checks.some((c) => c.check === 'signed_control_inbox_peek_ok' && c.ok === true))
  assert.ok(receipt.checks.some((c) => c.check === 'control_inbox_idle' && c.ok === null))
})

test('control receipt fails before polling when consumer key cannot load', async () => {
  const f = writeControlConfig()
  const receipt = await buildReceipt({
    controlPath: f.control,
    keyLoader: async () => { throw new Error('missing key') },
    panelKeyImporter: async () => ({}),
    pollOnce: async () => { throw new Error('should not poll without key') },
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.check === 'consumer_private_key_loaded' && c.ok === false && /missing key/.test(c.reason)))
  assert.ok(receipt.checks.some((c) => c.check === 'poll_inputs_ready' && c.ok === false))
  assert.equal(receipt.poll, null)
})

test('parseArgs accepts a control config path', () => {
  const opts = parseArgs(['--control', './control.json'])
  assert.ok(opts.controlPath.endsWith('/control.json'))
})

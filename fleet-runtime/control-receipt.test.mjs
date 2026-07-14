// node --test control-receipt.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReceipt, parseArgs } from './control-receipt.mjs'
import { runControlCycle, validateConfig } from './fleet-control-daemon.mjs'

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
      return { ok: true, action: 'open', request: { agent_id: 'agent-one', verb: 'start' } }
    },
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-control-receipt/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.summary.failed, 0)
  assert.equal(receipt.inputs.consumer_agent, 'fleet-consumer')
  assert.equal(calls[0].consumerKey, 'key:fleet-consumer')
  assert.equal(calls[0].publicKey.imported, true)
  assert.equal(typeof calls[0].opts.log, 'function')
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'control_request_executed' && c.ok && c.action === 'open' && c.agent_id === 'agent-one' && c.verb === 'start'))
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

test('control receipt observes the daemon state without polling the shared inbox', async () => {
  const f = writeControlConfig({ state_file: join(tmpDir(), 'fleet-control.json') })
  const probe = join(f.dir, 'probe-start.json')
  const nonce = 'queued-control-nonce'
  const requestRef = createHash('sha256').update(nonce).digest('hex')
  writeFileSync(probe, JSON.stringify({
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-13T12:00:01.000Z',
    status: 'pass',
    inputs: { base_url: 'https://pot.example.org', agent: 'agent-one', control_verbs: ['start'] },
    actions: [{ kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true, nonce }],
  }))
  let reads = 0
  const receipt = await buildReceipt({
    controlPath: f.control,
    observeState: true,
    probePath: probe,
    statePath: '/state/fleet-control.json',
    verb: 'start',
    now: () => Date.parse('2026-07-13T12:00:10.000Z'),
    readRuntimeState: () => {
      reads += 1
      return {
        schema: 'mupot-fleet-control-state/v1',
        pid: 4321,
        started_at: '2026-07-13T12:00:00.000Z',
        poll: 8,
        last_poll_at: '2026-07-13T12:00:10.000Z',
        poll_sec: 5,
        last_outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' },
        last_accepted: { agent_id: 'agent-one', verb: 'start', result: 'open', request_ref: requestRef, observed_at: '2026-07-13T12:00:05.000Z' },
      }
    },
    pollOnce: async () => { throw new Error('state observation must not poll the inbox') },
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(reads, 1)
  assert.equal(receipt.inputs.evidence_mode, 'daemon_state')
  assert.equal(receipt.poll.request.request_ref, requestRef)
  assert.equal(receipt.poll.state.pid, 4321)
  assert.ok(receipt.checks.some((check) => check.check === 'control_request_observed' && check.request_ref === requestRef))
})

test('state-observed receipt consumes the actual daemon state producer output', async () => {
  const f = writeControlConfig({ state_file: join(tmpDir(), 'unused.json') })
  const statePath = join(f.dir, 'fleet-control.json')
  const raw = JSON.parse(readFileSync(f.control, 'utf8'))
  raw.state_file = statePath
  writeFileSync(f.control, JSON.stringify(raw))
  const cfg = validateConfig(raw)
  const nonce = 'producer-bound-control-nonce'
  await runControlCycle(cfg, 'consumer-key', null, null, { poll: 0 }, {
    pid: 4321,
    startedAt: '2026-07-13T12:00:00.000Z',
    now: () => new Date('2026-07-13T12:00:05.000Z'),
    pollOnce: async () => ({ ok: true, action: 'open', request: { agent_id: 'agent-one', verb: 'start', nonce } }),
  })
  const probe = join(f.dir, 'probe-start.json')
  writeFileSync(probe, JSON.stringify({
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-13T12:00:01.000Z',
    status: 'pass',
    inputs: { base_url: 'https://pot.example.org', agent: 'agent-one', control_verbs: ['start'] },
    actions: [{ kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true, nonce }],
  }))

  const receipt = await buildReceipt({
    controlPath: f.control,
    observeState: true,
    probePath: probe,
    statePath,
    verb: 'start',
    now: () => Date.parse('2026-07-13T12:00:10.000Z'),
    pollOnce: async () => { throw new Error('shared inbox was polled twice') },
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.poll.state.pid, 4321)
  assert.equal(receipt.poll.state.last_accepted.agent_id, 'agent-one')
})

test('state-observed control receipt fails when daemon state is for another queued request', async () => {
  const f = writeControlConfig({ state_file: join(tmpDir(), 'fleet-control.json') })
  const probe = join(f.dir, 'probe-start.json')
  writeFileSync(probe, JSON.stringify({
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-13T12:00:01.000Z',
    status: 'pass',
    inputs: { base_url: 'https://pot.example.org', agent: 'agent-one', control_verbs: ['start'] },
    actions: [{ kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true, nonce: 'expected' }],
  }))
  const receipt = await buildReceipt({
    controlPath: f.control,
    observeState: true,
    probePath: probe,
    statePath: '/state/fleet-control.json',
    verb: 'start',
    now: () => Date.parse('2026-07-13T12:00:10.000Z'),
    waitSec: 0,
    readRuntimeState: () => ({
      schema: 'mupot-fleet-control-state/v1', pid: 4321, started_at: '2026-07-13T12:00:00.000Z', poll: 8,
      last_poll_at: '2026-07-13T12:00:10.000Z', poll_sec: 5,
      last_outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' },
      last_accepted: { agent_id: 'agent-one', verb: 'start', result: 'open', request_ref: 'b'.repeat(64), observed_at: '2026-07-13T12:00:05.000Z' },
    }),
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((check) => check.check === 'control_request_observed' && check.ok === false))
})

test('state-observed control receipt rejects matching state that predates its probe', async () => {
  const f = writeControlConfig({ state_file: join(tmpDir(), 'fleet-control.json') })
  const probe = join(f.dir, 'probe-start.json')
  const nonce = 'replayed-control-nonce'
  const requestRef = createHash('sha256').update(nonce).digest('hex')
  writeFileSync(probe, JSON.stringify({
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-13T12:00:10.000Z',
    status: 'pass',
    inputs: { base_url: 'https://pot.example.org', agent: 'agent-one', control_verbs: ['start'] },
    actions: [{ kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true, nonce }],
  }))
  const receipt = await buildReceipt({
    controlPath: f.control,
    observeState: true,
    probePath: probe,
    statePath: '/state/fleet-control.json',
    verb: 'start',
    waitSec: 0,
    now: () => Date.parse('2026-07-13T12:00:20.000Z'),
    readRuntimeState: () => ({
      schema: 'mupot-fleet-control-state/v1', pid: 4321, started_at: '2026-07-13T11:00:00.000Z', poll: 8,
      last_poll_at: '2026-07-13T11:00:10.000Z', poll_sec: 5,
      last_outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' },
      last_accepted: { agent_id: 'agent-one', verb: 'start', result: 'open', request_ref: requestRef, observed_at: '2026-07-13T11:00:05.000Z' },
    }),
  })

  assert.equal(receipt.status, 'fail')
})

test('state-observed control receipt rejects a probe outside the collection window', async () => {
  const f = writeControlConfig({ state_file: join(tmpDir(), 'fleet-control.json') })
  const probe = join(f.dir, 'probe-start.json')
  const nonce = 'expired-control-nonce'
  const requestRef = createHash('sha256').update(nonce).digest('hex')
  writeFileSync(probe, JSON.stringify({
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-13T12:00:00.000Z',
    status: 'pass',
    inputs: { base_url: 'https://pot.example.org', agent: 'agent-one', control_verbs: ['start'] },
    actions: [{ kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true, nonce }],
  }))
  const receipt = await buildReceipt({
    controlPath: f.control,
    observeState: true,
    probePath: probe,
    statePath: '/state/fleet-control.json',
    verb: 'start',
    waitSec: 0,
    now: () => Date.parse('2026-07-13T12:11:00.000Z'),
    readRuntimeState: () => ({
      schema: 'mupot-fleet-control-state/v1', pid: 4321, started_at: '2026-07-13T11:00:00.000Z', poll: 8,
      last_poll_at: '2026-07-13T12:01:00.000Z', poll_sec: 5,
      last_outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' },
      last_accepted: { agent_id: 'agent-one', verb: 'start', result: 'open', request_ref: requestRef, observed_at: '2026-07-13T12:01:00.000Z' },
    }),
  })

  assert.equal(receipt.status, 'fail')
})

test('parseArgs accepts read-only daemon-state evidence options', () => {
  const opts = parseArgs(['--control', './control.json', '--observe-state', '--probe-receipt', './probe.json', '--state', './state.json', '--verb', 'stop', '--wait-sec', '30', '--poll-ms', '250'])
  assert.equal(opts.observeState, true)
  assert.ok(opts.probePath.endsWith('/probe.json'))
  assert.ok(opts.statePath.endsWith('/state.json'))
  assert.equal(opts.verb, 'stop')
  assert.equal(opts.waitSec, 30)
  assert.equal(opts.pollMs, 250)
})

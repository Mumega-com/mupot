// node --test fleet-control-daemon.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as w } from 'node:crypto'
import { canonicalControlMessage, importPanelPublicKey } from './control-request.mjs'
import {
  handleControlMessage,
  pollOnce,
  runControlCycle,
  runFlightVerb,
  validateConfig,
} from './fleet-control-daemon.mjs'

const b64url = (b) => Buffer.from(b).toString('base64url')

const baseRaw = () => ({
  base_url: 'https://pot.example.com',
  tenant: 't',
  consumer_agent_id: 'fleet-consumer',
  panel_public_key: '~/panel.pub.jwk',
  flights_config: '~/flights.json',
})

async function signer() {
  const kp = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = await importPanelPublicKey(JSON.stringify(await w.subtle.exportKey('jwk', kp.publicKey)))
  return {
    publicKey,
    async request(over = {}) {
      const req = {
        agent_id: 'agent-one',
        verb: 'start',
        nonce: over.nonce ?? b64url(w.getRandomValues(new Uint8Array(18))),
        ts: over.ts ?? Math.floor(Date.now() / 1000),
        ...over,
      }
      const sig = await w.subtle.sign(
        { name: 'Ed25519' },
        kp.privateKey,
        new TextEncoder().encode(canonicalControlMessage(req)),
      )
      return { ...req, sig: b64url(sig) }
    },
  }
}

function memoryLedger() {
  const seen = new Set()
  return {
    burn(nonce) {
      if (seen.has(nonce)) return false
      seen.add(nonce)
      return true
    },
  }
}

test('validateConfig: normalizes a valid control daemon config', () => {
  const cfg = validateConfig({ ...baseRaw(), poll_sec: 1, command_timeout_ms: 999999 })
  assert.equal(cfg.baseUrl, 'https://pot.example.com')
  assert.equal(cfg.tenant, 't')
  assert.equal(cfg.consumerAgent, 'fleet-consumer')
  assert.equal(cfg.pollSec, 5)
  assert.equal(cfg.commandTimeoutMs, 600_000)
  assert.ok(cfg.panelPublicKeyPath.endsWith('panel.pub.jwk'))
})

test('validateConfig: uses an optional state_file or the runtime state default', () => {
  assert.equal(validateConfig(baseRaw()).statePath, `${process.env.HOME}/.fleet/state/fleet-control.json`)
  assert.equal(validateConfig({ ...baseRaw(), state_file: '/tmp/control-state.json' }).statePath, '/tmp/control-state.json')
})

test('validateConfig: rejects malformed critical fields', () => {
  assert.throws(() => validateConfig({ ...baseRaw(), consumer_agent_id: '../bad' }), /consumer_agent_id/)
  assert.throws(() => validateConfig({ ...baseRaw(), panel_public_key: '' }), /panel_public_key/)
  assert.throws(() => validateConfig({ ...baseRaw(), base_url: 'file:///tmp/x' }), /base_url/)
})

test('runFlightVerb maps start, stop, restart, and status to flight commands', async () => {
  const cfg = validateConfig(baseRaw())
  const calls = []
  const run = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs })
    return { ok: true, code: 0 }
  }
  assert.deepEqual(await runFlightVerb(cfg, { agent_id: 'agent-one', verb: 'status' }, run), { ok: true, action: 'status_noop' })
  assert.equal((await runFlightVerb(cfg, { agent_id: 'agent-one', verb: 'start' }, run)).action, 'open')
  assert.equal((await runFlightVerb(cfg, { agent_id: 'agent-one', verb: 'stop' }, run)).action, 'close')
  assert.equal((await runFlightVerb(cfg, { agent_id: 'agent-one', verb: 'restart' }, run)).action, 'restart_open')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map((c) => c.argv[2]), ['open', 'close', 'close', 'open'])
  assert.ok(calls.every((c) => c.argv[4] === cfg.flightsConfigPath))
})

test('handleControlMessage: verifies and executes a valid control message', async () => {
  const cfg = validateConfig(baseRaw())
  const { publicKey, request } = await signer()
  const msg = { body: JSON.stringify(await request({ verb: 'start' })) }
  const ran = []
  const res = await handleControlMessage(msg, cfg, publicKey, memoryLedger(), async (_cfg, req) => {
    ran.push(req)
    return { ok: true, action: 'open' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.consume, true)
  assert.equal(ran[0].agent_id, 'agent-one')
})

test('handleControlMessage: invalid JSON and replay consume without executing', async () => {
  const cfg = validateConfig(baseRaw())
  const { publicKey, request } = await signer()
  const ledger = memoryLedger()
  let calls = 0
  const run = async () => { calls++; return { ok: true, action: 'open' } }
  assert.deepEqual(await handleControlMessage({ body: '{nope' }, cfg, publicKey, ledger, run), {
    consume: true,
    ok: false,
    reason: 'invalid_json',
  })
  const body = JSON.stringify(await request({ nonce: 'same_nonce_000000' }))
  assert.equal((await handleControlMessage({ body }, cfg, publicKey, ledger, run)).ok, true)
  const replay = await handleControlMessage({ body }, cfg, publicKey, ledger, run)
  assert.equal(replay.consume, true)
  assert.equal(replay.reason, 'replay')
  assert.equal(calls, 1)
})

test('handleControlMessage: command failure is consumed after verified nonce burn', async () => {
  const cfg = validateConfig(baseRaw())
  const { publicKey, request } = await signer()
  const res = await handleControlMessage(
    { body: JSON.stringify(await request({ verb: 'stop' })) },
    cfg,
    publicKey,
    memoryLedger(),
    async () => ({ ok: false, action: 'close', code: 7 }),
  )
  assert.equal(res.consume, true)
  assert.equal(res.reason, 'flight_command_failed')
  assert.equal(res.code, 7)
})

test('pollOnce: peeks one message, executes, then consumes one message', async () => {
  const cfg = validateConfig(baseRaw())
  const { publicKey, request } = await signer()
  const calls = []
  const inbox = async (_baseUrl, _agentId, opts) => {
    calls.push({ peek: opts.peek, limit: opts.limit })
    if (opts.peek) return { ok: true, status: 200, json: { messages: [{ body: JSON.stringify(await request()) }] } }
    return { ok: true, status: 200, json: { messages: [] } }
  }
  const res = await pollOnce(cfg, 'consumer-key', publicKey, memoryLedger(), {
    signedInbox: inbox,
    runFlightVerb: async () => ({ ok: true, action: 'open' }),
  })
  assert.equal(res.ok, true)
  assert.deepEqual(calls, [{ peek: true, limit: 1 }, { peek: false, limit: 1 }])
})

test('runControlCycle: publishes completed polls in order and survives state write failures', async () => {
  const cfg = validateConfig({ ...baseRaw(), state_file: '/tmp/control-state.json' })
  const outcome = {
    ok: true,
    action: 'open',
    request: { agent_id: 'agent-one', verb: 'start', nonce: 'nonce-123', sig: 'signature-123' },
  }
  const writes = []
  const logs = []
  const events = []
  const state = { poll: 0 }
  let finishFirst
  const firstOperation = new Promise((resolve) => { finishFirst = resolve })
  const pollOnceFn = async () => {
    events.push('poll')
    return firstOperation
  }
  const options = {
    statePath: '/tmp/control-state.json',
    pid: 456,
    startedAt: '2026-07-13T12:00:00.000Z',
    now: () => new Date('2026-07-13T12:01:00.000Z'),
    pollOnce: pollOnceFn,
    writeRuntimeState: (path, published) => {
      events.push(`write:${published.poll}`)
      writes.push({ path, state: published })
    },
    log: (entry) => logs.push(entry),
  }
  const firstCycle = runControlCycle(cfg, 'consumer-key', null, null, state, options)
  await Promise.resolve()
  assert.deepEqual(events, ['poll'])
  finishFirst(outcome)
  assert.equal(await firstCycle, outcome)
  assert.equal(state.poll, 1)

  options.now = () => new Date('2026-07-13T12:01:05.000Z')
  options.writeRuntimeState = () => { throw new Error('disk full') }
  assert.equal(await runControlCycle(cfg, 'consumer-key', null, null, state, options), outcome)
  assert.equal(state.poll, 2)

  options.now = () => new Date('2026-07-13T12:01:10.000Z')
  options.writeRuntimeState = (path, published) => {
    events.push(`write:${published.poll}`)
    writes.push({ path, state: published })
  }
  assert.equal(await runControlCycle(cfg, 'consumer-key', null, null, state, options), outcome)

  assert.deepEqual(events, ['poll', 'write:1', 'poll', 'poll', 'write:3'])
  assert.deepEqual(writes.map((write) => write.state.poll), [1, 3])
  assert.equal(state.poll, 3)
  assert.doesNotMatch(JSON.stringify(writes[0].state), /nonce|signature|token/i)
  assert.equal(logs.at(-1).event, 'state_write_failed')
  assert.equal(logs.at(-1).state_path, '/tmp/control-state.json')
})

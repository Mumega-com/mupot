import assert from 'node:assert/strict'
import test from 'node:test'
import { buildContinuousRuntimeReceipt, observeAdvance, parseArgs } from './continuous-runtime-receipt.mjs'

const LINGER_NEXT_STEP = 'run loginctl enable-linger <username> with suitable host privileges, then rerun status'
const startedAt = '2026-07-13T12:00:00.000Z'

function heartbeat({ tick = 7, lastTickAt = '2026-07-13T12:00:00.000Z', agent = {} } = {}) {
  return {
    schema: 'mupot-fleet-daemon-state/v1',
    pid: 101,
    started_at: startedAt,
    tick,
    last_tick_at: lastTickAt,
    interval_sec: 10,
    agents: [{
      agent_id: 'hermes-manager',
      probe: 'alive',
      heartbeat_status: 200,
      inbox_count: 0,
      consume: 'consumed',
      ...agent,
    }],
    token: 'mupot_abcdefghijklmnop',
  }
}

function control({ poll = 12, outcome = {} } = {}) {
  return {
    schema: 'mupot-fleet-control-state/v1',
    pid: 102,
    started_at: startedAt,
    poll,
    last_poll_at: '2026-07-13T12:00:00.000Z',
    poll_sec: 2,
    last_outcome: {
      agent_id: 'hermes-manager',
      verb: 'start',
      accepted: true,
      result: 'started',
      nonce: 'nonce-123',
      signature: 'signature-123',
      ...outcome,
    },
  }
}

function serviceReceipt({ status = 'pass', running = true, linger = null, nextSteps = [] } = {}) {
  return {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    status,
    service_manager: linger ? 'systemd' : 'launchd',
    services: [
      { key: 'heartbeat', name: 'fleet-daemon.service', loaded: true, enabled: true, running, pid: 101 },
      { key: 'control', name: 'fleet-control-daemon.service', loaded: true, enabled: true, running, pid: 102 },
    ],
    linger,
    next_steps: nextSteps,
    checks: [{ check: 'services_loaded_and_running', ok: status === 'pass' }],
    commands: [{ stdout_summary: 'Bearer abcdefghijklmnop' }],
  }
}

function fixture({ heartbeatStates, controlStates, service = serviceReceipt(), now = Date.parse('2026-07-13T12:00:00.000Z') }) {
  let clock = now
  const sequences = new Map([
    ['/heartbeat.json', [...heartbeatStates]],
    ['/control.json', [...controlStates]],
  ])
  const reads = new Map()
  return {
    deps: {
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      readRuntimeState: (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1)
        const states = sequences.get(path)
        return states[Math.min((reads.get(path) ?? 1) - 1, states.length - 1)]
      },
      buildServiceReceipt: async () => service,
    },
    reads,
  }
}

async function buildCase({ heartbeatStates, controlStates, service, requireControl, now }) {
  const f = fixture({ heartbeatStates, controlStates, service, now })
  const receipt = await buildContinuousRuntimeReceipt({
    agentId: 'hermes-manager',
    heartbeatStatePath: '/heartbeat.json',
    controlStatePath: '/control.json',
    ttlSec: 30,
    graceSec: 2,
    pollMs: 1_000,
    requireControl,
  }, f.deps)
  return { receipt, reads: f.reads }
}

test('continuous runtime receipt proves both daemon counters advance for the selected agent', async () => {
  const { receipt, reads } = await buildCase({
    heartbeatStates: [heartbeat(), heartbeat({ tick: 8, lastTickAt: '2026-07-13T12:00:01.000Z' })],
    controlStates: [control(), control({ poll: 13 })],
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-continuous-runtime-receipt/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.observation.heartbeat.tick.before, 7)
  assert.equal(receipt.observation.heartbeat.tick.after, 8)
  assert.equal(receipt.observation.control.poll.before, 12)
  assert.equal(receipt.observation.control.poll.after, 13)
  assert.equal(receipt.agent.agent_id, 'hermes-manager')
  assert.equal(receipt.agent.probe, 'alive')
  assert.equal(receipt.agent.heartbeat_status, 200)
  assert.equal(reads.get('/heartbeat.json'), 3)
  assert.equal(reads.get('/control.json'), 3)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop|nonce|signature|token/i)
})

test('observeAdvance expires at the heartbeat-derived deadline without real waiting', async () => {
  const f = fixture({
    heartbeatStates: [heartbeat(), heartbeat(), heartbeat()],
    controlStates: [control(), control(), control()],
  })
  const result = await observeAdvance({
    heartbeatStatePath: '/heartbeat.json',
    controlStatePath: '/control.json',
    graceSec: 2,
    pollMs: 10_000,
  }, f.deps)

  assert.equal(result.timed_out, true)
  assert.equal(result.heartbeat.after.tick, 7)
  assert.equal(result.control.after.poll, 12)
})

test('continuous runtime receipt preserves distinct failure evidence for the deterministic matrix', async (t) => {
  const cases = [
    {
      name: 'timeout',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat()],
      controlStates: [control(), control(), control()],
      reason: 'timeout',
    },
    {
      name: 'stale heartbeat',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8, lastTickAt: '2026-07-13T11:59:00.000Z' })],
      controlStates: [control(), control({ poll: 13 })],
      reason: 'heartbeat_stale',
    },
    {
      name: 'stopped service',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
      controlStates: [control(), control({ poll: 13 })],
      service: serviceReceipt({ status: 'fail', running: false }),
      reason: 'services_not_running',
    },
    {
      name: 'dead probe',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { probe: 'dead' } })],
      controlStates: [control(), control({ poll: 13 })],
      reason: 'agent_probe_dead',
    },
    {
      name: 'non-2xx heartbeat',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { heartbeat_status: 503 } })],
      controlStates: [control(), control({ poll: 13 })],
      reason: 'heartbeat_not_2xx',
    },
    {
      name: 'failed consume',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { consume: 'consume_failed' } })],
      controlStates: [control(), control({ poll: 13 })],
      reason: 'inbox_consume_failed',
    },
    {
      name: 'no control advancement',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 }), heartbeat({ tick: 8 })],
      controlStates: [control(), control(), control()],
      reason: 'control_poll_not_advanced',
    },
    {
      name: 'disabled systemd linger',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
      controlStates: [control(), control({ poll: 13 })],
      service: serviceReceipt({ linger: { enabled: false, raw: 'no' }, nextSteps: [LINGER_NEXT_STEP] }),
      reason: 'linger_disabled',
      nextStep: LINGER_NEXT_STEP,
    },
    {
      name: 'required control start mismatch',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
      controlStates: [control(), control({ poll: 13, outcome: { verb: 'stop' } })],
      requireControl: ['start'],
      reason: 'required_control_not_accepted',
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { receipt } = await buildCase(scenario)
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, scenario.reason)
      assert.ok(receipt.checks.some((check) => check.ok === false && check.reason === scenario.reason))
      if (scenario.nextStep) assert.deepEqual(receipt.next_steps, [scenario.nextStep])
    })
  }
})

test('parseArgs accepts every continuous-runtime option and repeatable control requirements', () => {
  const opts = parseArgs([
    '--agent', 'hermes-manager',
    '--heartbeat-state', '/tmp/heartbeat.json',
    '--control-state', '/tmp/control.json',
    '--service-manager', 'systemd',
    '--definition-dir', '/tmp/systemd',
    '--ttl-sec', '180',
    '--grace-sec', '15',
    '--poll-ms', '250',
    '--require-control', 'start',
    '--require-control', 'restart',
  ])

  assert.equal(opts.agentId, 'hermes-manager')
  assert.equal(opts.heartbeatStatePath, '/tmp/heartbeat.json')
  assert.equal(opts.controlStatePath, '/tmp/control.json')
  assert.equal(opts.serviceManager, 'systemd')
  assert.equal(opts.definitionDir, '/tmp/systemd')
  assert.equal(opts.ttlSec, 180)
  assert.equal(opts.graceSec, 15)
  assert.equal(opts.pollMs, 250)
  assert.deepEqual(opts.requireControl, ['start', 'restart'])
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--require-control', 'delete']), /unsupported control verb/)
})

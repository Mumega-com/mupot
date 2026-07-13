import assert from 'node:assert/strict'
import test from 'node:test'
import { buildContinuousRuntimeReceipt, main, observeAdvance, parseArgs } from './continuous-runtime-receipt.mjs'

const LINGER_NEXT_STEP = 'run loginctl enable-linger <username> with suitable host privileges, then rerun status'
const startedAt = '2026-07-13T12:00:00.000Z'

function heartbeat({ tick = 7, lastTickAt = '2026-07-13T12:00:00.000Z', agent = {} } = {}) {
  return {
    schema: 'mupot-fleet-daemon-state/v1',
    pid: 101,
    started_at: startedAt,
    tick,
    last_tick_at: lastTickAt,
    interval_sec: 15,
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
      result: 'open',
      nonce: 'nonce-123',
      signature: 'signature-123',
      ...outcome,
    },
  }
}

function serviceReceipt({
  status = 'pass',
  running = true,
  linger = null,
  nextSteps = [],
  serviceManager = linger ? 'systemd' : 'launchd',
  services,
  checks,
  commands = [],
} = {}) {
  const names = serviceManager === 'systemd'
    ? { heartbeat: 'fleet-daemon.service', control: 'fleet-control-daemon.service' }
    : { heartbeat: 'com.mumega.mupot-fleet-daemon', control: 'com.mumega.mupot-fleet-control' }
  const definitionDir = serviceManager === 'systemd' ? '/home/test/.config/systemd/user' : '/Users/test/Library/LaunchAgents'
  const defaultServices = [
    { key: 'heartbeat', name: names.heartbeat, loaded: true, enabled: true, running, pid: 101 },
    { key: 'control', name: names.control, loaded: true, enabled: true, running, pid: 102 },
  ]
  return {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: startedAt,
    status,
    platform: serviceManager === 'systemd' ? 'linux' : 'darwin',
    service_manager: serviceManager,
    action: 'status',
    definitions: [
      { service: 'heartbeat', path: `${definitionDir}/${names.heartbeat}${serviceManager === 'launchd' ? '.plist' : ''}`, sha256: 'a'.repeat(64) },
      { service: 'control', path: `${definitionDir}/${names.control}${serviceManager === 'launchd' ? '.plist' : ''}`, sha256: 'b'.repeat(64) },
    ],
    services: services ?? defaultServices,
    linger,
    commands,
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: nextSteps,
    checks: checks ?? [
      { check: 'services_loaded_and_running', ok: status === 'pass' },
      { check: 'command_output_secret_free', ok: true },
    ],
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
        const state = states[Math.min((reads.get(path) ?? 1) - 1, states.length - 1)]
        if (state instanceof Error) throw state
        return state
      },
      buildServiceReceipt: async () => service,
    },
    reads,
  }
}

async function buildCase({ heartbeatStates, controlStates, service, requireControl, now, pollMs = 1_000, serviceManager = 'launchd' }) {
  const f = fixture({ heartbeatStates, controlStates, service, now })
  const receipt = await buildContinuousRuntimeReceipt({
    agentId: 'hermes-manager',
    heartbeatStatePath: '/heartbeat.json',
    controlStatePath: '/control.json',
    ttlSec: 30,
    graceSec: 2,
    pollMs,
    requireControl,
    serviceManager,
  }, f.deps)
  return { receipt, reads: f.reads }
}

test('continuous runtime receipt proves both daemon counters advance for the selected agent', async () => {
  const { receipt } = await buildCase({
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
  assert.equal(receipt.generated_at, startedAt)
  assert.equal(receipt.observation.started_at, startedAt)
  assert.equal(receipt.observation.deadline_at, '2026-07-13T12:00:17.000Z')
  assert.equal(receipt.observation.timed_out, false)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop|nonce|signature|token/i)
})

test('control outcomes accept only exact producer tuples, including normal idle', async (t) => {
  const tuples = [
    { name: 'idle', outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' }, requireControl: [] },
    { name: 'start', outcome: { agent_id: 'hermes-manager', verb: 'start', accepted: true, result: 'open' }, requireControl: ['start'] },
    { name: 'stop', outcome: { agent_id: 'hermes-manager', verb: 'stop', accepted: true, result: 'close' }, requireControl: ['stop'] },
    { name: 'restart', outcome: { agent_id: 'hermes-manager', verb: 'restart', accepted: true, result: 'restart_open' }, requireControl: ['restart'] },
    { name: 'status', outcome: { agent_id: 'hermes-manager', verb: 'status', accepted: true, result: 'status_noop' }, requireControl: ['status'] },
  ]

  for (const tuple of tuples) {
    await t.test(tuple.name, async () => {
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: [control({ outcome: tuple.outcome }), control({ poll: 13, outcome: tuple.outcome })],
        requireControl: tuple.requireControl,
      })
      assert.equal(receipt.status, 'pass')
      assert.deepEqual(receipt.observation.control.last_outcome, tuple.outcome)
    })
  }
})

test('producer failure outcomes are valid evidence but never satisfy required control', async (t) => {
  const requestlessResults = [
    'peek_failed',
    'consume_failed',
    'invalid_json',
    'request_not_object',
    'bad_agent_id',
    'bad_verb',
    'bad_nonce',
    'bad_ts',
    'bad_sig',
    'stale',
    'bad_signature',
    'replay',
  ]
  const outcomes = [
    ...requestlessResults.map((result) => ({ name: `requestless ${result}`, agent_id: null, verb: null, accepted: false, result })),
    ...['start', 'stop', 'restart', 'status'].map((verb) => ({ name: `${verb} consume_failed`, agent_id: 'hermes-manager', verb, accepted: false, result: 'consume_failed' })),
    ...['start', 'stop', 'restart'].map((verb) => ({ name: `${verb} flight_command_failed`, agent_id: 'hermes-manager', verb, accepted: false, result: 'flight_command_failed' })),
  ]
  for (const outcome of outcomes) {
    await t.test(outcome.name, async () => {
      const { name, ...producerOutcome } = outcome
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: [control({ outcome: producerOutcome }), control({ poll: 13, outcome: producerOutcome })],
        requireControl: ['start'],
      })
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, 'required_control_not_accepted')
      assert.deepEqual(receipt.observation.control.last_outcome, producerOutcome)
    })
  }
})

test('producer-incompatible control tuples fail closed', async (t) => {
  const outcomes = [
    { agent_id: 'hermes-manager', verb: 'start', accepted: true, result: 'close' },
    { agent_id: 'hermes-manager', verb: 'status', accepted: false, result: 'flight_command_failed' },
    { agent_id: 'hermes-manager', verb: null, accepted: false, result: 'consume_failed' },
    { agent_id: 42, verb: null, accepted: false, result: 'peek_failed' },
  ]
  for (const outcome of outcomes) {
    await t.test(`${outcome.accepted}-${outcome.verb}-${outcome.result}`, async () => {
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: [control(), control({ poll: 13, outcome })],
      })
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, 'control_state_malformed')
    })
  }
})

test('arbitrary scanner-clean control results fail closed and are not emitted', async () => {
  const result = 's3cr3tvalue'
  const { receipt } = await buildCase({
    heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
    controlStates: [control(), control({ poll: 13, outcome: { result } })],
    requireControl: ['start'],
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.reason, 'control_state_malformed')
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(result))
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
  assert.equal(result.started_ms, Date.parse(startedAt))
  assert.equal(result.deadline_ms, Date.parse('2026-07-13T12:00:17.000Z'))
  assert.equal(result.completed_ms, result.deadline_ms)
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
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { consume: 'inbox_consume_fail' } })],
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
      serviceManager: 'systemd',
      reason: 'linger_disabled',
      nextStep: LINGER_NEXT_STEP,
    },
    {
      name: 'required control start mismatch',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
      controlStates: [control(), control({ poll: 13, outcome: { verb: 'stop', result: 'close' } })],
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
    '--require-control', 'status',
  ])

  assert.equal(opts.agentId, 'hermes-manager')
  assert.equal(opts.heartbeatStatePath, '/tmp/heartbeat.json')
  assert.equal(opts.controlStatePath, '/tmp/control.json')
  assert.equal(opts.serviceManager, 'systemd')
  assert.equal(opts.definitionDir, '/tmp/systemd')
  assert.equal(opts.ttlSec, 180)
  assert.equal(opts.graceSec, 15)
  assert.equal(opts.pollMs, 250)
  assert.deepEqual(opts.requireControl, ['start', 'status'])
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--require-control', 'delete']), /unsupported control verb/)
  assert.throws(() => parseArgs(['--agent', 'hermes-manager', '--require-control', 'open']), /unsupported control verb/)
  assert.throws(() => parseArgs(['--agent', 'hermes-manager', '--require-control', 'close']), /unsupported control verb/)
  assert.throws(() => parseArgs(['--agent', 'hermes-manager', '--heartbeat-state', '--ttl-sec', '30']), /--heartbeat-state requires a value/)
  assert.throws(() => parseArgs(['--agent', 'hermes-manager', '--grace-sec', '-0.5']), /--grace-sec/)
})

test('deadline expiry cannot pass even when the final evidence shows both counters advanced', async () => {
  const base = Date.parse(startedAt)
  let clock = base
  const heartbeatStates = [heartbeat(), heartbeat(), heartbeat({ tick: 8 }), heartbeat({ tick: 8 })]
  const controlStates = [control(), control(), control({ poll: 13 }), control({ poll: 13 })]
  const reads = new Map()
  const receipt = await buildContinuousRuntimeReceipt({
    agentId: 'hermes-manager',
    heartbeatStatePath: '/heartbeat.json',
    controlStatePath: '/control.json',
    serviceManager: 'launchd',
    definitionDir: null,
    ttlSec: 30,
    graceSec: 2,
    pollMs: 1_000,
    requireControl: [],
  }, {
    now: () => clock,
    sleep: async () => { clock = base + 18_000 },
    readRuntimeState: (path) => {
      const states = path === '/heartbeat.json' ? heartbeatStates : controlStates
      const count = (reads.get(path) ?? 0) + 1
      reads.set(path, count)
      return states[Math.min(count - 1, states.length - 1)]
    },
    buildServiceReceipt: async () => serviceReceipt(),
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.reason, 'timeout')
  assert.equal(receipt.observation.timed_out, true)
  assert.equal(receipt.observation.heartbeat.tick.after, 8)
  assert.equal(receipt.observation.control.poll.after, 13)
})

test('timeout reason matrix distinguishes one stalled counter from both stalled counters', async (t) => {
  const cases = [
    {
      name: 'heartbeat only stalled',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat()],
      controlStates: [control(), control({ poll: 13 }), control({ poll: 13 })],
      reason: 'heartbeat_tick_not_advanced',
    },
    {
      name: 'control only stalled',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 }), heartbeat({ tick: 8 })],
      controlStates: [control(), control(), control()],
      reason: 'control_poll_not_advanced',
    },
    {
      name: 'both stalled',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat()],
      controlStates: [control(), control(), control()],
      reason: 'timeout',
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { receipt } = await buildCase(scenario)
      assert.equal(receipt.reason, scenario.reason)
    })
  }
})

test('post-timeout reread failures preserve the last valid timeout evidence', async (t) => {
  const malformedHeartbeat = { schema: 'wrong' }
  const malformedControl = { schema: 'wrong' }
  const cases = [
    {
      name: 'both stalled and final heartbeat read throws',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat(), new Error('final heartbeat read failed')],
      controlStates: [control(), control(), control(), control()],
      reason: 'timeout',
    },
    {
      name: 'both stalled and final heartbeat is malformed',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat(), malformedHeartbeat],
      controlStates: [control(), control(), control(), control()],
      reason: 'timeout',
    },
    {
      name: 'control stalled and final heartbeat read throws',
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 }), heartbeat({ tick: 8 }), new Error('final heartbeat read failed')],
      controlStates: [control(), control(), control(), control()],
      reason: 'control_poll_not_advanced',
    },
    {
      name: 'heartbeat stalled and final control is malformed',
      heartbeatStates: [heartbeat(), heartbeat(), heartbeat(), heartbeat()],
      controlStates: [control(), control({ poll: 13 }), control({ poll: 13 }), malformedControl],
      reason: 'heartbeat_tick_not_advanced',
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { receipt } = await buildCase({ ...scenario, pollMs: 10_000 })
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, scenario.reason)
      assert.equal(receipt.observation.timed_out, true)
      assert.equal(receipt.observation.deadline_at, '2026-07-13T12:00:17.000Z')
      assert.equal(receipt.generated_at, receipt.observation.deadline_at)
    })
  }
})

test('non-timeout success still fails closed when its final evidence is malformed', async () => {
  const { receipt } = await buildCase({
    heartbeatStates: [heartbeat(), heartbeat({ tick: 8 }), { schema: 'wrong' }],
    controlStates: [control(), control({ poll: 13 }), control({ poll: 13 })],
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.reason, 'heartbeat_state_malformed')
})

test('actual heartbeat producer consume failures fail while all non-failure values remain accepted', async (t) => {
  for (const consume of ['inbox_peek_fail', 'inbox_consume_fail', 'inbox_handler_fail']) {
    await t.test(`rejects ${consume}`, async () => {
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { consume } })],
        controlStates: [control(), control({ poll: 13 })],
      })
      assert.equal(receipt.reason, 'inbox_consume_failed')
    })
  }
  for (const consume of ['consumed', 'not_configured', 'not_attempted', 'inbox_empty', 'not_attempted_probe_dead', 'not_attempted_heartbeat_failed']) {
    await t.test(`accepts ${consume}`, async () => {
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8, agent: { consume } })],
        controlStates: [control(), control({ poll: 13 })],
      })
      assert.equal(receipt.checks.find((entry) => entry.check === 'inbox_consume_not_failed')?.ok, true)
    })
  }
})

test('systemd unknown linger evidence retains a valid failed service projection', async () => {
  const { receipt } = await buildCase({
    heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
    controlStates: [control(), control({ poll: 13 })],
    service: serviceReceipt({ status: 'fail', linger: { enabled: null, raw: null } }),
    serviceManager: 'systemd',
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.reason, 'services_not_running')
  assert.deepEqual(receipt.service.linger, { enabled: null, raw: null })
})

test('service validation accepts producer-shaped launchd and systemd pass and failure envelopes', async (t) => {
  const launchdFailure = serviceReceipt({
    status: 'fail',
    running: false,
    services: [],
    nextSteps: ["'/usr/bin/node' service-manager.mjs 'status'"],
    checks: [
      { ok: false, check: 'service_operation_failed', reason: 'status failed' },
      { ok: true, check: 'command_output_secret_free' },
    ],
  })
  const systemdFailure = serviceReceipt({ status: 'fail', running: false, serviceManager: 'systemd' })
  systemdFailure.services = systemdFailure.services.slice(0, 1)

  const cases = [
    { name: 'launchd pass', service: serviceReceipt(), serviceManager: 'launchd', expected: 'pass' },
    { name: 'systemd pass', service: serviceReceipt({ serviceManager: 'systemd', linger: { enabled: true, raw: 'yes' } }), serviceManager: 'systemd', expected: 'pass' },
    { name: 'launchd producer failure with zero services', service: launchdFailure, serviceManager: 'launchd', expected: 'fail' },
    { name: 'systemd producer failure with partial services', service: systemdFailure, serviceManager: 'systemd', expected: 'fail' },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: [control(), control({ poll: 13 })],
        service: scenario.service,
        serviceManager: scenario.serviceManager,
      })
      assert.equal(receipt.status, scenario.expected)
      if (scenario.expected === 'fail') assert.equal(receipt.reason, 'services_not_running')
      assert.notEqual(receipt.reason, 'service_receipt_malformed')
    })
  }
})

test('service validation rejects wrong-manager and incomplete or unsafe passing envelopes', async (t) => {
  const cases = [
    { name: 'wrong manager', service: serviceReceipt({ serviceManager: 'systemd' }), serviceManager: 'launchd' },
    { name: 'missing platform', mutate: (value) => { delete value.platform } },
    { name: 'missing definitions', mutate: (value) => { delete value.definitions } },
    { name: 'partial definitions', mutate: (value) => { value.definitions.pop() } },
    { name: 'partial services', mutate: (value) => { value.services.pop() } },
    { name: 'malformed commands', mutate: (value) => { value.commands = [{}] } },
    { name: 'incomplete preservation claim', mutate: (value) => { delete value.preserved_data.private_keys } },
    { name: 'malformed next steps', mutate: (value) => { value.next_steps = 'none' } },
    { name: 'secret in ignored command field', mutate: (value) => { value.commands = [{ executable: '/bin/echo', argv: [], code: 0, stdout_summary: 'Bearer abcdefghijklmnop', stderr_summary: '' }] } },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const service = structuredClone(scenario.service ?? serviceReceipt())
      scenario.mutate?.(service)
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: [control(), control({ poll: 13 })],
        service,
        serviceManager: scenario.serviceManager ?? 'launchd',
      })
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, 'service_receipt_malformed')
      assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop/)
    })
  }
})

test('malformed and exceptional evidence returns distinct v1 failure receipts instead of rejecting', async (t) => {
  const scenarios = [
    {
      name: 'heartbeat read error',
      reason: 'heartbeat_state_read_failed',
      check: 'heartbeat_state_readable',
      deps: { readRuntimeState: (path) => { if (path === '/heartbeat.json') throw new Error('Bearer abcdefghijklmnop'); return control() } },
    },
    {
      name: 'heartbeat malformed',
      reason: 'heartbeat_state_malformed',
      check: 'heartbeat_state_v1',
      heartbeatStates: [{ schema: 'wrong', tick: 7 }],
    },
    {
      name: 'control read error',
      reason: 'control_state_read_failed',
      check: 'control_state_readable',
      deps: { readRuntimeState: (path) => { if (path === '/control.json') throw new Error('mupot_abcdefghijklmnop'); return heartbeat() } },
    },
    {
      name: 'control malformed',
      reason: 'control_state_malformed',
      check: 'control_state_v1',
      controlStates: [{ schema: 'wrong', poll: 12 }],
    },
    {
      name: 'service status error',
      reason: 'service_status_failed',
      check: 'service_status_readable',
      deps: { buildServiceReceipt: async () => { throw new Error('sk-proj-abcdefghijklmnopqrstuvwxyz') } },
    },
    {
      name: 'service receipt malformed',
      reason: 'service_receipt_malformed',
      check: 'service_receipt_v1',
      service: { status: 'pass' },
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const f = fixture({
        heartbeatStates: scenario.heartbeatStates ?? [heartbeat(), heartbeat({ tick: 8 })],
        controlStates: scenario.controlStates ?? [control(), control({ poll: 13 })],
        service: scenario.service,
      })
      const receipt = await buildContinuousRuntimeReceipt({
        agentId: 'hermes-manager',
        heartbeatStatePath: '/heartbeat.json',
        controlStatePath: '/control.json',
        serviceManager: 'launchd',
        definitionDir: null,
        ttlSec: 30,
        graceSec: 2,
        pollMs: 1_000,
        requireControl: [],
      }, { ...f.deps, ...scenario.deps })
      assert.equal(receipt.receipt_type, 'mupot-fleet-continuous-runtime-receipt/v1')
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, scenario.reason)
      assert.deepEqual(receipt.checks, [{ check: scenario.check, ok: false, reason: scenario.reason }])
      assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop|abcdefghijklmnopqrstuvwxyz/)
    })
  }
})

test('exact v1 evidence validation rejects wrong schemas, invalid ranges, and incomplete passing services', async (t) => {
  const cases = [
    { name: 'heartbeat schema', heartbeatState: heartbeat({ tick: 8 }), mutate: (value) => { value.schema = { private_key: '-----BEGIN PRIVATE KEY-----' } }, reason: 'heartbeat_state_malformed' },
    { name: 'heartbeat pid', heartbeatState: heartbeat({ tick: 8 }), mutate: (value) => { value.pid = 0 }, reason: 'heartbeat_state_malformed' },
    { name: 'heartbeat timestamp', heartbeatState: heartbeat({ tick: 8 }), mutate: (value) => { value.last_tick_at = `2026-07-13T12:00:01.000Z mupot_abcdefghijklmnop` }, reason: 'heartbeat_state_malformed' },
    { name: 'agent probe', heartbeatState: heartbeat({ tick: 8 }), mutate: (value) => { value.agents[0].probe = 'Bearer abcdefghijklmnop' }, reason: 'heartbeat_state_malformed' },
    { name: 'agent consume', heartbeatState: heartbeat({ tick: 8 }), mutate: (value) => { value.agents[0].consume = 'mupot_abcdefghijklmnop' }, reason: 'heartbeat_state_malformed' },
    { name: 'control schema', controlState: control({ poll: 13 }), mutate: (value) => { value.schema = 'mupot_abcdefghijklmnop' }, reason: 'control_state_malformed' },
    { name: 'control timestamp', controlState: control({ poll: 13 }), mutate: (value) => { value.last_poll_at = 'Bearer abcdefghijklmnop' }, reason: 'control_state_malformed' },
    { name: 'control agent', controlState: control({ poll: 13 }), mutate: (value) => { value.last_outcome.agent_id = 'mupot_abcdefghijklmnop' }, reason: 'control_state_malformed' },
    { name: 'control result', controlState: control({ poll: 13 }), mutate: (value) => { value.last_outcome.result = 'Bearer abcdefghijklmnop' }, reason: 'control_state_malformed' },
    { name: 'service action', service: serviceReceipt(), mutate: (value) => { value.action = 'install' }, reason: 'service_receipt_malformed' },
    { name: 'service manager', service: serviceReceipt(), mutate: (value) => { value.service_manager = 'mupot_abcdefghijklmnop' }, reason: 'service_receipt_malformed' },
    { name: 'service entries', service: serviceReceipt(), mutate: (value) => { value.services = [] }, reason: 'service_receipt_malformed' },
    { name: 'service key', service: serviceReceipt(), mutate: (value) => { value.services[0].key = 'mupot_abcdefghijklmnop' }, reason: 'service_receipt_malformed' },
    { name: 'service name', service: serviceReceipt(), mutate: (value) => { value.services[0].name = 'mupot_abcdefghijklmnop' }, reason: 'service_receipt_malformed' },
    { name: 'service check', service: serviceReceipt(), mutate: (value) => { value.checks[0].check = 'Bearer abcdefghijklmnop' }, reason: 'service_receipt_malformed' },
    { name: 'duplicate service check', service: serviceReceipt(), mutate: (value) => { value.checks.push({ check: 'command_output_secret_free', ok: true }) }, reason: 'service_receipt_malformed' },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const afterHeartbeat = structuredClone(scenario.heartbeatState ?? heartbeat({ tick: 8 }))
      const afterControl = structuredClone(scenario.controlState ?? control({ poll: 13 }))
      const service = structuredClone(scenario.service ?? serviceReceipt())
      scenario.mutate(scenario.heartbeatState ? afterHeartbeat : scenario.controlState ? afterControl : service)
      const { receipt } = await buildCase({
        heartbeatStates: [heartbeat(), afterHeartbeat],
        controlStates: [control(), afterControl],
        service,
      })
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.reason, scenario.reason)
      assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop|BEGIN PRIVATE KEY/)
    })
  }
})

test('library option and clock validation fails quickly and bounded polling rejects clocks without enough progress', async (t) => {
  const valid = {
    agentId: 'hermes-manager',
    heartbeatStatePath: '/heartbeat.json',
    controlStatePath: '/control.json',
    serviceManager: 'launchd',
    definitionDir: null,
    ttlSec: 30,
    graceSec: 2,
    pollMs: 1_000,
    requireControl: [],
  }
  const invalid = [
    { ...valid, agentId: 'NOT VALID' },
    { ...valid, heartbeatStatePath: 'relative.json' },
    { ...valid, controlStatePath: '' },
    { ...valid, serviceManager: 'none' },
    { ...valid, definitionDir: 'relative' },
    { ...valid, ttlSec: Number.POSITIVE_INFINITY },
    { ...valid, ttlSec: 86_401 },
    { ...valid, graceSec: -0.5 },
    { ...valid, graceSec: 3_601 },
    { ...valid, pollMs: 0 },
    { ...valid, pollMs: 60_001 },
    { ...valid, requireControl: ['open'] },
  ]
  for (const [index, opts] of invalid.entries()) {
    await t.test(`invalid options ${index + 1}`, async () => {
      const receipt = await buildContinuousRuntimeReceipt(opts, {})
      assert.equal(receipt.reason, 'invalid_options')
      assert.equal(receipt.checks[0].check, 'options_valid')
    })
  }

  const f = fixture({ heartbeatStates: [heartbeat()], controlStates: [control()] })
  f.deps.now = () => Number.NaN
  const invalidClock = await buildContinuousRuntimeReceipt(valid, f.deps)
  assert.equal(invalidClock.reason, 'invalid_clock')
  assert.equal(invalidClock.checks[0].check, 'clock_valid')

  const frozen = fixture({ heartbeatStates: [heartbeat()], controlStates: [control()] })
  frozen.deps.now = () => Date.parse(startedAt)
  frozen.deps.sleep = async () => {}
  const bounded = await buildContinuousRuntimeReceipt(valid, frozen.deps)
  assert.equal(bounded.status, 'fail')
  assert.equal(bounded.reason, 'invalid_clock')
  assert.equal(bounded.checks[0].check, 'clock_valid')

  let slowlyAdvancingClock = Date.parse(startedAt)
  const slow = fixture({ heartbeatStates: [heartbeat()], controlStates: [control()] })
  slow.deps.now = () => {
    const current = slowlyAdvancingClock
    slowlyAdvancingClock += 1
    return current
  }
  slow.deps.sleep = async () => {}
  const capped = await buildContinuousRuntimeReceipt(valid, slow.deps)
  assert.equal(capped.status, 'fail')
  assert.equal(capped.reason, 'invalid_clock')
  assert.equal(capped.checks[0].check, 'clock_valid')
})

test('injected CLI main preserves exit codes and emits actionable canonical redaction', async (t) => {
  await t.test('option error exits 2', async () => {
    let stdout = ''
    let stderr = ''
    const secret = 'mupot_abcdefghijklmnop'
    const code = await main([`--${secret}`], {
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value },
    })
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(stderr, /unknown argument/)
    assert.match(stderr, /\[REDACTED:mupot_token\]/)
    assert.doesNotMatch(stderr, new RegExp(secret))
  })

  await t.test('failed observation receipt exits 1', async () => {
    let stdout = ''
    let stderr = ''
    const code = await main(['--agent', 'hermes-manager'], {
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value },
      readRuntimeState: () => { throw new Error('Bearer abcdefghijklmnop') },
      now: () => Date.parse(startedAt),
    })
    assert.equal(code, 1)
    assert.equal(stderr, '')
    const receipt = JSON.parse(stdout)
    assert.equal(receipt.reason, 'heartbeat_state_read_failed')
    assert.doesNotMatch(stdout, /abcdefghijklmnop/)
  })

  await t.test('failed service status exits 1', async () => {
    let stdout = ''
    let stderr = ''
    const f = fixture({
      heartbeatStates: [heartbeat(), heartbeat({ tick: 8 })],
      controlStates: [control(), control({ poll: 13 })],
    })
    const code = await main([
      '--agent', 'hermes-manager',
      '--heartbeat-state', '/heartbeat.json',
      '--control-state', '/control.json',
      '--service-manager', 'launchd',
    ], {
      ...f.deps,
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value },
      buildServiceReceipt: async () => { throw new Error('Bearer abcdefghijklmnop') },
    })
    assert.equal(code, 1)
    assert.equal(stderr, '')
    const receipt = JSON.parse(stdout)
    assert.equal(receipt.reason, 'service_status_failed')
    assert.doesNotMatch(stdout, /abcdefghijklmnop/)
  })
})

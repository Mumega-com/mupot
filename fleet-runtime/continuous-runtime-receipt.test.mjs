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
      result: 'started',
      nonce: 'nonce-123',
      signature: 'signature-123',
      ...outcome,
    },
  }
}

function serviceReceipt({ status = 'pass', running = true, linger = null, nextSteps = [] } = {}) {
  const serviceManager = linger ? 'systemd' : 'launchd'
  return {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: startedAt,
    status,
    service_manager: serviceManager,
    action: 'status',
    services: [
      { key: 'heartbeat', name: serviceManager === 'systemd' ? 'fleet-daemon.service' : 'com.mumega.mupot-fleet-daemon', loaded: true, enabled: true, running, pid: 101 },
      { key: 'control', name: serviceManager === 'systemd' ? 'fleet-control-daemon.service' : 'com.mumega.mupot-fleet-control', loaded: true, enabled: true, running, pid: 102 },
    ],
    linger,
    next_steps: nextSteps,
    checks: [
      { check: 'services_loaded_and_running', ok: status === 'pass' },
      { check: 'command_output_secret_free', ok: true },
    ],
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
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.reason, 'services_not_running')
  assert.deepEqual(receipt.service.linger, { enabled: null, raw: null })
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

test('library option and clock validation fails quickly and a frozen clock has a derived iteration bound', async (t) => {
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

  let reads = 0
  const frozen = fixture({ heartbeatStates: [heartbeat()], controlStates: [control()] })
  frozen.deps.now = () => Date.parse(startedAt)
  frozen.deps.sleep = async () => {}
  const originalRead = frozen.deps.readRuntimeState
  frozen.deps.readRuntimeState = (path) => { reads += 1; return originalRead(path) }
  const bounded = await buildContinuousRuntimeReceipt(valid, frozen.deps)
  assert.equal(bounded.reason, 'invalid_clock')
  assert.equal(bounded.checks[0].check, 'clock_valid')
  assert.ok(reads <= 6, `expected frozen clock to fail quickly, got ${reads} reads`)
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

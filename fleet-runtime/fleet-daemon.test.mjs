// node --test fleet-daemon.test.mjs   (node >= 18 built-in runner, no deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { validateConfig, runProbe, runInboxCommand, detachAgents, runDaemonOnce, runHeartbeatCycle } from './fleet-daemon.mjs'

const okCfg = () => ({
  base_url: 'https://your-pot.example.com',
  tenant: 'acme',
  agents: [{ agent_id: 'agent-one', type: 'builder', runtime: 'claude-code', probe: 'exit 0' }],
})

test('validateConfig: normalizes a valid config', () => {
  const c = validateConfig(okCfg())
  assert.equal(c.baseUrl, 'https://your-pot.example.com')
  assert.equal(c.tenant, 'acme')
  assert.equal(c.intervalSec, 75)
  assert.equal(c.agents.length, 1)
})

test('validateConfig: uses an optional state_file or the runtime state default', () => {
  assert.equal(validateConfig(okCfg()).statePath, `${process.env.HOME}/.fleet/state/fleet-daemon.json`)
  assert.equal(validateConfig({ ...okCfg(), state_file: '/tmp/test-state.json' }).statePath, '/tmp/test-state.json')
})

test('validateConfig: STERILE — tenant is required (no default)', () => {
  const { tenant, ...noTenant } = okCfg()
  assert.throws(() => validateConfig(noTenant), /tenant is required/)
  assert.throws(() => validateConfig({ ...okCfg(), tenant: '' }), /tenant is required/)
})

test('validateConfig: rejects non-http base_url', () => {
  assert.throws(() => validateConfig({ ...okCfg(), base_url: 'ftp://x' }), /base_url/)
})

test('validateConfig: rejects empty agents', () => {
  assert.throws(() => validateConfig({ ...okCfg(), agents: [] }), /non-empty/)
})

test('validateConfig: rejects bad agent_id', () => {
  assert.throws(() => validateConfig({ ...okCfg(), agents: [{ agent_id: 'Bad_ID', probe: 'exit 0' }] }), /agent_id/)
})

test('validateConfig: rejects missing/empty probe', () => {
  assert.throws(() => validateConfig({ ...okCfg(), agents: [{ agent_id: 'a', probe: '   ' }] }), /probe/)
})

test('validateConfig: clamps interval floor→default and ceiling→120 (presence-TTL guard)', () => {
  assert.equal(validateConfig({ ...okCfg(), interval_sec: 5 }).intervalSec, 75)
  assert.equal(validateConfig({ ...okCfg(), interval_sec: 90 }).intervalSec, 90)
  assert.equal(validateConfig({ ...okCfg(), interval_sec: 500 }).intervalSec, 120)
})

test('validateConfig: per-agent defaults (type/runtime/lifecycle)', () => {
  const c = validateConfig({ ...okCfg(), agents: [{ agent_id: 'x', probe: 'exit 0' }] })
  assert.equal(c.agents[0].type, 'generic')
  assert.equal(c.agents[0].runtime, 'claude-code')
  assert.equal(c.agents[0].lifecycle, 'on_demand')
  assert.equal(c.agents[0].inbox, null)
})

test('validateConfig: optional inbox handler is normalized and limit is clamped', () => {
  const c = validateConfig({
    ...okCfg(),
    agents: [{
      agent_id: 'x',
      probe: 'exit 0',
      inbox: { command: 'node handle-inbox.mjs', limit: 500 },
    }],
  })
  assert.deepEqual(c.agents[0].inbox, { command: 'node handle-inbox.mjs', limit: 100 })
})

test('validateConfig: accepts an absolute direct-argv inbox handler', () => {
  const c = validateConfig({
    ...okCfg(),
    agents: [{ agent_id: 'x', probe: 'exit 0', inbox: { argv: ['/usr/bin/node', '/opt/handler.mjs'], limit: 20 } }],
  })
  assert.deepEqual(c.agents[0].inbox, { argv: ['/usr/bin/node', '/opt/handler.mjs'], limit: 20 })
})

test('validateConfig: carries a bounded inbox supervisor timeout', () => {
  const c = validateConfig({
    ...okCfg(),
    agents: [{
      agent_id: 'x', probe: 'exit 0',
      inbox: { argv: ['/usr/bin/node', '/opt/handler.mjs'], limit: 20, timeout_ms: 150_000 },
    }],
  })
  assert.equal(c.agents[0].inbox.timeoutMs, 150_000)
  for (const timeout_ms of [999, 600_001, 1.5, '150000']) {
    assert.throws(() => validateConfig({
      ...okCfg(), agents: [{ agent_id: 'x', probe: 'exit 0', inbox: { command: 'handler', timeout_ms } }],
    }), /timeout_ms invalid/)
  }
})

test('validateConfig: rejects malformed inbox handler config', () => {
  assert.throws(() => validateConfig({
    ...okCfg(),
    agents: [{ agent_id: 'x', probe: 'exit 0', inbox: { command: '   ' } }],
  }), /exactly one of command or argv/)
  assert.throws(() => validateConfig({
    ...okCfg(),
    agents: [{ agent_id: 'x', probe: 'exit 0', inbox: { command: 'echo x', argv: ['/bin/echo', 'x'] } }],
  }), /exactly one of command or argv/)
})

test('runProbe: exit 0 → alive', async () => { assert.equal(await runProbe('exit 0'), true) })
test('runProbe: exit 1 → dead', async () => { assert.equal(await runProbe('exit 1'), false) })
test('runProbe: a hanging probe times out → dead (never throws)', async () => {
  assert.equal(await runProbe('sleep 5', 200), false)
})

test('runInboxCommand: exits 0 only after reading the JSON payload', async () => {
  const ok = await runInboxCommand(
    `node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => process.exit(JSON.parse(s).messages[0].body === 'hi' ? 0 : 1))"`,
    JSON.stringify({ messages: [{ body: 'hi' }] }),
  )
  assert.equal(ok, true)
})

test('runInboxCommand: non-zero handler result is false', async () => {
  assert.equal(await runInboxCommand('exit 7', JSON.stringify({ messages: [] })), false)
})

test('runInboxCommand: hanging handler times out', async () => {
  assert.equal(await runInboxCommand('sleep 5', '{}', 200), false)
})

test('runInboxCommand: direct argv bypasses the shell and receives only adapter-safe environment', async () => {
  const calls = []
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options })
    const child = new EventEmitter()
    child.pid = 12
    child.stdin = { on() {}, end() { queueMicrotask(() => child.emit('exit', 0)) } }
    return child
  }
  const ok = await runInboxCommand(
    ['/usr/bin/node', '/opt/handler.mjs'], '{}', 1000, spawnImpl,
    {
      PATH: '/usr/bin', HOME: '/home/mupot', MUPOT_AGENT_TOKEN: 'must-not-pass',
      MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token', MUPOT_PLUGIN_MODE: 'operator',
      OPENAI_API_KEY: 'must-not-pass',
    },
  )
  assert.equal(ok, true)
  assert.equal(calls[0].executable, '/usr/bin/node')
  assert.deepEqual(calls[0].args, ['/opt/handler.mjs'])
  assert.equal(calls[0].options.shell, false)
  assert.deepEqual(calls[0].options.env, {
    HOME: '/home/mupot', PATH: '/usr/bin',
    MUPOT_AGENT_TOKEN_FILE: '/run/secrets/mupot-agent/token', MUPOT_PLUGIN_MODE: 'operator',
  })
})

test('detachAgents: sends signed detach only for agents observed live', async () => {
  const cfg = validateConfig({
    base_url: 'https://pot.example.com',
    tenant: 't',
    agents: [
      { agent_id: 'alive', probe: 'exit 0' },
      { agent_id: 'never-live', probe: 'exit 0' },
    ],
  })
  const calls = []
  const results = await detachAgents(
    cfg,
    new Map([['alive', 'key-alive'], ['never-live', 'key-never']]),
    new Set(['alive']),
    async (baseUrl, agentId, opts) => {
      calls.push({ baseUrl, agentId, tenant: opts.tenant, key: opts.privKey })
      return { ok: true, status: 200, json: { ok: true } }
    },
  )
  assert.deepEqual(calls, [{ baseUrl: 'https://pot.example.com', agentId: 'alive', tenant: 't', key: 'key-alive' }])
  assert.deepEqual(results, [{ agent: 'alive', ok: true, status: 200 }])
})

test('runDaemonOnce: alive agent heartbeats, drains inbox, and marks live', async () => {
  const cfg = validateConfig({
    base_url: 'https://pot.example.com',
    tenant: 't',
    agents: [{
      agent_id: 'alive',
      type: 'builder',
      runtime: 'codex',
      lifecycle: 'managed',
      probe: 'probe-alive',
      inbox: { command: 'handle-inbox', limit: 5 },
    }],
  })
  const live = new Set()
  const calls = []
  const results = await runDaemonOnce(cfg, new Map([['alive', 'key-alive']]), live, {
    log: () => {},
    runProbe: async (cmd) => cmd === 'probe-alive',
    signedAttach: async (baseUrl, agentId, opts) => {
      calls.push({ type: 'attach', baseUrl, agentId, tenant: opts.tenant, key: opts.privKey, host: opts.host })
      return { ok: true, status: 200, json: { ok: true } }
    },
    signedInbox: async (baseUrl, agentId, opts) => {
      calls.push({ type: 'inbox', baseUrl, agentId, tenant: opts.tenant, peek: opts.peek, limit: opts.limit, key: opts.privKey })
      if (opts.peek) {
        return {
          ok: true,
          status: 200,
          json: { remaining: 0, messages: [{ id: 'm1', seq: 1, from_agent: 'sender', kind: 'request', body: 'wake' }] },
        }
      }
      return { ok: true, status: 200, json: { messages: [{ id: 'm1' }] } }
    },
    runInboxCommand: async (cmd, payload, timeoutMs) => {
      calls.push({ type: 'handler', cmd, payload: JSON.parse(payload), timeoutMs })
      return true
    },
  })

  assert.deepEqual(live, new Set(['alive']))
  assert.deepEqual(results, [{
    agent: 'alive',
    probe: 'alive',
    heartbeat: { ok: true, status: 200 },
    inbox: { agent: 'alive', ok: true, action: 'inbox_consumed', status: 200, messages: 1, remaining: 0, consumed: true },
  }])
  assert.equal(calls[0].type, 'attach')
  assert.deepEqual(calls.map((c) => c.type), ['attach', 'inbox', 'handler', 'inbox'])
  assert.equal(calls[2].payload.messages[0].body, 'wake')
  assert.equal(calls[2].timeoutMs, 30_000)
  // #21 slice 2: each heartbeat self-reports THIS machine's hostname.
  assert.equal(calls[0].host, hostname())
})

test('runDaemonOnce: dead probe skips heartbeat and inbox', async () => {
  const cfg = validateConfig({
    base_url: 'https://pot.example.com',
    tenant: 't',
    agents: [{ agent_id: 'dead', probe: 'exit 1', inbox: { command: 'handle-inbox' } }],
  })
  const results = await runDaemonOnce(cfg, new Map([['dead', 'key-dead']]), new Set(), {
    log: () => {},
    runProbe: async () => false,
    signedAttach: async () => { throw new Error('should not attach') },
    signedInbox: async () => { throw new Error('should not read inbox') },
  })
  assert.deepEqual(results, [{
    agent: 'dead',
    probe: 'dead',
    heartbeat: { ok: false, skipped: true },
    inbox: { ok: null, action: 'not_attempted_probe_dead', messages: 0, consumed: false },
  }])
})

test('runHeartbeatCycle: publishes completed daemon ticks in order and survives state write failures', async () => {
  const cfg = validateConfig({ ...okCfg(), interval_sec: 75, state_file: '/tmp/daemon-state.json' })
  const results = [{
    agent: 'agent-one',
    probe: 'alive',
    heartbeat: { ok: true, status: 200 },
    inbox: { messages: 1, action: 'inbox_consumed' },
  }]
  const writes = []
  const logs = []
  const events = []
  const state = { tick: 0 }
  let finishFirst
  const firstOperation = new Promise((resolve) => { finishFirst = resolve })
  const runDaemonOnceFn = async () => {
    events.push('operation')
    return firstOperation
  }
  const options = {
    statePath: '/tmp/daemon-state.json',
    pid: 123,
    startedAt: '2026-07-13T12:00:00.000Z',
    now: () => new Date('2026-07-13T12:01:00.000Z'),
    runDaemonOnce: runDaemonOnceFn,
    writeRuntimeState: (path, published) => {
      events.push(`write:${published.tick}`)
      writes.push({ path, state: published })
    },
    log: (entry) => logs.push(entry),
  }
  const firstCycle = runHeartbeatCycle(cfg, new Map(), new Set(), state, options)
  await Promise.resolve()
  assert.deepEqual(events, ['operation'])
  finishFirst(results)
  assert.equal(await firstCycle, results)
  assert.equal(state.tick, 1)

  options.now = () => new Date('2026-07-13T12:01:15.000Z')
  options.writeRuntimeState = () => { throw new Error('disk full') }
  assert.equal(await runHeartbeatCycle(cfg, new Map(), new Set(), state, options), results)
  assert.equal(state.tick, 2)

  options.now = () => new Date('2026-07-13T12:02:30.000Z')
  options.writeRuntimeState = (path, published) => {
    events.push(`write:${published.tick}`)
    writes.push({ path, state: published })
  }
  assert.equal(await runHeartbeatCycle(cfg, new Map(), new Set(), state, options), results)

  assert.deepEqual(events, ['operation', 'write:1', 'operation', 'operation', 'write:3'])
  assert.deepEqual(writes.map((write) => write.state.tick), [1, 3])
  assert.equal(state.tick, 3)
  assert.equal(logs.at(-1).event, 'state_write_failed')
  assert.equal(logs.at(-1).state_path, '/tmp/daemon-state.json')
})

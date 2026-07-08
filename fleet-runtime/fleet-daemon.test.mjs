// node --test fleet-daemon.test.mjs   (node >= 18 built-in runner, no deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, runProbe, runInboxCommand, detachAgents, runDaemonOnce } from './fleet-daemon.mjs'

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

test('validateConfig: rejects malformed inbox handler config', () => {
  assert.throws(() => validateConfig({
    ...okCfg(),
    agents: [{ agent_id: 'x', probe: 'exit 0', inbox: { command: '   ' } }],
  }), /inbox.command/)
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
      calls.push({ type: 'attach', baseUrl, agentId, tenant: opts.tenant, key: opts.privKey })
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
    runInboxCommand: async (cmd, payload) => {
      calls.push({ type: 'handler', cmd, payload: JSON.parse(payload) })
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

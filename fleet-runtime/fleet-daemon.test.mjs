// node --test fleet-daemon.test.mjs   (node >= 18 built-in runner, no deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, runProbe } from './fleet-daemon.mjs'

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
})

test('runProbe: exit 0 → alive', async () => { assert.equal(await runProbe('exit 0'), true) })
test('runProbe: exit 1 → dead', async () => { assert.equal(await runProbe('exit 1'), false) })
test('runProbe: a hanging probe times out → dead (never throws)', async () => {
  assert.equal(await runProbe('sleep 5', 200), false)
})

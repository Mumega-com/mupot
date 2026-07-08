// node --test runtime-receipt.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReceipt, parseArgs } from './runtime-receipt.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-runtime-receipt-'))
}

function daemonConfig(overrides = {}) {
  return {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    interval_sec: 30,
    agents: [{
      agent_id: 'agent-one',
      type: 'builder',
      runtime: 'codex',
      lifecycle: 'managed',
      probe: 'test -f /tmp/agent-one.alive',
      inbox: { command: 'node ~/.fleet/runtime/inbox-handler.mjs ~/.fleet/inbox-handler.json', limit: 10 },
    }],
    ...overrides,
  }
}

function writeDaemon(raw) {
  const dir = tmpDir()
  const path = join(dir, 'daemon.json')
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return path
}

test('runtime receipt passes when one daemon cycle attaches and consumes inbox', async () => {
  const daemonPath = writeDaemon(daemonConfig())
  const receipt = await buildReceipt({
    daemonPath,
    agents: ['agent-one'],
    keyLoader: async (agentId) => `key:${agentId}`,
    runDaemonOnce: async (cfg, keys, liveAgents) => {
      assert.equal(cfg.agents.length, 1)
      assert.equal(keys.get('agent-one'), 'key:agent-one')
      liveAgents.add('agent-one')
      return [{
        agent: 'agent-one',
        probe: 'alive',
        heartbeat: { ok: true, status: 200 },
        inbox: { agent: 'agent-one', ok: true, action: 'inbox_consumed', status: 200, messages: 1, remaining: 0, consumed: true },
      }]
    },
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-runtime-receipt/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.summary.failed, 0)
  assert.deepEqual(receipt.inputs.selected_agents, ['agent-one'])
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'signed_attach_ok' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'signed_inbox_handoff_consumed' && c.ok))
})

test('runtime receipt fails before live calls when an agent key cannot load', async () => {
  const daemonPath = writeDaemon(daemonConfig())
  const receipt = await buildReceipt({
    daemonPath,
    agents: ['agent-one'],
    keyLoader: async () => { throw new Error('missing key') },
    runDaemonOnce: async () => { throw new Error('should not run without a key') },
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.check === 'agent_private_key_loaded' && c.ok === false && /missing key/.test(c.reason)))
  assert.ok(receipt.checks.some((c) => c.check === 'runnable_agents_present' && c.ok === false))
  assert.deepEqual(receipt.agents, [])
})

test('runtime receipt warns when inbox is configured but no messages are available to hand off', async () => {
  const daemonPath = writeDaemon(daemonConfig())
  const receipt = await buildReceipt({
    daemonPath,
    agents: ['agent-one'],
    keyLoader: async (agentId) => `key:${agentId}`,
    runDaemonOnce: async () => [{
      agent: 'agent-one',
      probe: 'alive',
      heartbeat: { ok: true, status: 200 },
      inbox: { agent: 'agent-one', ok: true, action: 'inbox_empty', status: 200, messages: 0, remaining: 0, consumed: false },
    }],
  })

  assert.equal(receipt.status, 'warn')
  assert.ok(receipt.checks.some((c) => c.check === 'signed_inbox_peek_ok' && c.ok === true))
  assert.ok(receipt.checks.some((c) => c.check === 'inbox_no_messages_to_handoff' && c.ok === null))
})

test('parseArgs accepts repeated and comma-separated agent filters', () => {
  const opts = parseArgs(['--daemon', './daemon.json', '--agent', 'agent-one,agent-two', '--agent', 'brain'])
  assert.ok(opts.daemonPath.endsWith('/daemon.json'))
  assert.deepEqual(opts.agents, ['agent-one', 'agent-two', 'brain'])
})

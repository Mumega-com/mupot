// node --test cutover-receipt.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReceipt, controlRuns, parseArgs } from './cutover-receipt.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-cutover-receipt-'))
}

function writeJson(dir, name, value) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

function hostReceipt(status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-host-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status,
    checks: [],
  }
}

function runtimeReceipt(agentId, overrides = {}) {
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: '2026-07-08T00:01:00.000Z',
    status: 'pass',
    inputs: { selected_agents: [agentId] },
    agents: [{ agent: agentId }],
    checks: [
      { ok: true, component: 'fleet-daemon', check: 'signed_attach_ok', agent_id: agentId },
      { ok: true, component: 'fleet-daemon', check: 'signed_inbox_handoff_consumed', agent_id: agentId },
    ],
    ...overrides,
  }
}

function controlReceipt(agentId, verb) {
  const action = verb === 'start' ? 'open' : verb === 'stop' ? 'close' : 'restart_open'
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: '2026-07-08T00:02:00.000Z',
    status: 'pass',
    checks: [
      { ok: true, component: 'fleet-control-daemon', check: 'control_request_executed', agent_id: agentId, verb, action },
    ],
    poll: { ok: true, action, request: { agent_id: agentId, verb } },
  }
}

test('cutover receipt passes when host, runtime, start, and stop receipts pass for an agent', async () => {
  const dir = tmpDir()
  const host = writeJson(dir, 'host.json', hostReceipt())
  const runtime = writeJson(dir, 'runtime.json', runtimeReceipt('agent-one'))
  const start = writeJson(dir, 'control-start.json', controlReceipt('agent-one', 'start'))
  const stop = writeJson(dir, 'control-stop.json', controlReceipt('agent-one', 'stop'))

  const receipt = await buildReceipt({
    agents: ['agent-one'],
    hostPath: host,
    runtimePaths: [runtime],
    controlPaths: [start, stop],
    requiredControlVerbs: ['start', 'stop'],
  })

  assert.equal(receipt.receipt_type, 'mupot-sos-cutover-gate/v1')
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.summary.failed, 0)
  assert.ok(receipt.checks.some((c) => c.check === 'runtime_inbox_handoff_for_agent' && c.ok === true))
  assert.equal(receipt.checks.filter((c) => c.check === 'control_verb_for_agent' && c.ok === true).length, 2)
})

test('cutover receipt fails when runtime receipt did not prove inbox handoff', async () => {
  const dir = tmpDir()
  const host = writeJson(dir, 'host.json', hostReceipt())
  const runtime = writeJson(dir, 'runtime.json', runtimeReceipt('agent-one', {
    checks: [
      { ok: true, component: 'fleet-daemon', check: 'signed_attach_ok', agent_id: 'agent-one' },
      { ok: null, component: 'fleet-daemon', check: 'inbox_no_messages_to_handoff', agent_id: 'agent-one' },
    ],
  }))
  const start = writeJson(dir, 'control-start.json', controlReceipt('agent-one', 'start'))
  const stop = writeJson(dir, 'control-stop.json', controlReceipt('agent-one', 'stop'))

  const receipt = await buildReceipt({
    agents: ['agent-one'],
    hostPath: host,
    runtimePaths: [runtime],
    controlPaths: [start, stop],
    requiredControlVerbs: ['start', 'stop'],
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.check === 'runtime_inbox_handoff_for_agent' && c.ok === false))
})

test('cutover receipt fails by default when stop control evidence is missing', async () => {
  const dir = tmpDir()
  const host = writeJson(dir, 'host.json', hostReceipt())
  const runtime = writeJson(dir, 'runtime.json', runtimeReceipt('agent-one'))
  const start = writeJson(dir, 'control-start.json', controlReceipt('agent-one', 'start'))

  const receipt = await buildReceipt({
    agents: ['agent-one'],
    hostPath: host,
    runtimePaths: [runtime],
    controlPaths: [start],
    requiredControlVerbs: ['start', 'stop'],
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.check === 'control_verb_for_agent' && c.required_verb === 'stop' && c.ok === false))
})

test('cutover receipt treats restart as both start and stop evidence', async () => {
  const dir = tmpDir()
  const host = writeJson(dir, 'host.json', hostReceipt())
  const runtime = writeJson(dir, 'runtime.json', runtimeReceipt('agent-one'))
  const restart = writeJson(dir, 'control-restart.json', controlReceipt('agent-one', 'restart'))

  const receipt = await buildReceipt({
    agents: ['agent-one'],
    hostPath: host,
    runtimePaths: [runtime],
    controlPaths: [restart],
    requiredControlVerbs: ['start', 'stop'],
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.checks.filter((c) => c.check === 'control_verb_for_agent' && c.matched_verb === 'restart').length, 2)
})

test('parseArgs accepts repeated receipt paths and comma-separated agents', () => {
  const opts = parseArgs([
    '--agent', 'agent-one,agent-two',
    '--host', './host.json',
    '--runtime', './runtime-one.json',
    '--runtime', './runtime-two.json',
    '--control', './start.json,./stop.json',
    '--require-control-verb', 'start',
  ])

  assert.deepEqual(opts.agents, ['agent-one', 'agent-two'])
  assert.equal(opts.runtimePaths.length, 2)
  assert.equal(opts.controlPaths.length, 2)
  assert.deepEqual(opts.requiredControlVerbs, ['start'])
})

test('controlRuns falls back to poll request metadata for older checks', () => {
  const runs = controlRuns([{
    checks: [{ ok: true, component: 'fleet-control-daemon', check: 'control_request_executed', action: 'open' }],
    poll: { request: { agent_id: 'agent-one', verb: 'start' } },
  }])
  assert.deepEqual(runs, [{ agent_id: 'agent-one', verb: 'start', action: 'open' }])
})

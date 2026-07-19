import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateContainerReadiness } from './container-entrypoint.mjs'

const heartbeat = {
  schema: 'mupot-fleet-daemon-state/v1',
  last_tick_at: '2026-07-18T20:00:00.000Z',
  tick: 4,
  agents: [{ agent_id: 'dme-hermes-k8s', probe: true, heartbeat_status: 200, consume: 'inbox_empty' }],
}
const control = {
  schema: 'mupot-fleet-control-state/v1',
  last_poll_at: '2026-07-18T20:00:02.000Z',
  poll: 7,
}

test('readiness requires live children and fresh redacted daemon state', () => {
  const result = evaluateContainerReadiness({
    heartbeat,
    control,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  })
  assert.deepEqual(result, { ready: true, reasons: [] })
})

test('readiness fails closed for stale, malformed, or dead runtime evidence', () => {
  assert.deepEqual(evaluateContainerReadiness({
    heartbeat,
    control,
    childrenAlive: false,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: false, reasons: ['child_not_running'] })

  assert.deepEqual(evaluateContainerReadiness({
    heartbeat: { ...heartbeat, last_tick_at: '2026-07-18T19:00:00.000Z' },
    control,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: false, reasons: ['heartbeat_stale'] })

  assert.deepEqual(evaluateContainerReadiness({
    heartbeat: { schema: 'wrong', last_tick_at: heartbeat.last_tick_at },
    control,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: false, reasons: ['heartbeat_invalid'] })
})

test('readiness requires at least one healthy agent result', () => {
  const unhealthy = { ...heartbeat, agents: [{ ...heartbeat.agents[0], probe: false }] }
  assert.deepEqual(evaluateContainerReadiness({
    heartbeat: unhealthy,
    control,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: false, reasons: ['agent_unhealthy'] })
})

test('on-demand hosts do not require a control daemon state file', () => {
  assert.deepEqual(evaluateContainerReadiness({
    heartbeat,
    control: null,
    controlRequired: false,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: true, reasons: [] })
})

test('inbox-required readiness proves a successful signed inbox operation', () => {
  assert.deepEqual(evaluateContainerReadiness({
    heartbeat,
    control: null,
    controlRequired: false,
    inboxRequired: true,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: true, reasons: [] })

  const failedInbox = {
    ...heartbeat,
    agents: [{ ...heartbeat.agents[0], consume: 'inbox_peek_fail' }],
  }
  assert.deepEqual(evaluateContainerReadiness({
    heartbeat: failedInbox,
    control: null,
    controlRequired: false,
    inboxRequired: true,
    childrenAlive: true,
    nowMs: Date.parse('2026-07-18T20:01:00.000Z'),
    maxStaleMs: 120000,
  }), { ready: false, reasons: ['signed_inbox_unhealthy'] })
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GROK_STOP_CONTINUATION_CAP,
  assertCanonicalRuntimeIdentity,
  bearerConsumerAllowed,
  formatGrokNudge,
  grokBlockDecision,
  grokContinuationAllowed,
  grokFailOpen,
  grokStopShouldDrain,
  grokStopShouldSkip,
  isUnsafeStopHookDelivery,
  planInboxConsume,
  verifyConsumedBatch,
} from './grok-inbox-adapter.mjs'

const REQUEST = {
  seq: 3537,
  id: 'msg-scope',
  from_agent: 'c855f82c-1eeb-409d-94d2-f11e9dd18968',
  kind: 'request',
  body: 'Scope the grok Stop-hook connector',
  request_id: 'kasra-ack-loom-head-5585fe76-and-direction-20260901',
  in_reply_to: null,
}

test('nudge preserves seq, ids, and ACK correlation (reuses Claude contract)', () => {
  const nudge = formatGrokNudge(REQUEST)
  assert.match(nudge, /seq: 3537/)
  assert.match(nudge, /id: msg-scope/)
  assert.match(nudge, /from_agent: c855f82c-1eeb-409d-94d2-f11e9dd18968/)
  assert.match(nudge, /request_id: kasra-ack-loom-head-5585fe76-and-direction-20260901/)
  assert.match(nudge, /ACK required: send kind=ack in_reply_to=kasra-ack-loom-head-5585fe76-and-direction-20260901/)
})

test('drain only on genuine Stop end_turn', () => {
  assert.deepEqual(grokStopShouldDrain({ hookEventName: 'Stop', reason: 'end_turn' }), {
    drain: true, reason: 'end_turn',
  })
  assert.deepEqual(grokStopShouldDrain({ hook_event_name: 'stop', reason: 'end_turn' }), {
    drain: true, reason: 'end_turn',
  })
  assert.deepEqual(grokStopShouldDrain({ hookEventName: 'Stop', reason: 'channel_closed' }), {
    drain: false, reason: 'session_end_stop',
  })
  assert.deepEqual(grokStopShouldDrain({ hookEventName: 'Stop', reason: 'shutdown' }), {
    drain: false, reason: 'session_end_stop',
  })
  assert.deepEqual(grokStopShouldDrain({ hookEventName: 'SessionStart' }), {
    drain: false, reason: 'not_stop_event',
  })
})

test('stopHookActive plus prior delivery skips re-inject', () => {
  assert.deepEqual(
    grokStopShouldSkip({ stopHookActive: true }, true),
    { skip: true, reason: 'stop_hook_active_already_delivered' },
  )
  assert.deepEqual(
    grokStopShouldSkip({ stopHookActive: false }, true),
    { skip: false, reason: 'ok' },
  )
  assert.deepEqual(
    grokStopShouldSkip({ stopHookActive: true }, false),
    { skip: false, reason: 'ok' },
  )
})

test('Grok 8-continuation cap', () => {
  assert.equal(GROK_STOP_CONTINUATION_CAP, 8)
  assert.deepEqual(grokContinuationAllowed(0), { ok: true, reason: 'under_cap' })
  assert.deepEqual(grokContinuationAllowed(7), { ok: true, reason: 'under_cap' })
  assert.deepEqual(grokContinuationAllowed(8), { ok: false, reason: 'continuation_cap' })
})

test('Stop-hook consume is all-or-nothing (unlike herdr polling)', () => {
  assert.deepEqual(planInboxConsume({ peekedCount: 2, deliveredCount: 1 }), {
    consume: 0, reason: 'delivery_incomplete',
  })
  assert.deepEqual(planInboxConsume({ peekedCount: 2, deliveredCount: 2 }), {
    consume: 2, reason: 'delivered',
  })
})

test('bearer fence missing mode refuses (fail closed)', () => {
  assert.deepEqual(bearerConsumerAllowed({}), { ok: false, reason: 'fence_mode_missing' })
  assert.deepEqual(bearerConsumerAllowed({ mode: 'signed_only' }), {
    ok: false, reason: 'consumer_fenced',
  })
})

test('identity is the bound agent, never a directory name', () => {
  const expected = '17aa283f-8cdb-4c1f-864f-1974ee45a033'
  assert.deepEqual(
    assertCanonicalRuntimeIdentity({ bound_agent_id: expected }, expected),
    { ok: true, reason: 'identity_ok', agent_id: expected },
  )
  assert.deepEqual(
    assertCanonicalRuntimeIdentity({ bound_agent_id: 'other' }, expected),
    { ok: false, reason: 'wrong_bound_agent' },
  )
})

test('YC27: consume + suppressOutput without block is unsafe', () => {
  assert.equal(isUnsafeStopHookDelivery({
    peek: false, consumed: true, suppressOutput: true, text: 'no correlation',
  }), true)
  assert.equal(isUnsafeStopHookDelivery({
    peek: true, decision: 'block', suppressOutput: true,
    text: formatGrokNudge(REQUEST),
  }), false)
})

test('verifyConsumedBatch catches concurrent drain (multiplicity)', () => {
  const a = { id: 'a', seq: 1 }
  const b = { id: 'b', seq: 2 }
  assert.deepEqual(verifyConsumedBatch({ expected: [a, b], consumed: [a, b] }), {
    ok: true, reason: 'batch_verified', dropped: [], missing: [],
  })
  assert.equal(
    verifyConsumedBatch({ expected: [a], consumed: [a, b] }).ok,
    false,
  )
})

test('fail-open envelope and block decision', () => {
  assert.deepEqual(grokFailOpen(), { suppressOutput: true })
  assert.deepEqual(grokBlockDecision('mail'), { decision: 'block', reason: 'mail' })
})

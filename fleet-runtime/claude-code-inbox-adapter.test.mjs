import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCanonicalRuntimeIdentity,
  bearerConsumerAllowed,
  formatClaudeCodeNudge,
  isUnsafeStopHookDelivery,
  legacyStopHookFormat,
  planInboxConsume,
} from './claude-code-inbox-adapter.mjs'

const REQUEST = {
  seq: 131,
  id: 'msg-yc27',
  from_agent: '942e2845-87ba-4bbf-9c64-2d2e8817c7cc',
  kind: 'request',
  body: 'YC27 canary — ACK this request',
  request_id: 'yc27-kasra-cro-state-20260723-01',
  in_reply_to: null,
}

test('YC27 regression: legacy Stop-hook format drops request_id / in_reply_to', () => {
  const legacy = legacyStopHookFormat(REQUEST)
  assert.equal(legacy.includes('request_id'), false)
  assert.equal(legacy.includes(REQUEST.request_id), false)
  assert.match(legacy, /\[request\]/)
  assert.match(legacy, /YC27 canary/)
})

test('authoritative nudge preserves seq, ids, and ACK correlation', () => {
  const nudge = formatClaudeCodeNudge(REQUEST)
  assert.match(nudge, /seq: 131/)
  assert.match(nudge, /id: msg-yc27/)
  assert.match(nudge, /from_agent: 942e2845-87ba-4bbf-9c64-2d2e8817c7cc/)
  assert.match(nudge, /request_id: yc27-kasra-cro-state-20260723-01/)
  assert.match(nudge, /^in_reply_to: $/m)
  assert.match(nudge, /ACK required: send kind=ack in_reply_to=yc27-kasra-cro-state-20260723-01/)
})

test('YC27 regression: consume + suppressOutput without block is unsafe', () => {
  assert.equal(isUnsafeStopHookDelivery({
    peek: false,
    consumed: true,
    suppressOutput: true,
    text: legacyStopHookFormat(REQUEST),
  }), true)
  assert.equal(isUnsafeStopHookDelivery({
    peek: true,
    suppressOutput: true,
    decision: 'block',
    text: formatClaudeCodeNudge(REQUEST),
  }), false)
  assert.equal(isUnsafeStopHookDelivery({
    peek: false,
    suppressOutput: false,
    decision: 'block',
    text: formatClaudeCodeNudge(REQUEST),
  }), false)
})

test('consume only after every peeked message was delivered', () => {
  assert.deepEqual(planInboxConsume({ peekedCount: 0, deliveredCount: 0 }), {
    consume: 0, reason: 'inbox_empty',
  })
  assert.deepEqual(planInboxConsume({ peekedCount: 2, deliveredCount: 1 }), {
    consume: 0, reason: 'delivery_incomplete',
  })
  assert.deepEqual(planInboxConsume({ peekedCount: 2, deliveredCount: 2 }), {
    consume: 2, reason: 'delivered',
  })
})

test('bearer consumer refuses signed_only fence (no stale/wrong consumer)', () => {
  assert.deepEqual(bearerConsumerAllowed({ mode: 'bearer_only' }), {
    ok: true, reason: 'bearer_only',
  })
  assert.deepEqual(bearerConsumerAllowed({}), {
    ok: true, reason: 'bearer_only',
  })
  assert.deepEqual(bearerConsumerAllowed({ mode: 'signed_only' }), {
    ok: false, reason: 'consumer_fenced',
  })
})

test('runtime identity must match canonical Kasra agent id', () => {
  const expected = 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
  assert.deepEqual(
    assertCanonicalRuntimeIdentity({ bound_agent_id: expected }, expected),
    { ok: true, reason: 'identity_ok', agent_id: expected },
  )
  assert.deepEqual(
    assertCanonicalRuntimeIdentity({ bound_agent_id: 'other-agent' }, expected),
    { ok: false, reason: 'wrong_bound_agent' },
  )
  assert.deepEqual(
    assertCanonicalRuntimeIdentity({ bound_agent_id: null }, expected),
    { ok: false, reason: 'token_not_agent_bound' },
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'

import { runCycle } from '../scripts/kasra-inbox-watch.mjs'

const AGENT = 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
const REQUEST = {
  seq: 131,
  id: 'msg-yc27',
  from_agent: '942e2845-87ba-4bbf-9c64-2d2e8817c7cc',
  kind: 'request',
  body: 'YC27 canary — ACK this request',
  request_id: 'yc27-kasra-receive-canary',
  in_reply_to: null,
}

test('runCycle peeks, delivers with correlation, then consumes exactly once', async () => {
  const calls = []
  const delivered = []
  const mcpCall = async (_token, name, args) => {
    calls.push({ name, args })
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { agent_id: AGENT, mode: 'bearer_only', generation: 0 }
    if (name === 'inbox' && args.peek === true) {
      return { messages: [REQUEST], remaining: 0 }
    }
    if (name === 'inbox' && args.peek === false) {
      return { messages: [REQUEST], remaining: 0 }
    }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: (text) => {
      delivered.push(text)
      return { ok: true }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.consumed, 1)
  assert.equal(result.delivered, 1)
  assert.equal(result.receipts[0].request_id, 'yc27-kasra-receive-canary')
  assert.match(delivered[0], /request_id: yc27-kasra-receive-canary/)
  assert.match(delivered[0], /ACK required/)
  assert.deepEqual(calls.map((c) => [c.name, c.args?.peek]), [
    ['boot_context', undefined],
    ['inbox_consumer_status', undefined],
    ['inbox', true],
    ['inbox', false],
  ])
})

test('runCycle refuses consume when tmux handoff fails (no silent drop)', async () => {
  let consumed = false
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST], remaining: 0 }
    if (name === 'inbox' && args.peek === false) {
      consumed = true
      return { messages: [REQUEST], remaining: 0 }
    }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: false, reason: 'tmux_send_failed' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delivery_incomplete')
  assert.equal(result.consumed, 0)
  assert.equal(consumed, false)
})

test('runCycle reports a silent drop when consume returns rows it never delivered', async () => {
  // A concurrent consumer shifts the window between peek and consume: the count
  // still matches, but the row that leaves the queue was never shown to anyone.
  const OTHER = { ...REQUEST, seq: 999, id: 'msg-never-delivered', request_id: 'other-req' }
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST], remaining: 0 }
    if (name === 'inbox' && args.peek === false) return { messages: [OTHER], remaining: 0 }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  // The old count check passed this case: 1 delivered, 1 consumed.
  assert.equal(result.consumed, 1)
  assert.equal(result.delivered, 1)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'consumed_undelivered_message')
  assert.deepEqual(result.dropped, ['id:msg-never-delivered'])
  assert.deepEqual(result.missing, ['id:msg-yc27'])
})

test('runCycle stays green when consume returns exactly the delivered batch', async () => {
  const second = { ...REQUEST, seq: 132, id: 'msg-yc27-b', request_id: 'yc27-b' }
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST, second], remaining: 0 }
    // Same set, different order — order is not identity.
    if (name === 'inbox' && args.peek === false) return { messages: [second, REQUEST], remaining: 0 }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'delivered_and_consumed')
  assert.deepEqual(result.dropped, [])
  assert.deepEqual(result.missing, [])
})

test('runCycle reports a short consume without calling it a drop', async () => {
  const second = { ...REQUEST, seq: 133, id: 'msg-yc27-c', request_id: 'yc27-c' }
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST, second], remaining: 0 }
    if (name === 'inbox' && args.peek === false) return { messages: [REQUEST], remaining: 0 }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'consume_incomplete')
  assert.deepEqual(result.dropped, [])
  // Still queued, so it redelivers next cycle — not a loss.
  assert.deepEqual(result.missing, ['id:msg-yc27-c'])
})

test('runCycle counts duplicate ids by multiplicity, not set membership', async () => {
  // A malformed consume repeating one id must not read as covering two rows.
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) {
      return { messages: [REQUEST, { ...REQUEST, seq: 132, id: 'msg-two' }], remaining: 0 }
    }
    if (name === 'inbox' && args.peek === false) {
      return { messages: [REQUEST, REQUEST], remaining: 0 }
    }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'consumed_undelivered_message')
  assert.deepEqual(result.dropped, ['id:msg-yc27'])
  assert.deepEqual(result.missing, ['id:msg-two'])
})

test('runCycle refuses a fence answer with no explicit mode (fail closed)', async () => {
  for (const fence of [{}, { mode: '' }, { mode: null }, { agent_id: AGENT }]) {
    const result = await runCycle({
      token: 'x',
      mcpCall: async (_t, name) => {
        if (name === 'boot_context') return { bound_agent_id: AGENT }
        if (name === 'inbox_consumer_status') return fence
        throw new Error('must stop at fence — never reach inbox')
      },
      deliverToTmux: () => ({ ok: true }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'fence_mode_missing')
    assert.equal(result.consumed, 0)
  }
})

test('runCycle refuses wrong bound agent / signed_only fence', async () => {
  const wrong = await runCycle({
    token: 'x',
    mcpCall: async (_t, name) => {
      if (name === 'boot_context') return { bound_agent_id: 'not-kasra' }
      throw new Error('should stop at identity')
    },
    deliverToTmux: () => ({ ok: true }),
  })
  assert.equal(wrong.reason, 'wrong_bound_agent')

  const fenced = await runCycle({
    token: 'x',
    mcpCall: async (_t, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'signed_only' }
      throw new Error('should stop at fence')
    },
    deliverToTmux: () => ({ ok: true }),
  })
  assert.equal(fenced.reason, 'consumer_fenced')
})

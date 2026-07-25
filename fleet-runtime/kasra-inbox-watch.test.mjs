import test from 'node:test'
import assert from 'node:assert/strict'

import { runCycle, main } from '../scripts/kasra-inbox-watch.mjs'

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

// --- main() lifecycle: preflight-before-lock, terminal-reason-mid-loop -----
//
// Required by adversarial review of #540 (two rounds): (1) identity/token
// must be validated BEFORE the singleton lock is acquired, so a
// permanently-misconfigured launch can never monopolize it; (2) the SAME is
// true of the consumer fence, which the first preflight fix missed — a
// fenced-out-but-identity-valid watcher still held the lock forever, logging
// `fence_refuse` every cycle. These exercise main()'s actual control flow
// with injected deps, not just the underlying checks in isolation.

function neverCalled(name) {
  return () => { throw new Error(`must not reach ${name} in this path`) }
}

test('main() refuses a wrong-agent token before ever acquiring the lock', async () => {
  const exits = []
  await main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: 'not-kasra' }
      throw new Error(`must stop at identity preflight, got ${name}`)
    },
    acquireLock: neverCalled('acquireLock'),
    exit: (code) => exits.push(code),
  })
  assert.deepEqual(exits, [1])
})

test('main() refuses a fenced-out (signed_only) consumer before ever acquiring the lock', async () => {
  const exits = []
  await main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'signed_only', generation: 3 }
      throw new Error(`must stop at fence preflight, got ${name}`)
    },
    acquireLock: neverCalled('acquireLock'),
    exit: (code) => exits.push(code),
  })
  assert.deepEqual(exits, [1])
})

test('main() releases and exits when a cycle reports a terminal reason mid-loop, instead of looping forever', async () => {
  const exits = []
  let released = false
  let cycleCalls = 0
  await main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      // Preflight must pass cleanly — this is about a LATER cycle going bad.
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
      throw new Error(`unexpected preflight call ${name}`)
    },
    acquireLock: async () => ({
      ok: true,
      reason: 'lock_acquired',
      holder_pid: process.pid,
      release: () => { released = true },
    }),
    runCycle: async () => {
      cycleCalls += 1
      // The token was rotated out from under a long-running watcher — the
      // NEXT cycle now sees itself as fenced, even though preflight (above)
      // was clean at launch.
      return { ok: false, reason: 'consumer_fenced', consumed: 0, delivered: 0 }
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'), // must exit before ever sleeping/retrying
  })
  assert.equal(cycleCalls, 1, 'must not keep cycling after a terminal reason')
  assert.equal(released, true, 'must release the lock rather than hold it forever')
  assert.deepEqual(exits, [1])
})

test('main() keeps looping (does not exit) on a non-terminal cycle failure', async () => {
  const exits = []
  let released = false
  let cycleCalls = 0
  let slept = false
  const STOP = new Error('stop the test after one loop iteration') // bail out, not a real failure

  await assert.rejects(() => main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
      throw new Error(`unexpected preflight call ${name}`)
    },
    acquireLock: async () => ({
      ok: true,
      reason: 'lock_acquired',
      holder_pid: process.pid,
      release: () => { released = true },
    }),
    runCycle: async () => {
      cycleCalls += 1
      // A transient, non-authorization failure — e.g. tmux delivery hiccup —
      // must NOT be treated as terminal.
      return { ok: false, reason: 'consume_skipped', consumed: 0, delivered: 0 }
    },
    exit: (code) => exits.push(code),
    sleep: async () => {
      slept = true
      throw STOP // the loop is otherwise infinite; this is how the test ends it
    },
  }), STOP)

  assert.equal(cycleCalls, 1)
  assert.equal(slept, true, 'a non-terminal failure must proceed to the retry sleep, not exit')
  assert.equal(released, false, 'must not release on a non-terminal failure')
  assert.deepEqual(exits, [])
})

// Required by adversarial review of ecbf21b: a token revoked/expired MID-RUN
// (after a clean preflight already passed) does not make runCycle() RETURN a
// terminal reason — mcpCall() throws on HTTP auth failures and on MCP
// tool-level failures, so runCycle() rejects instead. The prior fix only
// checked `result.reason` on a successful return; a thrown error was still
// just logged and retried forever, holding the lock. These drive the actual
// throwing shape (not just a returned {reason}) through main()'s real catch
// block.

test('main() releases and exits when a cycle THROWS an HTTP 401 mid-loop (revoked token), instead of looping forever', async () => {
  const exits = []
  let released = false
  let cycleCalls = 0
  await main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
      throw new Error(`unexpected preflight call ${name}`)
    },
    acquireLock: async () => ({
      ok: true,
      reason: 'lock_acquired',
      holder_pid: process.pid,
      release: () => { released = true },
    }),
    runCycle: async () => {
      cycleCalls += 1
      // Exactly what mcpCall() throws for `if (!res.ok) throw new Error(...)`
      // when the mupot MCP endpoint rejects a revoked bearer token.
      throw new Error('mcp http 401')
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'), // must exit before ever sleeping/retrying
  })
  assert.equal(cycleCalls, 1, 'must not keep cycling after a terminal thrown error')
  assert.equal(released, true, 'must release the lock rather than hold it forever')
  assert.deepEqual(exits, [1])
})

test('main() releases and exits when a cycle THROWS a tool-level identity/fence failure mid-loop', async () => {
  const exits = []
  let released = false
  await main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
      throw new Error(`unexpected preflight call ${name}`)
    },
    acquireLock: async () => ({
      ok: true,
      reason: 'lock_acquired',
      holder_pid: process.pid,
      release: () => { released = true },
    }),
    runCycle: async () => {
      // Exactly what mcpCall() throws for `if (inner.ok === false) throw new
      // Error('mcp tool ' + name + ' failed: ' + reason)` when the server
      // itself reports the bound identity no longer matches (e.g. the token
      // was reissued to a different agent mid-run).
      throw new Error('mcp tool boot_context failed: wrong_bound_agent')
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'),
  })
  assert.equal(released, true, 'must release the lock rather than hold it forever')
  assert.deepEqual(exits, [1])
})

test('main() keeps looping (does not exit) when a cycle throws a transient/non-auth error', async () => {
  const exits = []
  let released = false
  let cycleCalls = 0
  let slept = false
  const STOP = new Error('stop the test after one loop iteration')

  await assert.rejects(() => main({
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only', generation: 0 }
      throw new Error(`unexpected preflight call ${name}`)
    },
    acquireLock: async () => ({
      ok: true,
      reason: 'lock_acquired',
      holder_pid: process.pid,
      release: () => { released = true },
    }),
    runCycle: async () => {
      cycleCalls += 1
      // A genuinely transient failure — mupot momentarily down/slow — must
      // NOT be classified as terminal.
      throw new Error('mcp http 503')
    },
    exit: (code) => exits.push(code),
    sleep: async () => {
      slept = true
      throw STOP
    },
  }), STOP)

  assert.equal(cycleCalls, 1)
  assert.equal(slept, true, 'a transient thrown error must proceed to the retry sleep, not exit')
  assert.equal(released, false, 'must not release on a transient thrown error')
  assert.deepEqual(exits, [])
})

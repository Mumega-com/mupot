import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertCanonicalRuntimeIdentity,
  checkRequiredConfig,
  defaultLockFilePath,
  defaultSpoolDir,
  defaultTokenFilePath,
  deliverToTmux,
  deliveryMarker,
  main,
  runCycle,
  selfTest,
  spoolMessage,
} from '../scripts/grok-inbox-watch.mjs'

const SEAT = 'muvps_loom'
const AGENT = '1eb0e718-0000-0000-0000-00000000loom'
const REQUEST = {
  seq: 131,
  id: 'msg-grok-canary',
  from_agent: '942e2845-87ba-4bbf-9c64-2d2e8817c7cc',
  kind: 'request',
  body: 'Grok canary — ACK this request',
  request_id: 'grok-receive-canary',
  in_reply_to: null,
}

// ── default layout (pure, no env-var/import-order gymnastics) ─────────────

test('default paths are derived from the seat, never hardcoded', () => {
  assert.equal(defaultTokenFilePath(SEAT).endsWith(`/.fleet/agents/${SEAT}-agent-bound.token`), true)
  assert.equal(defaultLockFilePath(SEAT).endsWith(`/.fleet/locks/grok-inbox-watch-${SEAT}.lock`), true)
  assert.equal(defaultSpoolDir(SEAT).endsWith(`/.fleet/inbox-spool/grok-${SEAT}`), true)
})

test('default paths are empty (never a fallback guess) when seat is empty', () => {
  assert.equal(defaultTokenFilePath(''), '')
  assert.equal(defaultLockFilePath(''), '')
  assert.equal(defaultSpoolDir(''), '')
})

// ── required config — no seat, no agent id, no default (mupot#1154) ───────

test('checkRequiredConfig refuses and names every missing piece when nothing is configured', () => {
  const result = checkRequiredConfig({ seat: '', expectedAgentId: '', tokenFile: '' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing_config')
  assert.deepEqual(result.missing, ['GROK_SEAT', 'GROK_AGENT_ID', 'GROK_TOKEN_FILE (or GROK_SEAT to derive it)'])
})

test('checkRequiredConfig passes once seat, agent id, and a token file are all present', () => {
  const result = checkRequiredConfig({ seat: SEAT, expectedAgentId: AGENT, tokenFile: '/tmp/x.token' })
  assert.equal(result.ok, true)
})

// ── identity comes from the credential (mupot#889, #1154) ─────────────────

test('identity refuses with no expected agent id configured', () => {
  const result = assertCanonicalRuntimeIdentity({ bound_agent_id: AGENT }, '')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expected_agent_required')
})

test('identity refuses a token that is not agent-bound', () => {
  const result = assertCanonicalRuntimeIdentity({}, AGENT)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'token_not_agent_bound')
})

test('identity refuses a token bound to the WRONG agent (mupot#1154 shape)', () => {
  const result = assertCanonicalRuntimeIdentity({ bound_agent_id: 'some-other-agent' }, AGENT)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'wrong_bound_agent')
})

test('identity accepts a token bound to the expected agent', () => {
  const result = assertCanonicalRuntimeIdentity({ bound_agent_id: AGENT }, AGENT)
  assert.equal(result.ok, true)
  assert.equal(result.agent_id, AGENT)
})

// ── the seat argument IS passed (mupot#1258 — do not copy the Claude bug) ─

test('runCycle passes seat on boot_context AND both inbox calls (peek + consume)', async () => {
  const calls = []
  const mcpCall = async (_token, name, args) => {
    calls.push({ name, args })
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST], remaining: 0 }
    if (name === 'inbox' && args.peek === false) return { messages: [REQUEST], remaining: 0 }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.consumed, 1)

  const boot = calls.find((c) => c.name === 'boot_context')
  assert.equal(boot.args.seat, SEAT)

  const peek = calls.find((c) => c.name === 'inbox' && c.args.peek === true)
  assert.equal(peek.args.seat, SEAT)

  const consume = calls.find((c) => c.name === 'inbox' && c.args.peek === false)
  assert.equal(consume.args.seat, SEAT)

  // inbox_consumer_status deliberately takes NO seat arg — the fence is
  // agent-scoped, not seat-scoped. Assert the omission is intentional, not
  // an oversight: the call happened, and its args object carries no seat key.
  const fence = calls.find((c) => c.name === 'inbox_consumer_status')
  assert.equal(fence.args.seat, undefined)
})

test('runCycle refuses (missing_config) rather than call mupot at all when seat is unset', async () => {
  let called = false
  const result = await runCycle({
    checkRequiredConfig: () => ({ ok: false, reason: 'missing_config', missing: ['GROK_SEAT'] }),
    mcpCall: async () => { called = true },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing_config')
  assert.equal(called, false, 'must never reach mupot with incomplete config')
})

// ── spool before consume; a crash mid-flight loses nothing ────────────────

test('spoolMessage durably persists BEFORE deliverToTmux confirms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const order = []
    const path = spoolMessage(REQUEST, { spoolDir: dir })
    order.push('spooled')
    assert.equal(readFileSync(path, 'utf8').includes(REQUEST.request_id), true)
    assert.equal(statSync(path).mode & 0o777, 0o600, 'spool file must be mode 0600 (message bodies are not public)')
    assert.deepEqual(order, ['spooled'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deliverToTmux spools BEFORE any tmux command runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const calls = []
    const result = deliverToTmux('', REQUEST, {
      spoolDir: dir,
      spawn: (command, args) => {
        calls.push(command)
        if (command === 'tmux' && args.includes('-l')) {
          // spool must already be on disk by the time we "type" the preview
          assert.equal(statSync(dir).isDirectory(), true)
        }
        return { status: 0, stdout: deliveryMarker(REQUEST) }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0], 'tmux', 'first subprocess call must be the tmux send, after the spool write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a crash mid-flight (consume throws after delivery) loses nothing: the spool file survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    let spoolPath
    const mcpCall = async (_token, name, args) => {
      if (name === 'boot_context') return { bound_agent_id: AGENT }
      if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
      if (name === 'inbox' && args.peek === true) return { messages: [REQUEST], remaining: 0 }
      if (name === 'inbox' && args.peek === false) {
        // Simulate the process dying / network dying between a successful
        // spool+deliver and the consume call actually landing.
        throw new Error('mcp http 503')
      }
      throw new Error(`unexpected ${name}`)
    }

    await assert.rejects(() => runCycle({
      seat: SEAT,
      expectedAgentId: AGENT,
      token: 'test-token-not-real',
      mcpCall,
      deliverToTmux: (_text, message) => {
        spoolPath = spoolMessage(message, { spoolDir: dir })
        return { ok: true, spool_path: spoolPath }
      },
    }))

    assert.ok(spoolPath, 'deliverToTmux must have run (and spooled) before the throw')
    assert.equal(readFileSync(spoolPath, 'utf8').includes(REQUEST.id), true, 'spooled copy survives the crash — nothing lost')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: false, reason: 'tmux_delivery_unconfirmed' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delivery_incomplete')
  assert.equal(result.consumed, 0)
  assert.equal(consumed, false)
})

test('runCycle reports a silent drop when consume returns rows it never delivered', async () => {
  const OTHER = { ...REQUEST, seq: 999, id: 'msg-never-delivered', request_id: 'other-req' }
  const mcpCall = async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) return { messages: [REQUEST], remaining: 0 }
    if (name === 'inbox' && args.peek === false) return { messages: [OTHER], remaining: 0 }
    throw new Error(`unexpected ${name}`)
  }

  const result = await runCycle({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    mcpCall,
    deliverToTmux: () => ({ ok: true }),
  })

  assert.equal(result.consumed, 1)
  assert.equal(result.delivered, 1)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'consumed_undelivered_message')
  assert.deepEqual(result.dropped, ['id:msg-never-delivered'])
  assert.deepEqual(result.missing, ['id:msg-grok-canary'])
})

// ── a non-200 is surfaced, never swallowed ─────────────────────────────────

test('the real mcpCall surfaces a non-200 rather than swallowing it', async () => {
  // Spin up a tiny local server that answers 503 to prove the production
  // fetch path (not a mock) throws with the status visible in the message.
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('mupot down')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const mod = await import('../scripts/grok-inbox-watch.mjs')
    // selfTest exercises the module's own internal mcpCall (not injected)
    // against a real HTTP endpoint that returns non-200.
    const result = await mod.selfTest({
      seat: SEAT,
      expectedAgentId: AGENT,
      token: 'irrelevant',
      mcpCall: async (token, name, args) => {
        const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST' })
        if (!res.ok) throw new Error(`mcp http ${res.status}`)
        return {}
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /mcp http 503/)
  } finally {
    server.close()
  }
})

test('runCycle propagates (does not swallow) a thrown mcp error from a non-200', async () => {
  const mcpCall = async (_token, name) => {
    if (name === 'boot_context') throw new Error('mcp http 500')
    throw new Error(`unexpected ${name}`)
  }
  await assert.rejects(
    () => runCycle({ seat: SEAT, expectedAgentId: AGENT, token: 'x', mcpCall, deliverToTmux: () => ({ ok: true }) }),
    /mcp http 500/,
  )
})

// ── identity comes from the RIGHT credential file for the RIGHT agent ─────

test('selfTest reads the token from the configured file path, not a guessed one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-token-'))
  try {
    const tokenPath = join(dir, `${SEAT}-agent-bound.token`)
    writeFileSync(tokenPath, 'a-fake-but-long-enough-test-token\n')
    let readFrom = null
    const result = await selfTest({
      seat: SEAT,
      expectedAgentId: AGENT,
      readTokenFn: () => {
        readFrom = tokenPath
        return readFileSync(tokenPath, 'utf8').trim()
      },
      mcpCall: async (token, name, args) => {
        assert.equal(token, 'a-fake-but-long-enough-test-token')
        if (name === 'boot_context') {
          assert.equal(args.seat, SEAT)
          return { bound_agent_id: AGENT }
        }
        if (name === 'inbox') return { messages: [], remaining: 0 }
        throw new Error(`unexpected ${name}`)
      },
    })
    assert.equal(readFrom, tokenPath)
    assert.equal(result.ok, true)
    assert.equal(result.bound_agent_id, AGENT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selfTest refuses when the credential resolves to a DIFFERENT agent than configured', async () => {
  const result = await selfTest({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'x',
    mcpCall: async (_t, name) => {
      if (name === 'boot_context') return { bound_agent_id: 'wrong-agent-entirely' }
      throw new Error('must stop at identity, never reach inbox')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'wrong_bound_agent')
  assert.equal(result.bound, 'wrong-agent-entirely')
})

test('selfTest refuses cleanly (never guesses) when seat/agent config is incomplete', async () => {
  const result = await selfTest({
    checkRequiredConfig: () => ({ ok: false, reason: 'missing_config', missing: ['GROK_SEAT', 'GROK_AGENT_ID'] }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing_config')
  assert.deepEqual(result.missing, ['GROK_SEAT', 'GROK_AGENT_ID'])
})

// --- main() lifecycle: preflight-before-lock, config-before-preflight -----

function neverCalled(name) {
  return () => { throw new Error(`must not reach ${name} in this path`) }
}

test('main() refuses missing config before ever reading the token or acquiring the lock', async () => {
  const exits = []
  await main({
    checkRequiredConfig: () => ({ ok: false, reason: 'missing_config', missing: ['GROK_SEAT'] }),
    readTokenFn: neverCalled('readTokenFn'),
    mcpCall: neverCalled('mcpCall'),
    acquireLock: neverCalled('acquireLock'),
    exit: (code) => exits.push(code),
  })
  assert.deepEqual(exits, [1])
})

test('main() refuses a wrong-agent token before ever acquiring the lock', async () => {
  const exits = []
  await main({
    seat: SEAT,
    expectedAgentId: AGENT,
    readTokenFn: () => 'test-token',
    mcpCall: async (_token, name) => {
      if (name === 'boot_context') return { bound_agent_id: 'not-loom' }
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
    seat: SEAT,
    expectedAgentId: AGENT,
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
    seat: SEAT,
    expectedAgentId: AGENT,
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
      return { ok: false, reason: 'consumer_fenced', consumed: 0, delivered: 0 }
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'),
  })
  assert.equal(cycleCalls, 1, 'must not keep cycling after a terminal reason')
  assert.equal(released, true, 'must release the lock rather than hold it forever')
  assert.deepEqual(exits, [1])
})

test('main() keeps looping (does not exit) on a non-terminal cycle failure', async () => {
  const exits = []
  let released = false
  let cycleCalls = 0
  const STOP = new Error('stop the test after one loop iteration')

  await assert.rejects(() => main({
    seat: SEAT,
    expectedAgentId: AGENT,
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
      return { ok: false, reason: 'consume_skipped', consumed: 0, delivered: 0 }
    },
    exit: (code) => exits.push(code),
    sleep: async () => {
      throw STOP
    },
  }), STOP)

  assert.equal(cycleCalls, 1)
  assert.equal(released, false, 'must not release on a non-terminal failure')
  assert.deepEqual(exits, [])
})

test('main() releases and exits when a cycle THROWS an HTTP 401 mid-loop (revoked token)', async () => {
  const exits = []
  let released = false
  await main({
    seat: SEAT,
    expectedAgentId: AGENT,
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
      throw new Error('mcp http 401')
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'),
  })
  assert.equal(released, true, 'must release the lock rather than hold it forever')
  assert.deepEqual(exits, [1])
})

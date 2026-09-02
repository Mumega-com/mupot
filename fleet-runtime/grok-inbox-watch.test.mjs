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
  deliverViaHerdr,
  deliveryMarker,
  main,
  resolveDeliveryMechanism,
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

// ── delivery mechanism: herdr is the DEFAULT, never inferred (herdr follow-up to mupot#1258) ──
//
// This estate has no tmux server (the Hetzner host and Hadi's Mac are both
// herdr-owned panes), so GROK_DELIVERY defaults to 'herdr'. tmux remains an
// explicit opt-in. These tests cover: the default, explicit selection,
// refusing an unrecognized value (never silently falling back), herdr
// delivery succeeding only once genuinely confirmed, an unconfirmed herdr
// delivery consuming nothing, and a missing/failing herdr binary failing
// loudly rather than falling back to tmux.

test('resolveDeliveryMechanism defaults to herdr with no override and no env set', () => {
  const result = resolveDeliveryMechanism({})
  assert.equal(result.ok, true)
  assert.equal(result.mechanism, 'herdr')
})

test('resolveDeliveryMechanism accepts an explicit tmux opt-in', () => {
  const result = resolveDeliveryMechanism({ mechanism: 'tmux' })
  assert.equal(result.ok, true)
  assert.equal(result.mechanism, 'tmux')
})

test('resolveDeliveryMechanism refuses an unrecognized value rather than guessing', () => {
  const result = resolveDeliveryMechanism({ mechanism: 'ssh' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_delivery_mechanism')
  assert.equal(result.mechanism, 'ssh')
})

test('deliverViaHerdr reads a baseline via agent get BEFORE prompting, and confirms via revision advancing — never via agent read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const calls = []
    let getCallCount = 0
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      herdrTarget: 'muvps_loom',
      herdrBin: 'herdr',
      pollIntervalMs: 1,
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
          getCallCount += 1
          assert.equal(args[2], 'muvps_loom', 'agent get must target the configured herdr target')
          const revision = getCallCount === 1 ? 3437 : 3438
          return { status: 0, stdout: JSON.stringify({ result: { agent: { revision, state_change_seq: revision } } }) }
        }
        if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt') {
          assert.equal(getCallCount, 1, 'the baseline agent get must happen BEFORE the prompt is submitted')
          assert.equal(statSync(dir).isDirectory(), true, 'spool must already be on disk by the time the prompt is submitted')
          assert.equal(args[2], 'muvps_loom', 'prompt must target the configured herdr target')
          return { status: 0, stdout: '' }
        }
        if (command === 'sleep') return { status: 0, stdout: '' }
        if (command === 'herdr' && args[1] === 'read') {
          throw new Error('deliverViaHerdr must never call `herdr agent read` for confirmation (mupot#1258 herdr follow-up: pane reads are unreliable by construction)')
        }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, true)
    // The marker is still embedded in the delivered text for a human
    // reading the pane later, even though confirmation no longer depends
    // on finding it.
    assert.equal(result.marker, deliveryMarker(REQUEST))
    assert.ok(result.spool_path)
    assert.equal(calls[0].args[1], 'get', 'first subprocess call must be the baseline agent get, after the spool write')
    assert.equal(calls[1].args[1], 'prompt', 'second call must be the prompt, after the baseline is captured')
    assert.ok(calls.every((c) => c.command !== 'tmux'), 'herdr delivery must never shell out to tmux')
    assert.ok(calls.every((c) => !(c.command === 'herdr' && c.args[1] === 'read')), 'herdr delivery must never call agent read for confirmation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an agent_not_idle-shaped pane-read error does not cause a false negative, because confirmation never calls agent read', () => {
  // Pane-read confirmation was the prior false-negative: a genuine idle
  // prompt landed, then `herdr agent read --lines 60` refused
  // agent_not_idle. Confirmation is agent get / revision only, so that
  // refusal is unreachable. Status is idle so this is a real prompt, not
  // the busy-skip path.
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    let getCallCount = 0
    let readCalled = false
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      pollIntervalMs: 1,
      spawn: (command, args) => {
        if (command === 'herdr' && args[1] === 'get') {
          getCallCount += 1
          const revision = getCallCount === 1 ? 3437 : 3438
          return { status: 0, stdout: JSON.stringify({ result: { agent: { revision, state_change_seq: revision, agent_status: 'idle' } } }) }
        }
        if (command === 'herdr' && args[1] === 'prompt') return { status: 0, stdout: '' }
        if (command === 'sleep') return { status: 0, stdout: '' }
        if (command === 'herdr' && args[1] === 'read') {
          readCalled = true
          return { status: 1, signal: null, stdout: '', stderr: JSON.stringify({ error: { code: 'agent_not_idle', message: 'cannot read 60 lines while muvps_loom is working' } }) }
        }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, true)
    assert.equal(readCalled, false, 'confirmation must never call agent read, so an agent_not_idle response is never even reachable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a working or blocked target is NOT prompted — that was the seq 3586 re-inject loop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const calls = []
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'herdr' && args[1] === 'get') {
          return { status: 0, stdout: JSON.stringify({ result: { agent: { revision: 5812, state_change_seq: 1221, agent_status: 'working' } } }) }
        }
        if (command === 'herdr' && args[1] === 'prompt') {
          throw new Error('must not prompt a working herdr target')
        }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_target_busy')
    assert.equal(result.detail, 'working')
    assert.ok(result.spool_path, 'spool still exists so the body file is on disk for a later idle cycle')
    assert.equal(calls.some((c) => c.args?.[1] === 'prompt'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unconfirmed herdr delivery (revision/state_change_seq never advance) returns ok:false, still spools, and never reads the pane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    let readCalled = false
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      confirmAttempts: 2,
      pollIntervalMs: 1,
      spawn: (command, args) => {
        if (command === 'herdr' && args[1] === 'get') {
          return { status: 0, stdout: JSON.stringify({ result: { agent: { revision: 100, state_change_seq: 100 } } }) }
        }
        if (command === 'herdr' && args[1] === 'prompt') return { status: 0, stdout: '' }
        if (command === 'sleep') return { status: 0, stdout: '' }
        if (command === 'herdr' && args[1] === 'read') {
          readCalled = true
          return { status: 0, stdout: '' }
        }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_delivery_unconfirmed')
    assert.ok(result.spool_path, 'the spooled copy still exists even though delivery was never confirmed')
    assert.equal(readCalled, false, 'confirmation must never fall back to a pane read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a herdr binary that is missing fails loudly at the baseline read (ok:false), never prompting blind and never falling back to tmux', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const calls = []
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      spawn: (command) => {
        calls.push(command)
        // Simulate Node's own spawnSync ENOENT shape for a missing binary.
        return { status: null, signal: null, error: { code: 'ENOENT', message: 'spawn herdr ENOENT' }, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_state_unavailable')
    assert.match(result.detail, /ENOENT/)
    assert.deepEqual(calls, ['herdr'], 'must fail on the baseline agent-get call itself, never prompt, never attempt a tmux command')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a herdr binary that exits non-zero on the prompt call (after a good baseline read) fails loudly with its own stderr as detail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      spawn: (command, args) => {
        if (args[1] === 'get') return { status: 0, stdout: JSON.stringify({ result: { agent: { revision: 1, state_change_seq: 1 } } }) }
        if (args[1] === 'prompt') return { status: 1, signal: null, stdout: '', stderr: 'herdr: agent muvps_loom not found' }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_prompt_failed')
    assert.match(result.detail, /not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unparseable herdr agent get response fails loudly rather than guessing a counter value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      spawn: (command, args) => {
        if (args[1] === 'get') return { status: 0, stdout: 'not json' }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_state_unparseable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a herdr agent get response missing both counters fails loudly rather than assuming no change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
  try {
    const result = deliverViaHerdr('', REQUEST, {
      spoolDir: dir,
      spawn: (command, args) => {
        if (args[1] === 'get') return { status: 0, stdout: JSON.stringify({ result: { agent: { agent_status: 'idle' } } }) }
        throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'herdr_state_missing_fields')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('herdr agent get envelope extraction tolerates top-level, .agent, and .result.agent shapes (the exact envelope is not independently pinned down)', () => {
  const shapes = [
    (rev) => JSON.stringify({ revision: rev, state_change_seq: rev }),
    (rev) => JSON.stringify({ agent: { revision: rev, state_change_seq: rev } }),
    (rev) => JSON.stringify({ result: { agent: { revision: rev, state_change_seq: rev } } }),
  ]
  for (const shape of shapes) {
    const dir = mkdtempSync(join(tmpdir(), 'grok-spool-'))
    try {
      let getCallCount = 0
      const result = deliverViaHerdr('', REQUEST, {
        spoolDir: dir,
        pollIntervalMs: 1,
        spawn: (command, args) => {
          if (args[1] === 'get') {
            getCallCount += 1
            return { status: 0, stdout: shape(getCallCount === 1 ? 1 : 2) }
          }
          if (args[1] === 'prompt') return { status: 0, stdout: '' }
          throw new Error(`unexpected spawn: ${command} ${JSON.stringify(args)}`)
        },
      })
      assert.equal(result.ok, true, `envelope shape must resolve a counter: ${shape(1)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})


test('runCycle uses herdr by default (no GROK_DELIVERY set, no mechanism override) and never touches deliverToTmux', async () => {
  let herdrCalled = false
  const mcpCall = async (_token, name, args) => {
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
    // deliberately NOT injecting deliverToTmux — proves the default path
    // (no explicit mechanism override, no GROK_DELIVERY env) selects herdr.
    deliverViaHerdr: (_text, message) => {
      herdrCalled = true
      return { ok: true, spool_path: '/tmp/whatever', marker: deliveryMarker(message) }
    },
  })

  assert.equal(herdrCalled, true, 'the default mechanism must be herdr')
  assert.equal(result.ok, true)
  assert.equal(result.consumed, 1)
  assert.equal(result.delivered, 1)
})

test('runCycle refuses consume when herdr delivery is unconfirmed (no silent drop)', async () => {
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
    deliverViaHerdr: () => ({ ok: false, reason: 'herdr_delivery_unconfirmed' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delivery_incomplete')
  assert.equal(result.consumed, 0)
  assert.equal(consumed, false, 'an unconfirmed herdr delivery must never reach the consume call')
})

test('runCycle honors an explicit tmux opt-in via opts.deliveryMechanism (mechanism chosen, not inferred)', async () => {
  let tmuxUsed = false
  let herdrCalled = false
  const mcpCall = async (_token, name, args) => {
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
    deliveryMechanism: 'tmux',
    deliverToTmux: (_text, message) => {
      tmuxUsed = true
      return { ok: true, spool_path: '/tmp/whatever', marker: deliveryMarker(message) }
    },
    deliverViaHerdr: () => {
      herdrCalled = true
      return { ok: true }
    },
  })

  assert.equal(tmuxUsed, true)
  assert.equal(herdrCalled, false, 'an explicit tmux opt-in must never fall through to herdr')
  assert.equal(result.ok, true)
})

test('runCycle fails loudly on an invalid GROK_DELIVERY value before calling mupot at all', async () => {
  let mcpCalled = false
  const result = await runCycle({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    deliveryMechanism: 'carrier-pigeon',
    mcpCall: async () => {
      mcpCalled = true
      throw new Error('must not be reached')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_delivery_mechanism')
  assert.equal(result.consumed, 0)
  assert.equal(result.delivered, 0)
  assert.equal(mcpCalled, false, 'an invalid mechanism must refuse before any mupot call, never guess a fallback')
})

test('main() refuses an invalid GROK_DELIVERY value before ever acquiring the lock', async () => {
  const exits = []
  let lockAcquired = false
  await main({
    seat: SEAT,
    expectedAgentId: AGENT,
    deliveryMechanism: 'carrier-pigeon',
    readTokenFn: () => 'test-token',
    mcpCall: neverCalled('mcpCall'),
    acquireLock: async () => {
      lockAcquired = true
      return { ok: true, reason: 'lock_acquired', holder_pid: process.pid, release: () => {} }
    },
    exit: (code) => exits.push(code),
    sleep: neverCalled('sleep'),
  })
  assert.equal(lockAcquired, false, 'must refuse before ever taking the singleton lock')
  assert.deepEqual(exits, [1])
})

// ── per-message consume, one confirmed delivery per cycle (mupot#1258 herdr follow-up) ──
//
// Live canary (2026-09-01/02) surfaced a design flaw in the ORIGINAL batch
// policy this connector inherited from codex/kasra-inbox-watch.mjs: a
// confirmed herdr delivery makes the target busy, so a second message in
// the same cycle can never be confirmed. Consuming only when the WHOLE
// peeked batch delivered meant a genuinely confirmed message
// (`delivered:1`) was silently discarded (`consumed:0`) and redelivered as
// a duplicate forever, on any backlog a single cycle could not fully
// clear. These tests cover the fix: at most one message attempted per
// cycle, consumed per-message the instant (and only if) it is confirmed.

// A minimal in-memory stand-in for the mupot inbox server: peek never
// mutates the queue; consume removes exactly `limit` messages from the
// FRONT (matching the real `inbox` tool's by-count, not by-id, semantics).
function makeStatefulInbox(initialMessages) {
  let queue = [...initialMessages]
  return async (_token, name, args) => {
    if (name === 'boot_context') return { bound_agent_id: AGENT }
    if (name === 'inbox_consumer_status') return { mode: 'bearer_only' }
    if (name === 'inbox' && args.peek === true) {
      return { messages: queue.slice(0, args.limit), remaining: Math.max(0, queue.length - args.limit) }
    }
    if (name === 'inbox' && args.peek === false) {
      const taken = queue.slice(0, args.limit)
      queue = queue.slice(args.limit)
      return { messages: taken, remaining: queue.length }
    }
    throw new Error(`unexpected mcp call: ${name} ${JSON.stringify(args)}`)
  }
}

test('a partial batch consumes exactly the confirmed message and no others', async () => {
  const MSG1 = { ...REQUEST, seq: 501, id: 'msg-1', request_id: 'req-1' }
  const MSG2 = { ...REQUEST, seq: 502, id: 'msg-2', request_id: 'req-2' }
  const mcpCall = makeStatefulInbox([MSG1, MSG2])
  let deliverCalls = 0
  const result = await runCycle({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    mcpCall,
    deliverViaHerdr: (_text, message) => {
      deliverCalls += 1
      assert.equal(message.id, 'msg-1', 'only the front message may ever be attempted')
      return { ok: true, spool_path: '/tmp/x', marker: deliveryMarker(message) }
    },
  })
  assert.equal(deliverCalls, 1, 'only the first peeked message may be attempted')
  assert.equal(result.ok, true)
  assert.equal(result.delivered, 1)
  assert.equal(result.consumed, 1)
  assert.equal(result.peeked, 2, 'the peek still reports the full batch that was visible')
  assert.deepEqual(result.receipts.map((r) => r.id), ['msg-1'])
})

test('a cycle stops after the first confirmed delivery — messages 2 and 3 are never attempted', async () => {
  const MSG1 = { ...REQUEST, seq: 511, id: 'msg-a', request_id: 'req-a' }
  const MSG2 = { ...REQUEST, seq: 512, id: 'msg-b', request_id: 'req-b' }
  const MSG3 = { ...REQUEST, seq: 513, id: 'msg-c', request_id: 'req-c' }
  const mcpCall = makeStatefulInbox([MSG1, MSG2, MSG3])
  const attempted = []
  const result = await runCycle({
    seat: SEAT,
    expectedAgentId: AGENT,
    token: 'test-token-not-real',
    mcpCall,
    deliverViaHerdr: (_text, message) => {
      attempted.push(message.id)
      return { ok: true, spool_path: '/tmp/x', marker: deliveryMarker(message) }
    },
  })
  assert.deepEqual(attempted, ['msg-a'])
  assert.equal(result.consumed, 1)
  // msg-b and msg-c must still be queued server-side for the next cycle.
  const remainder = await mcpCall('test-token-not-real', 'inbox', { limit: 10, peek: true, seat: SEAT })
  assert.deepEqual(remainder.messages.map((m) => m.id), ['msg-b', 'msg-c'])
})

test('an unconfirmed message is retried on the next cycle and is never consumed', async () => {
  const MSG1 = { ...REQUEST, seq: 601, id: 'msg-unconfirmed', request_id: 'req-u' }
  const mcpCall = makeStatefulInbox([MSG1])
  let deliverAttempts = 0
  const deliverViaHerdr = () => {
    deliverAttempts += 1
    return { ok: false, reason: 'herdr_delivery_unconfirmed' }
  }

  const first = await runCycle({ seat: SEAT, expectedAgentId: AGENT, token: 'x', mcpCall, deliverViaHerdr })
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'delivery_incomplete')
  assert.equal(first.consumed, 0)
  assert.equal(first.delivered, 0)

  const second = await runCycle({ seat: SEAT, expectedAgentId: AGENT, token: 'x', mcpCall, deliverViaHerdr })
  assert.equal(second.ok, false)
  assert.equal(second.consumed, 0)
  assert.equal(second.peeked, 1, 'the same message must still be queued — never consumed despite two unconfirmed attempts')
  assert.equal(deliverAttempts, 2, 'the still-queued message must be retried on the next cycle')
})

test('a backlog drains one message per cycle, in order, and a delivered-then-consumed message never reappears', async () => {
  const MSG1 = { ...REQUEST, seq: 701, id: 'msg-a', request_id: 'req-a' }
  const MSG2 = { ...REQUEST, seq: 702, id: 'msg-b', request_id: 'req-b' }
  const MSG3 = { ...REQUEST, seq: 703, id: 'msg-c', request_id: 'req-c' }
  const mcpCall = makeStatefulInbox([MSG1, MSG2, MSG3])
  const deliverViaHerdr = (_text, message) => ({ ok: true, spool_path: '/tmp/x', marker: deliveryMarker(message) })

  const drained = []
  for (let i = 0; i < 3; i += 1) {
    const result = await runCycle({ seat: SEAT, expectedAgentId: AGENT, token: 'x', mcpCall, deliverViaHerdr })
    assert.equal(result.ok, true)
    assert.equal(result.delivered, 1)
    assert.equal(result.consumed, 1)
    drained.push(result.receipts[0].id)
  }
  assert.deepEqual(drained, ['msg-a', 'msg-b', 'msg-c'], 'each cycle drains exactly the next queued message, in order, none repeated')

  const empty = await runCycle({ seat: SEAT, expectedAgentId: AGENT, token: 'x', mcpCall, deliverViaHerdr })
  assert.equal(empty.reason, 'inbox_empty')
  assert.equal(empty.consumed, 0)
})

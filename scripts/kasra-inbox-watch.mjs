#!/usr/bin/env node
// Kasra mupot inbox watch — authoritative Claude Code receive path (YC27).
//
// Polls Kasra's welded bearer inbox, delivers each message into the `kasra` tmux
// pane with request_id / in_reply_to preserved, and ONLY THEN consumes the batch.
// Never pairs a consuming read with suppressOutput (the Stop-hook failure mode).
//
//   node scripts/kasra-inbox-watch.mjs              # loop
//   node scripts/kasra-inbox-watch.mjs --once       # single cycle (canary / systemd oneshot)
//
// Env:
//   MUPOT_MCP              default https://mupot.mumega.com/mcp
//   KASRA_TOKEN_FILE       default ~/.fleet/agents/kasra-agent.token
//   KASRA_AGENT_ID         default c855f82c-1eeb-409d-94d2-f11e9dd18968
//   TMUX_SESSION           default kasra
//   INTERVAL_SEC           default 30  (must be < 60 for DONE-WHEN canary)
//   KASRA_INBOX_LOCK_FILE  default ~/.fleet/locks/kasra-inbox-watch-<agent_id>.lock

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  assertCanonicalRuntimeIdentity,
  bearerConsumerAllowed,
  formatClaudeCodeNudge,
  planInboxConsume,
  verifyConsumedBatch,
} from '../fleet-runtime/claude-code-inbox-adapter.mjs'
import { acquireSingletonLock } from '../fleet-runtime/singleton-lock.mjs'

const MUPOT_MCP = process.env.MUPOT_MCP || 'https://mupot.mumega.com/mcp'
const TOKEN_FILE = process.env.KASRA_TOKEN_FILE || join(homedir(), '.fleet', 'agents', 'kasra-agent.token')
const EXPECTED_AGENT_ID = process.env.KASRA_AGENT_ID || 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
const TMUX_SESSION = process.env.TMUX_SESSION || 'kasra'
const LOCK_FILE = process.env.KASRA_INBOX_LOCK_FILE
  || join(homedir(), '.fleet', 'locks', `kasra-inbox-watch-${EXPECTED_AGENT_ID}.lock`)
const INTERVAL_SEC = Math.min(60, Math.max(5, Number(process.env.INTERVAL_SEC || 30) || 30))
const ONCE = process.argv.includes('--once')

// Reasons that mean "this process's authorization precondition failed" —
// wrong/expired token, wrong agent binding, or fenced out of the current
// consumer generation. None of these self-heal by retrying in the SAME
// process; they need a config fix or an external fence flip, which a FRESH
// launch (systemd/cron) will pick up on its own next preflight. Anything NOT
// in this set (network blips, transient MCP errors) keeps looping as before.
const TERMINAL_REASONS = new Set([
  'expected_agent_required',
  'token_not_agent_bound',
  'wrong_bound_agent',
  'fence_mode_missing',
  'invalid_fence_mode',
  'consumer_fenced',
])

function log(event, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), component: 'kasra-inbox-watch', event, ...extra }))
}

function readToken() {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (token.length < 16) throw new Error('kasra agent token missing/short')
  return token
}

async function mcpCall(token, name, args) {
  const res = await fetch(MUPOT_MCP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'kasra-inbox-watch/1.0 (+mupot)',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`mcp http ${res.status}`)
  const payload = await res.json()
  if (payload.error) throw new Error(`mcp error ${JSON.stringify(payload.error)}`)
  const inner = JSON.parse(payload.result.content[0].text)
  if (inner.ok === false) {
    const reason = inner.error || inner.reason || 'tool_failed'
    throw new Error(`mcp tool ${name} failed: ${reason}`)
  }
  return inner.result ?? inner
}

function deliverToTmux(text) {
  const type = spawnSync('tmux', ['send-keys', '-t', TMUX_SESSION, '-l', text], { encoding: 'utf8' })
  if (type.status !== 0) {
    return { ok: false, reason: 'tmux_send_failed', detail: type.stderr || type.error?.message }
  }
  // Enter as a separate key so multiline bodies stay literal under -l.
  const enter = spawnSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], { encoding: 'utf8' })
  if (enter.status !== 0) {
    return { ok: false, reason: 'tmux_enter_failed', detail: enter.stderr || enter.error?.message }
  }
  return { ok: true }
}

export async function runCycle(opts = {}) {
  const token = opts.token ?? readToken()
  const mcp = opts.mcpCall ?? mcpCall
  const deliver = opts.deliverToTmux ?? deliverToTmux

  const boot = await mcp(token, 'boot_context', {})
  const identity = assertCanonicalRuntimeIdentity(boot, EXPECTED_AGENT_ID)
  if (!identity.ok) {
    log('identity_refuse', { reason: identity.reason, expected: EXPECTED_AGENT_ID })
    return { ok: false, reason: identity.reason, consumed: 0, delivered: 0 }
  }

  const fence = await mcp(token, 'inbox_consumer_status', {})
  const allowed = bearerConsumerAllowed(fence)
  if (!allowed.ok) {
    log('fence_refuse', { reason: allowed.reason, mode: fence?.mode ?? null, generation: fence?.generation ?? null })
    return { ok: false, reason: allowed.reason, consumed: 0, delivered: 0 }
  }

  const peeked = await mcp(token, 'inbox', { limit: 10, peek: true })
  const messages = Array.isArray(peeked.messages) ? peeked.messages : []
  if (messages.length === 0) {
    return { ok: true, reason: 'inbox_empty', consumed: 0, delivered: 0, remaining: Number(peeked.remaining ?? 0) }
  }

  let deliveredCount = 0
  const receipts = []
  for (const message of messages) {
    const nudge = formatClaudeCodeNudge(message)
    const handoff = deliver(nudge)
    if (!handoff.ok) {
      log('deliver_fail', {
        reason: handoff.reason,
        seq: message.seq,
        id: message.id,
        request_id: message.request_id ?? null,
      })
      break
    }
    deliveredCount += 1
    receipts.push({
      seq: message.seq,
      id: message.id,
      request_id: message.request_id ?? null,
      in_reply_to: message.in_reply_to ?? null,
      kind: message.kind,
    })
  }

  const plan = planInboxConsume({ peekedCount: messages.length, deliveredCount })
  if (plan.consume === 0) {
    log('consume_skipped', { reason: plan.reason, peeked: messages.length, delivered: deliveredCount })
    return {
      ok: false,
      reason: plan.reason,
      consumed: 0,
      delivered: deliveredCount,
      peeked: messages.length,
      receipts,
    }
  }

  const consumed = await mcp(token, 'inbox', { limit: plan.consume, peek: false })
  const consumedMessages = Array.isArray(consumed.messages) ? consumed.messages : []

  // Compare identities, not counts: `inbox` consumes by limit, so a concurrent
  // consumer can shift the window and leave the count matching while the rows
  // differ. Those swapped-in rows leave the queue undelivered.
  const verified = verifyConsumedBatch({ expected: messages, consumed: consumedMessages })
  if (!verified.ok) {
    log('consume_unverified', {
      agent_id: identity.agent_id,
      reason: verified.reason,
      dropped: verified.dropped,
      missing: verified.missing,
      peeked: messages.length,
      consumed: consumedMessages.length,
      receipts,
    })
  } else {
    log('inbox_consumed', {
      agent_id: identity.agent_id,
      count: consumedMessages.length,
      receipts,
    })
  }
  return {
    ok: verified.ok,
    reason: verified.ok ? 'delivered_and_consumed' : verified.reason,
    consumed: consumedMessages.length,
    delivered: deliveredCount,
    peeked: messages.length,
    dropped: verified.dropped,
    missing: verified.missing,
    remaining: Number(consumed.remaining ?? peeked.remaining ?? 0),
    receipts,
    agent_id: identity.agent_id,
  }
}

/**
 * Injectable deps default to the real implementations; tests override
 * `mcpCall`/`acquireLock`/`exit`/`runCycle`/`readTokenFn` to exercise the
 * lifecycle (preflight-before-lock, mid-loop terminal handling) without a
 * real MCP endpoint, a real lock file, or actually terminating the process.
 * Every `exit(...)` call is followed by an explicit `return` — production
 * `process.exit` never returns control anyway, but a fake exit in tests
 * does, and without the `return` execution would fall through into code
 * that assumes the process is already gone (e.g. acquiring a lock after a
 * preflight refusal).
 */
export async function main(opts = {}) {
  const mcp = opts.mcpCall ?? mcpCall
  const readTokenFn = opts.readTokenFn ?? readToken
  const acquireLock = opts.acquireLock ?? acquireSingletonLock
  const exit = opts.exit ?? ((code) => process.exit(code))
  const cycle = opts.runCycle ?? runCycle
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  // Validate identity/token AND the consumer fence BEFORE taking the
  // singleton lock (adversarial review on #540, two rounds). A watcher
  // launched with a wrong/expired token, a mismatched EXPECTED_AGENT_ID, or
  // currently fenced out of the authorized consumer generation can never
  // succeed no matter how many times the loop below retries — none of these
  // self-heal by retrying in the SAME process. The OLD ordering acquired the
  // lock first and only preflighted identity, so a fenced-out (but
  // identity-valid) watcher would still hold the singleton forever — its
  // cycle_error catch just logs `fence_refuse` and loops — blocking a
  // currently-authorized watcher from ever starting. Failing here, before any
  // lock exists, means neither failure mode can block a good launch.
  // Transient failures (mupot momentarily unreachable) fail fast too — this
  // script runs under systemd/cron supervision (see header), which is the
  // correct place for restart/backoff policy, not an infinite in-process
  // retry before real work has even started.
  let preflightToken
  let preflightBoot
  let preflightFence
  try {
    preflightToken = readTokenFn()
    preflightBoot = await mcp(preflightToken, 'boot_context', {})
  } catch (error) {
    log('preflight_error', { error: String(error?.message ?? error) })
    exit(1)
    return
  }
  const preflightIdentity = assertCanonicalRuntimeIdentity(preflightBoot, EXPECTED_AGENT_ID)
  if (!preflightIdentity.ok) {
    log('identity_refuse_preflight', { reason: preflightIdentity.reason, expected: EXPECTED_AGENT_ID })
    exit(1)
    return
  }
  try {
    preflightFence = await mcp(preflightToken, 'inbox_consumer_status', {})
  } catch (error) {
    log('preflight_error', { error: String(error?.message ?? error) })
    exit(1)
    return
  }
  const preflightAllowed = bearerConsumerAllowed(preflightFence)
  if (!preflightAllowed.ok) {
    log('fence_refuse_preflight', {
      reason: preflightAllowed.reason,
      mode: preflightFence?.mode ?? null,
      generation: preflightFence?.generation ?? null,
    })
    exit(1)
    return
  }

  // Single instance per agent. A second watcher on the same token interleaves
  // peek/consume and can drain rows this one already delivered.
  const lock = await acquireLock({ path: LOCK_FILE })
  if (!lock.ok) {
    log('start_refused', { reason: lock.reason, holder_pid: lock.holder_pid, lock_file: LOCK_FILE })
    exit(lock.reason === 'already_running' ? 0 : 1)
    return
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    lock.release()
  }
  process.on('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      release()
      exit(0)
    })
  }

  log('start', {
    mcp: MUPOT_MCP,
    agent_id: EXPECTED_AGENT_ID,
    tmux_session: TMUX_SESSION,
    interval_sec: INTERVAL_SEC,
    once: ONCE,
    lock_file: LOCK_FILE,
  })
  for (;;) {
    try {
      const result = await cycle()
      log('cycle', result)
      if (ONCE) {
        release()
        exit(result.ok || result.reason === 'inbox_empty' ? 0 : 1)
        return
      }
      // Preflight only proves identity/fence at LAUNCH — a token can be
      // rotated/revoked or the fence can flip mid-run. If a cycle reports the
      // same class of failure, this run is done: release now and let the
      // supervisor's next scheduled launch preflight fresh, rather than
      // holding the singleton indefinitely on a precondition retrying cannot
      // fix (the exact shape adversarial review found: fence_refuse logged
      // every cycle forever, lock never released).
      if (!result.ok && TERMINAL_REASONS.has(result.reason)) {
        log('terminal_refuse', { reason: result.reason })
        release()
        exit(1)
        return
      }
    } catch (error) {
      log('cycle_error', { error: String(error?.message ?? error) })
      if (ONCE) {
        release()
        exit(1)
        return
      }
    }
    await sleep(INTERVAL_SEC * 1000)
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  await main()
}

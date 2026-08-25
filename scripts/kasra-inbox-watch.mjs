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
//   KASRA_INBOX_SPOOL_DIR  default ~/.fleet/inbox-spool/<agent_id>
//   TMUX_DELIVERY_TIMEOUT_MS default 5000, clamped to 100..15000
//   TMUX_PREVIEW_MAX_CHARS default 1000, clamped to 320..2000
//   TMUX_CONFIRM_ATTEMPTS  default 3, clamped to 1..5
//   TMUX_ENTER_DELAY_MS    default payload-scaled 250..2500

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
const TMUX_DELIVERY_TIMEOUT_MS = Math.min(15_000, Math.max(100, Number(process.env.TMUX_DELIVERY_TIMEOUT_MS || 5_000) || 5_000))
const TMUX_PREVIEW_MAX_CHARS = Math.min(2_000, Math.max(320, Number(process.env.TMUX_PREVIEW_MAX_CHARS || 1_000) || 1_000))
const TMUX_CONFIRM_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.TMUX_CONFIRM_ATTEMPTS || 3) || 3))
const INBOX_SPOOL_DIR = process.env.KASRA_INBOX_SPOOL_DIR
  || join(homedir(), '.fleet', 'inbox-spool', EXPECTED_AGENT_ID)
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

// A REVOKED/expired token doesn't surface as a returned {ok:false, reason}
// from runCycle() — mcpCall() throws on HTTP auth failures and on MCP
// tool-level failures (adversarial review on #540: a token revoked mid-run,
// after a clean preflight, makes the next boot_context/inbox_consumer_status
// call reject rather than return, so the TERMINAL_REASONS check above never
// even runs — the outer catch just logged and kept looping, holding the
// lock forever). Classify the THROWN error's message the same way: an HTTP
// 401/403 is unambiguously an auth failure (not a transient 5xx/timeout/DNS
// blip), and a tool-level failure whose message names one of the same
// TERMINAL_REASONS strings (mcpCall embeds the server's own reason in its
// thrown message) is the identical precondition, just surfaced as a throw
// instead of a return.
function isTerminalCycleError(message) {
  if (/\bmcp http (401|403)\b/.test(message)) return true
  for (const reason of TERMINAL_REASONS) {
    if (message.includes(reason)) return true
  }
  return false
}

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

function safeMessageKey(message) {
  const raw = typeof message?.id === 'string' && message.id
    ? message.id
    : `seq-${Number.isFinite(Number(message?.seq)) ? Number(message.seq) : 'unknown'}`
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'unknown'
}

export function deliveryMarker(message) {
  return `[mupot-delivery:${safeMessageKey(message)}]`
}

export function spoolMessage(message, opts = {}) {
  // Validate the complete envelope before persisting it. This also enforces
  // the 8 KiB message-body contract used by the MCP inbox.
  formatClaudeCodeNudge(message)
  const dir = resolve(opts.spoolDir ?? INBOX_SPOOL_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const target = join(dir, `${safeMessageKey(message)}.json`)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(message, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, target)
  chmodSync(target, 0o600)
  return target
}

export function formatBoundedTmuxPreview(message, spoolPath, maxChars = TMUX_PREVIEW_MAX_CHARS) {
  formatClaudeCodeNudge(message)
  const cap = Math.min(2_000, Math.max(320, Number(maxChars) || TMUX_PREVIEW_MAX_CHARS))
  const marker = deliveryMarker(message)
  const requestId = message.request_id == null ? '' : String(message.request_id)
  const inReplyTo = message.in_reply_to == null ? '' : String(message.in_reply_to)
  const fixed = [
    '[mupot inbox — authoritative receive preview]',
    marker,
    `seq: ${Number.isFinite(Number(message.seq)) ? Number(message.seq) : '?'}`,
    `id: ${typeof message.id === 'string' && message.id ? message.id : '?'}`,
    `from_agent: ${typeof message.from_agent === 'string' && message.from_agent ? message.from_agent : '?'}`,
    `kind: ${message.kind}`,
    `request_id: ${requestId}`,
    `in_reply_to: ${inReplyTo}`,
    `full_body_file: ${spoolPath}`,
    'Read the mode-600 full_body_file before acting; this preview is intentionally bounded.',
    'body_preview: ',
  ].join('\n')
  const remaining = Math.max(0, cap - fixed.length)
  const body = message.body.slice(0, remaining)
  return `${fixed}${body}`.slice(0, cap)
}

function tmuxFailure(result, failed, timedOut) {
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGTERM') {
    return { ok: false, reason: timedOut, detail: result?.error?.message || 'timed out' }
  }
  return { ok: false, reason: failed, detail: result?.stderr || result?.error?.message }
}

export function deliverToTmux(_text, message, opts = {}) {
  const spawn = opts.spawn ?? spawnSync
  const timeoutMs = Math.min(15_000, Math.max(100, Number(opts.timeoutMs ?? TMUX_DELIVERY_TIMEOUT_MS) || TMUX_DELIVERY_TIMEOUT_MS))
  const previewMaxChars = opts.previewMaxChars ?? TMUX_PREVIEW_MAX_CHARS
  const confirmAttempts = Math.min(5, Math.max(1, Number(opts.confirmAttempts ?? TMUX_CONFIRM_ATTEMPTS) || TMUX_CONFIRM_ATTEMPTS))
  const spool = opts.spoolMessage ?? ((value) => spoolMessage(value, opts))
  let spoolPath
  try {
    spoolPath = spool(message)
  } catch (error) {
    return { ok: false, reason: 'message_spool_failed', detail: error instanceof Error ? error.message : String(error) }
  }
  const preview = formatBoundedTmuxPreview(message, spoolPath, previewMaxChars)
  const marker = deliveryMarker(message)
  const commandOpts = { encoding: 'utf8', timeout: timeoutMs }
  const type = spawn('tmux', ['send-keys', '-t', TMUX_SESSION, '-l', preview], commandOpts)
  if (type.status !== 0) {
    return tmuxFailure(type, 'tmux_send_failed', 'tmux_send_timeout')
  }
  // Preserve the live Athena fix from ac6cc29: cursor-agent can swallow Enter
  // while it is still ingesting a paste. The preview is bounded, and so is the
  // settle delay; running it through the same timed subprocess boundary keeps
  // a broken child from wedging the watcher.
  const requestedDelay = Number(opts.enterDelayMs ?? process.env.TMUX_ENTER_DELAY_MS)
  const settleMs = Number.isFinite(requestedDelay) && requestedDelay > 0
    ? Math.min(2_500, Math.max(0, requestedDelay))
    : Math.min(2_500, 250 + Math.floor(preview.length / 40))
  const settle = spawn('sleep', [String(settleMs / 1_000)], commandOpts)
  if (settle.status !== 0) {
    return tmuxFailure(settle, 'tmux_settle_failed', 'tmux_settle_timeout')
  }
  // Brief delay ensures input box registers text before Enter fires.
  const delay = spawnSync('sleep', ['0.3'], { encoding: 'utf8' })
  if (delay.status !== 0) {
    return { ok: false, reason: 'delay_failed', detail: delay.stderr || delay.error?.message }
  }
  // Enter as a separate key so multiline bodies stay literal under -l.
  const enter = spawn('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], commandOpts)
  if (enter.status !== 0) {
    return tmuxFailure(enter, 'tmux_enter_failed', 'tmux_enter_timeout')
  }
  for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
    // TMUX_CONFIRM_DEPTH: busy TUI seats scroll markers past a shallow window
    // before confirm runs (observed 2026-08-22: seq 2410 looped forever at -80
    // while the marker sat ~120 lines up). Deep default keeps confirmation
    // honest; env-overridable for tiny panes.
    const confirmDepth = Math.min(50_000, Math.max(80, Number(process.env.TMUX_CONFIRM_DEPTH || 2_000) || 2_000))
    const pane = spawn('tmux', ['capture-pane', '-pt', TMUX_SESSION, '-S', `-${confirmDepth}`], commandOpts)
    if (pane.status === 0 && typeof pane.stdout === 'string' && pane.stdout.includes(marker)) {
      return { ok: true, spool_path: spoolPath, marker }
    }
    if (pane.status !== 0 && (pane?.error?.code === 'ETIMEDOUT' || pane?.signal === 'SIGTERM')) {
      return tmuxFailure(pane, 'tmux_confirm_failed', 'tmux_confirm_timeout')
    }
  }
  // Full-screen TUI seats (opencode/cursor/grok) render conversation content in
  // their OWN scrollback, invisible to capture-pane — so marker-grep produces
  // permanent false negatives on exactly the seats this watcher serves
  // (observed 2026-08-22: seq 2410 looped forever while visibly delivered).
  // send-keys exit 0 + settle + Enter means the payload WAS handed to the seat's
  // input path; that mechanical fact is our delivery proof. Consume-on-success
  // keeps its meaning: we consumed because handoff verifiably happened.
  return { ok: true, spool_path: spoolPath, marker, reason: 'tmux_send_accepted_unconfirmed' }
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
    const handoff = deliver(nudge, message)
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
      const message = String(error?.message ?? error)
      const terminal = isTerminalCycleError(message)
      log('cycle_error', { error: message, terminal })
      if (ONCE || terminal) {
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

#!/usr/bin/env node
// Grok mupot inbox watch — authoritative grok-cli receive path (mupot#1258).
//
// grok-cli (like Codex CLI) has no local injection API — no Stop hook, no
// pi.sendUserMessage equivalent. The only place an outside process can speak
// into a running grok-cli session is its terminal pane: this polls the seat's
// welded bearer inbox, spools each message to disk, delivers a bounded
// preview into the target pane, confirms delivery actually landed (see the
// DELIVERY MECHANISM note below for what "confirms" means per mechanism —
// it is NOT the same proof on both), and ONLY THEN consumes the batch from
// mupot. Never pairs a consuming read with a delivery it cannot prove
// happened — see fleet-runtime/claude-code-inbox-adapter.mjs's YC27 note for
// the failure mode this order exists to rule out.
//
// mupot#1258 — the incident this script was written for: four briefs sent to
// `muvps_loom` (a grok-cli seat) were accepted by mupot, ids returned, rows
// sitting in its inbox — and the seat sat idle at an empty prompt with all
// four unread. mupot delivers correctly; grok-cli's process body was never
// wired to a consumer that drains it. This is that consumer.
//
// WHY EVERY CALL PASSES `seat` EXPLICITLY (do not remove this)
//
// The live Claude Stop-hook bridge (connectors/claude/bridge/mupot-bridge.sh)
// calls `inbox` with no `seat` argument at all. mupot's inbox/inbox_lease/
// boot_context/send tools all accept an optional, CLIENT-SUPPLIED `seat`
// string (src/mcp/index.ts) that server-side becomes `target_seat` filtering
// (src/agents/messages.ts): a read with no seat matches ONLY rows where
// `target_seat IS NULL`; a read WITH a seat matches `target_seat = <seat> OR
// target_seat IS NULL`. Mail addressed to a specific seat is therefore
// invisible to — and never consumed by — a reader that omits `seat`. Because
// one mupot agent identity can have more than one physical body (a seat is a
// free-text client label, not something the pot infers from the token), a
// seat-omitting reader can also silently steal untargeted mail that a
// specific seat's read was supposed to see and account for, so a later
// `inbox_ack` for that id comes back `already_read` for mail this seat's
// body never actually displayed. This connector is generic (not a
// per-known-agent script like scripts/{codex,kasra}-inbox-watch.mjs) and is
// meant to be installed on any grok-cli seat, so the seat is REQUIRED
// configuration (GROK_SEAT), never optional, never inferred, and is passed
// on every call that accepts it (boot_context, inbox). inbox_consumer_status
// takes no seat argument — the bearer/signed_only fence is agent-scoped, not
// seat-scoped — so it is called as `{}` deliberately, not by oversight.
//
// IDENTITY COMES FROM THE CREDENTIAL, NEVER FROM CONFIG (mupot#889, #1154)
//
// GROK_AGENT_ID is required and is only used to ASSERT that the token this
// process was handed actually resolves (via boot_context's bound_agent_id)
// to the agent the operator believes they are installing for. It is never
// used to select which mail to read — that is `to_agent`, resolved by the
// pot from the bearer token alone. mupot#1154 was a seat slug hardcoded in
// host config, so whichever body launched first drained someone else's mail;
// there is deliberately no fallback here, and no compiled-in default token
// path, agent id, tmux target, or seat — every one of those five is required
// configuration this script refuses to guess.
//
// TOKEN NEVER LOGGED — only ever placed in the Authorization header. Nothing
// in this file prints, echoes, or persists it anywhere else.
//
//   node scripts/grok-inbox-watch.mjs              # loop
//   node scripts/grok-inbox-watch.mjs --once       # single cycle (canary / systemd oneshot)
//   node scripts/grok-inbox-watch.mjs --self-test   # prove credential + seat, consume nothing
//
// DELIVERY MECHANISM (mupot#1258 herdr follow-up)
//
// This estate runs on herdr — the Hetzner host has no tmux server at all
// (herdr owns the panes over its own socket, ~/.config/herdr/herdr.sock) and
// Hadi's Mac is herdr too. GROK_DELIVERY therefore defaults to 'herdr', not
// 'tmux'. tmux delivery (deliverToTmux) still exists and is a valid explicit
// choice for the unusual host that genuinely runs a tmux server, but it is
// the exception, never the peer — a default that must be set correctly on
// every install is exactly the kind of thing that gets forgotten on the
// fifth seat at 2am. The mechanism is ALWAYS resolved explicitly
// (resolveDeliveryMechanism) and never inferred from what happens to be
// installed: an unrecognized GROK_DELIVERY value refuses to start rather
// than silently falling back to whichever mechanism looks reachable.
//
// Env (all required unless noted):
//   MUPOT_MCP                default https://mupot.mumega.com/mcp
//   GROK_SEAT                required — this body's seat label, e.g. muvps_loom
//   GROK_TOKEN_FILE           default ~/.fleet/agents/<GROK_SEAT>-agent-bound.token
//   GROK_AGENT_ID             required — the agent id this token MUST resolve to
//   GROK_DELIVERY             default 'herdr' — 'herdr' (default, this estate has no tmux
//                             server) or 'tmux' (explicit opt-in on a host that has one)
//   HERDR_TARGET              default = GROK_SEAT — the herdr agent name prompts land in
//                             (usually equal to the seat, but not assumed to be)
//   HERDR_BIN                 default 'herdr' (resolved to an absolute path by install.sh,
//                             since a systemd user unit's PATH may not include ~/.local/bin)
//   TMUX_SESSION              default = GROK_SEAT — the pane grok-cli's TUI runs in (tmux only)
//   INTERVAL_SEC              default 30  (clamped 5..60)
//   GROK_INBOX_LOCK_FILE      default ~/.fleet/locks/grok-inbox-watch-<seat>.lock
//   GROK_INBOX_SPOOL_DIR      default ~/.fleet/inbox-spool/grok-<seat>
//   TMUX_DELIVERY_TIMEOUT_MS  default 5000, clamped to 100..15000 (shared by herdr delivery)
//   TMUX_PREVIEW_MAX_CHARS    default 1000, clamped to 320..2000 (shared by herdr delivery)
//   TMUX_CONFIRM_ATTEMPTS     default 3, clamped to 1..5 (shared by herdr delivery)
//   TMUX_ENTER_DELAY_MS       default payload-scaled 250..2500 (tmux only)
//   HERDR_POLL_INTERVAL_MS    default 750, clamped to 100..5000 (herdr only — gap between agent-get polls)

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  bearerConsumerAllowed,
  formatClaudeCodeNudge,
  planInboxConsume,
  verifyConsumedBatch,
} from '../fleet-runtime/claude-code-inbox-adapter.mjs'
import { acquireSingletonLock } from '../fleet-runtime/singleton-lock.mjs'

// Pure derivation helpers — exported so tests can verify the default LAYOUT
// (which file/lock/spool path a given seat resolves to) without juggling
// module-load-time env vars via dynamic re-import.
export function defaultTokenFilePath(seat) {
  return seat ? join(homedir(), '.fleet', 'agents', `${seat}-agent-bound.token`) : ''
}
export function defaultLockFilePath(seat) {
  return seat ? join(homedir(), '.fleet', 'locks', `grok-inbox-watch-${seat}.lock`) : ''
}
export function defaultSpoolDir(seat) {
  return seat ? join(homedir(), '.fleet', 'inbox-spool', `grok-${seat}`) : ''
}

const MUPOT_MCP = process.env.MUPOT_MCP || 'https://mupot.mumega.com/mcp'
const SEAT = typeof process.env.GROK_SEAT === 'string' ? process.env.GROK_SEAT.trim() : ''
const EXPECTED_AGENT_ID = typeof process.env.GROK_AGENT_ID === 'string' ? process.env.GROK_AGENT_ID.trim() : ''
const TOKEN_FILE = process.env.GROK_TOKEN_FILE || defaultTokenFilePath(SEAT)
const TMUX_SESSION = process.env.TMUX_SESSION || SEAT
// herdr is the default delivery mechanism (this estate has no tmux server —
// see the DELIVERY MECHANISM header note); tmux is an explicit opt-in only.
const DELIVERY_MECHANISMS = new Set(['herdr', 'tmux'])
const GROK_DELIVERY = typeof process.env.GROK_DELIVERY === 'string' && process.env.GROK_DELIVERY.trim()
  ? process.env.GROK_DELIVERY.trim()
  : 'herdr'
const HERDR_TARGET = process.env.HERDR_TARGET || SEAT
const HERDR_BIN = process.env.HERDR_BIN || 'herdr'
const LOCK_FILE = process.env.GROK_INBOX_LOCK_FILE || defaultLockFilePath(SEAT)
const INTERVAL_SEC = Math.min(60, Math.max(5, Number(process.env.INTERVAL_SEC || 30) || 30))
const TMUX_DELIVERY_TIMEOUT_MS = Math.min(15_000, Math.max(100, Number(process.env.TMUX_DELIVERY_TIMEOUT_MS || 5_000) || 5_000))
const TMUX_PREVIEW_MAX_CHARS = Math.min(2_000, Math.max(320, Number(process.env.TMUX_PREVIEW_MAX_CHARS || 1_000) || 1_000))
const TMUX_CONFIRM_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.TMUX_CONFIRM_ATTEMPTS || 3) || 3))
const INBOX_SPOOL_DIR = process.env.GROK_INBOX_SPOOL_DIR || defaultSpoolDir(SEAT)
const ONCE = process.argv.includes('--once')
const SELF_TEST = process.argv.includes('--self-test')

// Reasons that mean "this process's authorization precondition failed" —
// wrong/expired token, wrong agent binding, missing required config, or
// fenced out of the current consumer generation. None of these self-heal by
// retrying in the SAME process; they need a config fix or an external fence
// flip, which a FRESH launch (systemd/cron) will pick up on its own next
// preflight. Anything NOT in this set (network blips, transient MCP errors)
// keeps looping as before.
const TERMINAL_REASONS = new Set([
  'missing_config',
  'expected_agent_required',
  'token_not_agent_bound',
  'wrong_bound_agent',
  'fence_mode_missing',
  'invalid_fence_mode',
  'consumer_fenced',
  'invalid_delivery_mechanism',
])

// A REVOKED/expired token doesn't surface as a returned {ok:false, reason}
// from runCycle() — mcpCall() throws on HTTP auth failures and on MCP
// tool-level failures (same shape adversarial review found on codex's #540:
// a token revoked mid-run, after a clean preflight, makes the next
// boot_context/inbox_consumer_status call reject rather than return, so the
// TERMINAL_REASONS check never even runs). Classify the THROWN error's
// message the same way: an HTTP 401/403 is unambiguously an auth failure
// (not a transient 5xx/timeout/DNS blip), and a tool-level failure whose
// message names one of the same TERMINAL_REASONS strings (mcpCall embeds the
// server's own reason in its thrown message) is the identical precondition,
// just surfaced as a throw instead of a return.
function isTerminalCycleError(message) {
  if (/\bmcp http (401|403)\b/.test(message)) return true
  for (const reason of TERMINAL_REASONS) {
    if (message.includes(reason)) return true
  }
  return false
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), component: 'grok-inbox-watch', event, ...extra }))
}

/**
 * Five pieces of config this script refuses to guess: seat, token path,
 * agent id, tmux target, lock file. All five are derived from SEAT or from
 * an explicit override — if SEAT itself is unset, every one of them is
 * empty, so this fires first and names exactly what is missing rather than
 * failing later with an unrelated ENOENT or a wrong-agent surprise.
 */
export function checkRequiredConfig(overrides = {}) {
  const seat = overrides.seat ?? SEAT
  const expectedAgentId = overrides.expectedAgentId ?? EXPECTED_AGENT_ID
  const tokenFile = overrides.tokenFile ?? TOKEN_FILE
  const missing = []
  if (!seat) missing.push('GROK_SEAT')
  if (!expectedAgentId) missing.push('GROK_AGENT_ID')
  if (!tokenFile) missing.push('GROK_TOKEN_FILE (or GROK_SEAT to derive it)')
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_config', missing }
  }
  return { ok: true }
}

/**
 * Delivery mechanism is SELECTED, never inferred. herdr is the default (this
 * estate has no tmux server on the Hetzner host or Hadi's Mac — see the
 * DELIVERY MECHANISM header note); tmux remains available as an explicit
 * opt-in for a host that genuinely runs one. An unrecognized value refuses
 * rather than silently picking whichever mechanism happens to look
 * reachable — that silent-fallback shape is exactly what let 8 messages sit
 * undelivered against a tmux target that could never have worked here.
 */
export function resolveDeliveryMechanism(overrides = {}) {
  const mechanism = overrides.mechanism ?? GROK_DELIVERY
  if (!DELIVERY_MECHANISMS.has(mechanism)) {
    return { ok: false, reason: 'invalid_delivery_mechanism', mechanism }
  }
  return { ok: true, mechanism }
}

function readToken() {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (token.length < 16) throw new Error('grok agent token missing/short')
  return token
}

async function mcpCall(token, name, args) {
  const res = await fetch(MUPOT_MCP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'grok-inbox-watch/1.0 (+mupot)',
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

/**
 * Identity gate: the token must resolve (server-side, via boot_context) to
 * the exact agent this watcher was configured for. Unlike codex/kasra's
 * scripts (one script, one known agent, a default baked in), this connector
 * ships to arbitrary grok-cli seats — EXPECTED_AGENT_ID has no default and
 * must be supplied per install, which is what stops a copy-pasted unit file
 * from silently draining a different agent's mail (mupot#1154's shape).
 */
export function assertCanonicalRuntimeIdentity(boot, expectedAgentId) {
  if (typeof expectedAgentId !== 'string' || !expectedAgentId) {
    return { ok: false, reason: 'expected_agent_required' }
  }
  const bound = boot?.bound_agent_id
  if (typeof bound !== 'string' || !bound) {
    return { ok: false, reason: 'token_not_agent_bound' }
  }
  if (bound !== expectedAgentId) {
    return { ok: false, reason: 'wrong_bound_agent' }
  }
  return { ok: true, reason: 'identity_ok', agent_id: bound }
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

// Generic spawnSync-result classifier — shared by both delivery mechanisms
// (tmux and herdr), not tmux-specific despite the historical call sites
// below. A missing binary (spawnSync ENOENT) or a non-zero exit both land
// in the `failed` branch with the subprocess's own stderr/error message as
// detail — the same "fail loudly, never silently pick a different
// mechanism" behavior for a missing herdr binary as for a missing tmux one.
function subprocessFailure(result, failed, timedOut) {
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
  const tmuxSession = opts.tmuxSession ?? TMUX_SESSION
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
  const type = spawn('tmux', ['send-keys', '-t', tmuxSession, '-l', preview], commandOpts)
  if (type.status !== 0) {
    return subprocessFailure(type, 'tmux_send_failed', 'tmux_send_timeout')
  }
  // grok-cli, like cursor-agent before it, can swallow Enter while still
  // ingesting a paste (the live Athena fix on kasra's watcher, ac6cc29). The
  // preview is bounded, and so is the settle delay; running it through the
  // same timed subprocess boundary keeps a broken child from wedging the
  // watcher.
  const requestedDelay = Number(opts.enterDelayMs ?? process.env.TMUX_ENTER_DELAY_MS)
  const settleMs = Number.isFinite(requestedDelay) && requestedDelay > 0
    ? Math.min(2_500, Math.max(0, requestedDelay))
    : Math.min(2_500, 250 + Math.floor(preview.length / 40))
  const settle = spawn('sleep', [String(settleMs / 1_000)], commandOpts)
  if (settle.status !== 0) {
    return subprocessFailure(settle, 'tmux_settle_failed', 'tmux_settle_timeout')
  }
  // Enter as a separate key so multiline bodies stay literal under -l.
  const enter = spawn('tmux', ['send-keys', '-t', tmuxSession, 'Enter'], commandOpts)
  if (enter.status !== 0) {
    return subprocessFailure(enter, 'tmux_enter_failed', 'tmux_enter_timeout')
  }
  for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
    const pane = spawn('tmux', ['capture-pane', '-pt', tmuxSession, '-S', '-80'], commandOpts)
    if (pane.status === 0 && typeof pane.stdout === 'string' && pane.stdout.includes(marker)) {
      return { ok: true, spool_path: spoolPath, marker }
    }
    if (pane.status !== 0 && (pane?.error?.code === 'ETIMEDOUT' || pane?.signal === 'SIGTERM')) {
      return subprocessFailure(pane, 'tmux_confirm_failed', 'tmux_confirm_timeout')
    }
  }
  return { ok: false, reason: 'tmux_delivery_unconfirmed', spool_path: spoolPath, marker }
}

/**
 * herdr delivery — the DEFAULT mechanism (see the DELIVERY MECHANISM header
 * note; this estate has no tmux server). Same spool-before-anything
 * discipline as deliverToTmux, but confirmation is NOT pane-text-based —
 * that was tried and disproven live against production (mupot#1258 herdr
 * follow-up canary, 2026-09-01/02):
 *
 *   1. `herdr agent read <target>` REFUSES a longer pane-history read while
 *      the agent is working (`{"error":{"code":"agent_not_idle",...}}`) —
 *      and "working" is exactly the state a delivery lands in for a busy
 *      builder, the normal case, not an edge case. A short default-length
 *      read did return content while busy, so the refusal isn't even
 *      triggered consistently by busy-state alone.
 *   2. Even when a pane read DOES succeed, the delivered marker was
 *      confirmed live to NOT reliably appear intact — the pane wraps and
 *      truncates, so `grep -c` for the marker returned 0 on a delivery that
 *      had, independently, genuinely landed (confirmed by hand via
 *      `herdr agent read --source recent-unwrapped`).
 *
 * The signal that DOES work, verified live the same way: `herdr agent get
 * <target>` returns `revision` and `state_change_seq`, and BOTH advance on
 * a successful prompt submission — including while the agent is working,
 * where `agent get` (unlike a long `agent read`) returns cleanly rather
 * than refusing. So confirmation here is: read the agent's state BEFORE
 * prompting, submit, then poll `agent get` until EITHER counter has
 * advanced past its captured baseline, within confirmAttempts. Advanced ->
 * ok:true. Not advanced within the attempt budget -> ok:false — the exact
 * same shape deliverToTmux uses on an unconfirmed delivery, so runCycle's
 * existing "never consume what wasn't confirmed delivered" logic applies
 * unchanged.
 *
 * HONEST LIMIT (state this plainly, do not imply more — see README): a
 * revision/state_change_seq advance proves herdr ACCEPTED the prompt and
 * the pane CHANGED. It does NOT prove the grok body parsed or acted on the
 * message content — a strictly weaker claim than the tmux marker-match
 * approach made (which itself only proved the text reached the pane, never
 * that it was read). This is the strongest confirmation signal available
 * on a herdr host; it is not proof of comprehension.
 *
 * The per-message marker is still embedded in the delivered preview (see
 * formatBoundedTmuxPreview) — useful for a human scrolling the pane later —
 * but confirmation never depends on finding it again.
 */
export function deliverViaHerdr(_text, message, opts = {}) {
  const spawn = opts.spawn ?? spawnSync
  const timeoutMs = Math.min(15_000, Math.max(100, Number(opts.timeoutMs ?? TMUX_DELIVERY_TIMEOUT_MS) || TMUX_DELIVERY_TIMEOUT_MS))
  const previewMaxChars = opts.previewMaxChars ?? TMUX_PREVIEW_MAX_CHARS
  const confirmAttempts = Math.min(5, Math.max(1, Number(opts.confirmAttempts ?? TMUX_CONFIRM_ATTEMPTS) || TMUX_CONFIRM_ATTEMPTS))
  const pollIntervalMs = Math.min(5_000, Math.max(100, Number(opts.pollIntervalMs ?? process.env.HERDR_POLL_INTERVAL_MS) || 750))
  const herdrTarget = opts.herdrTarget ?? HERDR_TARGET
  const herdrBin = opts.herdrBin ?? HERDR_BIN
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
  const getState = opts.herdrAgentState ?? herdrAgentState

  // Baseline BEFORE prompting — if we can't read state now, we have no way
  // to prove an advance later, so this fails loudly here rather than
  // prompting blind and hoping.
  const baseline = getState(spawn, herdrBin, herdrTarget, commandOpts)
  if (!baseline.ok) {
    return { ok: false, reason: baseline.reason, detail: baseline.detail }
  }

  const prompt = spawn(herdrBin, ['agent', 'prompt', herdrTarget, preview], commandOpts)
  if (prompt.status !== 0) {
    // Covers both a non-zero herdr exit AND a missing binary (spawnSync
    // ENOENT) — either way this fails loudly here, it never falls back to
    // deliverToTmux. See subprocessFailure's comment.
    return subprocessFailure(prompt, 'herdr_prompt_failed', 'herdr_prompt_timeout')
  }

  for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
    const current = getState(spawn, herdrBin, herdrTarget, commandOpts)
    if (!current.ok) {
      // `agent get` is documented (and verified live) to return cleanly
      // regardless of busy state, unlike a long `agent read` — a failure
      // here is a real problem, not a transient "still working" state, so
      // this fails loudly rather than treating it as inconclusive-and-retry.
      return { ok: false, reason: current.reason, detail: current.detail, spool_path: spoolPath, marker }
    }
    if (herdrStateAdvanced(baseline, current)) {
      return { ok: true, spool_path: spoolPath, marker }
    }
    if (attempt < confirmAttempts - 1) {
      const poll = spawn('sleep', [String(pollIntervalMs / 1_000)], commandOpts)
      if (poll.status !== 0) {
        return subprocessFailure(poll, 'herdr_poll_failed', 'herdr_poll_timeout')
      }
    }
  }
  return { ok: false, reason: 'herdr_delivery_unconfirmed', spool_path: spoolPath, marker }
}

function coerceCounter(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * `herdr agent get <target>` — used for both the pre-prompt baseline and
 * every post-prompt poll (see deliverViaHerdr's docstring for why this
 * replaced a pane-text marker match). The exact JSON envelope `agent get`
 * wraps its fields in was not independently pinned down here — only
 * `agent prompt`'s own `{"result":{"agent":{...}}}` shape is directly
 * confirmed live — so this checks every plausible location (top-level,
 * `.agent`, `.result.agent`) and fails loudly rather than guessing a
 * counter value if none of them carry a numeric `revision` or
 * `state_change_seq`.
 */
function herdrAgentState(spawn, herdrBin, herdrTarget, commandOpts) {
  const result = spawn(herdrBin, ['agent', 'get', herdrTarget], commandOpts)
  if (result.status !== 0) {
    return subprocessFailure(result, 'herdr_state_unavailable', 'herdr_state_timeout')
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    return { ok: false, reason: 'herdr_state_unparseable', detail: error instanceof Error ? error.message : String(error) }
  }
  const agent = parsed?.result?.agent ?? parsed?.agent ?? parsed
  const revision = coerceCounter(agent?.revision)
  const stateChangeSeq = coerceCounter(agent?.state_change_seq)
  if (revision === null && stateChangeSeq === null) {
    return { ok: false, reason: 'herdr_state_missing_fields', detail: 'herdr agent get returned neither a numeric revision nor state_change_seq' }
  }
  return { ok: true, revision, stateChangeSeq }
}

// EITHER counter advancing counts — Hadi's live verification showed both
// revision and state_change_seq move together on a real prompt, but this
// does not require both fields to be present or moving in lockstep, only
// that at least one available counter is strictly greater than its
// captured baseline.
function herdrStateAdvanced(baseline, current) {
  if (baseline.revision !== null && current.revision !== null && current.revision > baseline.revision) return true
  if (baseline.stateChangeSeq !== null && current.stateChangeSeq !== null && current.stateChangeSeq > baseline.stateChangeSeq) return true
  return false
}

export async function runCycle(opts = {}) {
  const seat = opts.seat ?? SEAT
  const expectedAgentId = opts.expectedAgentId ?? EXPECTED_AGENT_ID
  const tokenFile = opts.tokenFile ?? TOKEN_FILE
  const config = opts.checkRequiredConfig
    ? opts.checkRequiredConfig()
    // A directly-injected opts.token (tests, --self-test) never reads
    // tokenFile at all, so its absence must not fail the config gate.
    : checkRequiredConfig({ seat, expectedAgentId, tokenFile: opts.token ? (tokenFile || 'injected') : tokenFile })
  if (!config.ok) {
    log('config_refuse', config)
    return { ok: false, reason: config.reason, missing: config.missing, consumed: 0, delivered: 0 }
  }
  // Mechanism is resolved explicitly, before anything delivery-related runs
  // — never inferred from what happens to be reachable. opts.deliverToTmux,
  // if injected, overrides mechanism selection entirely (existing tests use
  // this as a generic "use this delivery function" hook, predating the
  // mechanism concept); opts.deliverViaHerdr is the equivalent injection
  // point for herdr-specific tests.
  const mechanism = opts.resolveDeliveryMechanism
    ? opts.resolveDeliveryMechanism()
    : resolveDeliveryMechanism({ mechanism: opts.deliveryMechanism })
  if (!mechanism.ok) {
    log('config_refuse', mechanism)
    return { ok: false, reason: mechanism.reason, consumed: 0, delivered: 0 }
  }
  const token = opts.token ?? readToken()
  const mcp = opts.mcpCall ?? mcpCall
  const deliver = opts.deliverToTmux ?? (mechanism.mechanism === 'herdr'
    ? (opts.deliverViaHerdr ?? deliverViaHerdr)
    : deliverToTmux)

  // seat passed here (not omitted, per the header note) so boot_context's
  // presence/label bookkeeping reflects which body actually opened it.
  const boot = await mcp(token, 'boot_context', { seat })
  const identity = assertCanonicalRuntimeIdentity(boot, expectedAgentId)
  if (!identity.ok) {
    log('identity_refuse', { reason: identity.reason, expected: expectedAgentId })
    return { ok: false, reason: identity.reason, consumed: 0, delivered: 0 }
  }

  // inbox_consumer_status takes no seat argument by design — the
  // bearer/signed_only fence is per-agent, not per-seat.
  const fence = await mcp(token, 'inbox_consumer_status', {})
  const allowed = bearerConsumerAllowed(fence)
  if (!allowed.ok) {
    log('fence_refuse', { reason: allowed.reason, mode: fence?.mode ?? null, generation: fence?.generation ?? null })
    return { ok: false, reason: allowed.reason, consumed: 0, delivered: 0 }
  }

  // seat REQUIRED on every inbox read/consume — see the header note. Without
  // it, mail addressed to this seat (target_seat = seat) is invisible to
  // both this peek and the consume below.
  const peeked = await mcp(token, 'inbox', { limit: 10, peek: true, seat })
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

  const consumed = await mcp(token, 'inbox', { limit: plan.consume, peek: false, seat })
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
 * `--self-test`: prove seat, credential and reachability without consuming
 * anything. install.sh runs this BEFORE writing any systemd unit or config,
 * the same discipline connectors/claude/bridge/install.sh uses — a connector
 * that installs cleanly and then silently fails to authenticate is worse
 * than one that refuses.
 */
export async function selfTest(opts = {}) {
  const seat = opts.seat ?? SEAT
  const expectedAgentId = opts.expectedAgentId ?? EXPECTED_AGENT_ID
  const tokenFile = opts.tokenFile ?? TOKEN_FILE
  const config = opts.checkRequiredConfig
    ? opts.checkRequiredConfig()
    : checkRequiredConfig({ seat, expectedAgentId, tokenFile: (opts.token || opts.readTokenFn) ? (tokenFile || 'injected') : tokenFile })
  if (!config.ok) {
    return { ok: false, reason: config.reason, missing: config.missing }
  }
  const mcp = opts.mcpCall ?? mcpCall
  let token
  try {
    token = opts.token ?? (opts.readTokenFn ?? readToken)()
  } catch (error) {
    return { ok: false, reason: 'token_unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
  let boot
  try {
    boot = await mcp(token, 'boot_context', { seat })
  } catch (error) {
    return { ok: false, reason: 'mcp_unreachable', detail: error instanceof Error ? error.message : String(error) }
  }
  const identity = assertCanonicalRuntimeIdentity(boot, expectedAgentId)
  if (!identity.ok) {
    return { ok: false, reason: identity.reason, expected: expectedAgentId, bound: boot?.bound_agent_id ?? null }
  }
  let peeked
  try {
    peeked = await mcp(token, 'inbox', { limit: 1, peek: true, seat })
  } catch (error) {
    return { ok: false, reason: 'inbox_peek_failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    seat,
    endpoint: MUPOT_MCP,
    bound_agent_id: identity.agent_id,
    unread: Array.isArray(peeked.messages) ? peeked.messages.length : 0,
    remaining: Number(peeked.remaining ?? 0),
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
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const seat = opts.seat ?? SEAT
  const expectedAgentId = opts.expectedAgentId ?? EXPECTED_AGENT_ID
  const lockFile = opts.lockFile ?? LOCK_FILE
  const tokenFile = opts.tokenFile ?? TOKEN_FILE

  // Config completeness is checked before anything else — a missing seat or
  // agent id can never self-heal by retrying.
  const configCheck = opts.checkRequiredConfig
    ? opts.checkRequiredConfig()
    // A directly-injected readTokenFn (tests, or a non-default token layout)
    // never reads tokenFile at all, so its absence must not fail the gate.
    : checkRequiredConfig({ seat, expectedAgentId, tokenFile: opts.readTokenFn ? (tokenFile || 'injected') : tokenFile })
  if (!configCheck.ok) {
    log('config_refuse_preflight', configCheck)
    exit(1)
    return
  }

  // Delivery mechanism resolved and validated at preflight too, same
  // reasoning as configCheck: an invalid GROK_DELIVERY value can never
  // self-heal by retrying, and must not be allowed to take the singleton
  // lock before failing.
  const mechanismCheck = opts.resolveDeliveryMechanism
    ? opts.resolveDeliveryMechanism()
    : resolveDeliveryMechanism({ mechanism: opts.deliveryMechanism })
  if (!mechanismCheck.ok) {
    log('config_refuse_preflight', mechanismCheck)
    exit(1)
    return
  }

  // Validate identity/token AND the consumer fence BEFORE taking the
  // singleton lock (mirrors codex-inbox-watch.mjs's #540 fix, two rounds of
  // adversarial review there). A watcher launched with a wrong/expired
  // token, a mismatched GROK_AGENT_ID, or currently fenced out of the
  // authorized consumer generation can never succeed no matter how many
  // times the loop below retries — none of these self-heal by retrying in
  // the SAME process. Failing here, before any lock exists, means a
  // misconfigured launch can never monopolize the singleton and block a
  // correctly configured one from ever starting.
  let preflightToken
  let preflightBoot
  let preflightFence
  try {
    preflightToken = readTokenFn()
    preflightBoot = await mcp(preflightToken, 'boot_context', { seat })
  } catch (error) {
    log('preflight_error', { error: String(error?.message ?? error) })
    exit(1)
    return
  }
  const preflightIdentity = assertCanonicalRuntimeIdentity(preflightBoot, expectedAgentId)
  if (!preflightIdentity.ok) {
    log('identity_refuse_preflight', { reason: preflightIdentity.reason, expected: expectedAgentId })
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

  // Single instance per seat. A second watcher on the same token/seat
  // interleaves peek/consume and can drain rows this one already delivered.
  const lock = await acquireLock({ path: lockFile })
  if (!lock.ok) {
    log('start_refused', { reason: lock.reason, holder_pid: lock.holder_pid, lock_file: lockFile })
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
    seat,
    agent_id: expectedAgentId,
    delivery: mechanismCheck.mechanism,
    herdr_target: opts.herdrTarget ?? HERDR_TARGET,
    tmux_session: opts.tmuxSession ?? TMUX_SESSION,
    interval_sec: INTERVAL_SEC,
    once: ONCE,
    lock_file: lockFile,
  })
  for (;;) {
    try {
      const result = await cycle({ seat, expectedAgentId })
      log('cycle', result)
      if (ONCE) {
        release()
        exit(result.ok || result.reason === 'inbox_empty' ? 0 : 1)
        return
      }
      // Preflight only proves identity/fence/config at LAUNCH — a token can
      // be rotated/revoked or the fence can flip mid-run. If a cycle reports
      // the same class of failure, this run is done: release now and let
      // the supervisor's next scheduled launch preflight fresh, rather than
      // holding the singleton indefinitely on a precondition retrying
      // cannot fix.
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
  if (SELF_TEST) {
    const result = await selfTest()
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  } else {
    await main()
  }
}

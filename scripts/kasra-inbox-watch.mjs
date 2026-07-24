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
} from '../fleet-runtime/claude-code-inbox-adapter.mjs'

const MUPOT_MCP = process.env.MUPOT_MCP || 'https://mupot.mumega.com/mcp'
const TOKEN_FILE = process.env.KASRA_TOKEN_FILE || join(homedir(), '.fleet', 'agents', 'kasra-agent.token')
const EXPECTED_AGENT_ID = process.env.KASRA_AGENT_ID || 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
const TMUX_SESSION = process.env.TMUX_SESSION || 'kasra'
const INTERVAL_SEC = Math.min(60, Math.max(5, Number(process.env.INTERVAL_SEC || 30) || 30))
const ONCE = process.argv.includes('--once')

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
  log('inbox_consumed', {
    agent_id: identity.agent_id,
    count: consumedMessages.length,
    receipts,
  })
  return {
    ok: consumedMessages.length === plan.consume,
    reason: consumedMessages.length === plan.consume ? 'delivered_and_consumed' : 'consume_mismatch',
    consumed: consumedMessages.length,
    delivered: deliveredCount,
    peeked: messages.length,
    remaining: Number(consumed.remaining ?? peeked.remaining ?? 0),
    receipts,
    agent_id: identity.agent_id,
  }
}

async function main() {
  log('start', {
    mcp: MUPOT_MCP,
    agent_id: EXPECTED_AGENT_ID,
    tmux_session: TMUX_SESSION,
    interval_sec: INTERVAL_SEC,
    once: ONCE,
  })
  for (;;) {
    try {
      const result = await runCycle()
      log('cycle', result)
      if (ONCE) process.exit(result.ok || result.reason === 'inbox_empty' ? 0 : 1)
    } catch (error) {
      log('cycle_error', { error: String(error?.message ?? error) })
      if (ONCE) process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_SEC * 1000))
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  await main()
}

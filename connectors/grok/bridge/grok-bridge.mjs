#!/usr/bin/env node
// Grok TUI Stop-hook drain. peek → spool → block → consume.
// A hook must never break the session: every failure prints suppressOutput and exits 0.
// Identity comes from check_in. No $AGENT_NAME fallback. Do not install from this task.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const adapterPath = [
  join(here, 'grok-inbox-adapter.mjs'),
  join(here, '../../../fleet-runtime/grok-inbox-adapter.mjs'),
].find((p) => existsSync(p))
if (!adapterPath) {
  process.stdout.write(`${JSON.stringify({ suppressOutput: true })}\n`)
  process.exit(0)
}
const {
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
} = await import(pathToFileURL(adapterPath).href)

const ENDPOINT = process.env.MUPOT_ENDPOINT || 'https://mupot.mumega.com/mcp'
const HOME = process.env.MUPOT_BRIDGE_HOME || join(homedir(), '.grok', 'mupot-inbox')
const LIMIT = Number(process.env.MUPOT_BRIDGE_LIMIT || 10)
const SELF_TEST = process.argv.includes('--self-test')

function failOpen(note) {
  if (SELF_TEST) {
    console.error(`SELF-TEST FAIL: ${note}`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(grokFailOpen())}\n`)
  process.exit(0)
}

function log(msg) {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(join(HOME, 'bridge.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a', mode: 0o600 })
  } catch {
    // logging must never take down the hook
  }
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {}
  const lines = []
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) lines.push(line)
  const raw = lines.join('\n').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function pot(name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MUPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'mcp_error')
  const content = json.result?.content
  if (Array.isArray(content) && content[0]?.text) {
    try {
      return JSON.parse(content[0].text)
    } catch {
      return json.result
    }
  }
  return json.result
}

function loadToken(seat) {
  const tokenFile = process.env.MUPOT_TOKEN_FILE
    || join(homedir(), '.fleet', 'agents', `${seat}-agent-bound.token`)
  if (!existsSync(tokenFile)) return null
  return readFileSync(tokenFile, 'utf8').replace(/\r?\n/g, '')
}

async function main() {
  const hookInput = await readStdinJson()
  const gate = grokStopShouldDrain(hookInput)
  if (!SELF_TEST && !gate.drain) failOpen(gate.reason)

  const seat = process.env.MUPOT_BRIDGE_SEAT || process.argv.find((a) => !a.startsWith('-') && a !== process.argv[1]) || ''
  if (!seat) failOpen('no seat')

  mkdirSync(join(HOME, 'spool'), { recursive: true, mode: 0o700 })
  const turnFile = join(HOME, `${seat}.turn.json`)
  let turn = { delivered: false, continuations: 0 }
  try {
    if (existsSync(turnFile)) turn = JSON.parse(readFileSync(turnFile, 'utf8'))
  } catch {
    turn = { delivered: false, continuations: 0 }
  }
  if (hookInput.stopHookActive) turn.continuations += 1
  else turn = { delivered: false, continuations: 0 }

  const skip = grokStopShouldSkip(hookInput, turn.delivered)
  if (skip.skip) failOpen(skip.reason)
  const cap = grokContinuationAllowed(turn.continuations)
  if (!cap.ok) failOpen(cap.reason)

  const token = loadToken(seat)
  if (!token) failOpen('no token')
  process.env.MUPOT_TOKEN = token

  const who = await pot('check_in', {})
  const bound = who?.result?.agent_id || who?.agent_id
  if (!bound) failOpen('token did not authenticate')
  const ident = assertCanonicalRuntimeIdentity({ bound_agent_id: bound }, bound)
  if (!ident.ok) failOpen(ident.reason)

  if (SELF_TEST) {
    const peek = await pot('inbox', { limit: 1, peek: true })
    const messages = peek?.result?.messages || peek?.messages || []
    console.log('SELF-TEST OK')
    console.log(`  seat:     ${seat}`)
    console.log(`  endpoint: ${ENDPOINT}`)
    console.log(`  bound to: ${bound}`)
    console.log(`  inbox:    ${messages.length} unread (peeked, nothing consumed)`)
    process.exit(0)
  }

  const fence = await pot('inbox_consumer_status', {})
  const allowed = bearerConsumerAllowed(fence?.result || fence)
  if (!allowed.ok) failOpen(allowed.reason)

  let lock
  try {
    lock = openSync(join(HOME, `${seat}.lock`), 'wx')
  } catch {
    failOpen('another drain is in flight')
  }

  try {
    const peek = await pot('inbox', { limit: LIMIT, peek: true })
    const batch = peek?.result || peek || {}
    const messages = (batch.messages || []).filter((m) => m.from_agent !== bound)
    if (messages.length === 0) failOpen('inbox_empty')

    const stamp = `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`
    writeFileSync(join(HOME, 'spool', `${stamp}.peek.json`), JSON.stringify(batch), { mode: 0o600 })

    const nudges = messages.map((m) => formatGrokNudge(m)).join('\n\n')
    const plan = planInboxConsume({ peekedCount: messages.length, deliveredCount: messages.length })
    if (plan.consume === 0) failOpen(plan.reason)

    const decision = grokBlockDecision(
      `[mupot inbox — authoritative receive]\n${nudges}`,
    )
    if (isUnsafeStopHookDelivery({
      peek: true,
      consumed: false,
      decision: decision.decision,
      suppressOutput: false,
      text: decision.reason,
    })) failOpen('unsafe_delivery')

    process.stdout.write(`${JSON.stringify(decision)}\n`)

    const consumed = await pot('inbox', { limit: plan.consume, peek: false })
    writeFileSync(join(HOME, 'spool', `${stamp}.consumed.json`), JSON.stringify(consumed), { mode: 0o600 })
    const consumedMessages = consumed?.result?.messages || consumed?.messages || []
    const verified = verifyConsumedBatch({ expected: messages, consumed: consumedMessages })
    if (!verified.ok) log(`consume_verify ${verified.reason}`)

    turn.delivered = true
    writeFileSync(turnFile, JSON.stringify(turn), { mode: 0o600 })
    log(`delivered seat=${seat} stamp=${stamp} n=${messages.length}`)
  } finally {
    try { closeSync(lock) } catch { /* ignore */ }
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(join(HOME, `${seat}.lock`))
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  log(`fail ${err instanceof Error ? err.message : String(err)}`)
  failOpen('exception')
})

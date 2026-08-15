// tests/inbox-stream-delivery.test.ts — the #706 headline claim, proven against the real schema.
//
// WHY THIS TEST EXISTS
//
// The re-gate of PR #719 (Kasra, "CODE PASSES, EVIDENCE BLOCKS") verified both P0 fixes in
// source and still BLOCKED, naming the one non-negotiable evidence gap:
//
//   "One test that opens the stream with an injected sleep, inserts a message whose seq is
//    ABOVE the 100-row window, and asserts it arrives — against a real SQL engine
//    (createSqliteD1() + applyAllMigrations()), not the fake, or it re-tests the mock."
//
// Before the P0-1 fix the stream read `peek + limit: 100` with NO cursor: after the initial
// flush consumed the window, every poll re-read the SAME oldest-100 rows, the in-memory
// isNew filter dropped all of them, and the generator yielded heartbeats forever while HTTP
// stayed 200 — stream starvation at unread >= 100. This test seeds 150 unread rows, opens
// the stream, sends a message at seq 151 AFTER open, and asserts it arrives. It fails on the
// pre-fix code (the poll never sees seq > 150) and passes on the post-fix code (the sinceSeq
// cursor pushed into the SQL, `seq > ?3` in readAgentInboxForReader's peek query). That
// counterfactual is the point: a test written alongside the fix that cannot fail without it
// is the fix restated, not evidence of it (#684/#721 violation class).
//
// SCHEMA DISCIPLINE
//
// The schema is the WHOLE committed migration chain via tests/helpers/migrations.ts — the only
// sanctioned source (scripts/check-test-schema-source.mjs ratchet). This test imports
// production code (streamInboxEvents, readAgentInbox), so it must build its schema this way;
// a hand-written CREATE TABLE agent_messages here would re-open exactly the hole the gate
// closed. agent_messages carries no foreign keys (0032), so seeding goes straight at the
// table — no org scaffolding needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { streamInboxEvents, type InboxStreamEvent } from '../src/agents/inbox-routes'
import { readAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const AGENT = 'ag-stream-recipient'
const SENDER = 'ag-stream-sender'
const MEMBER = 'mem-stream-sender'
const WINDOW = 100 // MAX_INBOX_LIMIT — the stream's per-read cap
const BACKLOG = 150 // deliberately > WINDOW: pins the oldest-100 window pre-fix

let harness: SqliteD1Harness
let env: Env

// Deterministic poll cadence: sleep() resolves only when the test releases a tick, so the
// generator advances exactly one poll per tick() and every interleaving is under test control.
function makeGate() {
  let next: (() => void) | null = null
  const sleep = (_ms: number): Promise<void> => new Promise<void>((resolve) => { next = resolve })
  return {
    sleep,
    tick(): void {
      const release = next
      next = null
      if (release) release()
    },
  }
}

async function insertUnread(body: string): Promise<number> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'message', ?6, datetime('now'))`,
  ).bind(id, TENANT, AGENT, SENDER, MEMBER, body).run()
  const row = await env.DB.prepare('SELECT seq FROM agent_messages WHERE id = ?1').bind(id).first<{ seq: number }>()
  if (!row) throw new Error('insert did not land')
  return Number(row.seq)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})
afterEach(() => harness.close())

describe('inbox SSE delivery against the real migration schema (#706 gate evidence)', () => {
  it('delivers a message sent AFTER stream-open, above the pinned 100-row window', async () => {
    for (let i = 1; i <= BACKLOG; i += 1) await insertUnread(`seed ${i}`)

    const gate = makeGate()
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, pollMs: 1000 }, { sleep: gate.sleep })

    // Initial flush: the window-cap means exactly the oldest 100 rows, cursor advanced to 100.
    const initial = await gen.next()
    expect(initial.done).toBe(false)
    const first = initial.value as InboxStreamEvent
    expect(first.type).toBe('initial')
    if (first.type !== 'initial') throw new Error('expected initial frame')
    expect(first.messages).toHaveLength(WINDOW)
    expect(first.messages.map((m) => m.seq)).toEqual(Array.from({ length: WINDOW }, (_, i) => i + 1))
    expect(first.since).toBe(WINDOW)

    // Poll 1: the remaining 50 backlog rows (101..150) — the cursor advanced past the
    // pinned window. Pre-fix, this poll re-read rows 1..100 and the isNew filter dropped
    // them all, so NOTHING past the window ever arrived. The generator emits ONE `message`
    // event per row and ONE `heartbeat` per empty poll, so each gen.next() consumes exactly
    // one event; ticks release the next poll's sleep.
    const backlogDrain: number[] = []
    let backlogDone = false
    for (let events = 0; events < 200 && !backlogDone; events += 1) {
      const p = gen.next()
      gate.tick() // harmless when the generator is between yields (no pending sleep)
      const ev = await p
      expect(ev.done).toBe(false)
      const event = ev.value as InboxStreamEvent
      if (event.type === 'message') backlogDrain.push(event.message.seq)
      else if (event.type === 'heartbeat') backlogDone = true // nothing left above the cursor
      else throw new Error(`unexpected event while draining backlog: ${event.type}`)
    }
    expect(backlogDrain).toEqual(Array.from({ length: BACKLOG - WINDOW }, (_, i) => WINDOW + 1 + i))

    // The after-open send: seq 151, ABOVE the window the stream already flushed.
    const lateSeq = await insertUnread('delivered after stream open')
    expect(lateSeq).toBe(BACKLOG + 1)

    // Drain ticks until the late message arrives — bounded so a regression fails loudly
    // (heartbeats forever = starvation) instead of hanging the suite.
    const delivered: number[] = []
    let sawLate = false
    for (let polls = 0; polls < 20 && !sawLate; polls += 1) {
      const nextEventPromise = gen.next()
      gate.tick()
      const ev = await nextEventPromise
      expect(ev.done).toBe(false)
      const event = ev.value as InboxStreamEvent
      if (event.type === 'message') {
        delivered.push(event.message.seq)
        if (event.message.seq === lateSeq) {
          sawLate = true
          expect(event.message.body).toBe('delivered after stream open')
        }
      } else if (event.type !== 'heartbeat') {
        throw new Error(`unexpected event while draining: ${event.type}`)
      }
    }
    expect(sawLate).toBe(true)
    // Nothing at or below the flushed window is ever re-emitted.
    expect(delivered.every((seq) => seq > WINDOW)).toBe(true)

    // The stream notifies; it never consumes — a subsequent peek still counts all 151 unread.
    const peek = await readAgentInbox(env, { agent: AGENT, peek: true, limit: WINDOW, sinceSeq: 0 })
    if (!peek.ok) throw new Error(`peek failed: ${peek.reason}`)
    expect(peek.remaining).toBe(BACKLOG + 1)

    await gen.return(undefined)
  })

  it('resumes from a client cursor without re-emitting rows at or below it', async () => {
    for (let i = 1; i <= BACKLOG; i += 1) await insertUnread(`seed ${i}`)

    const gate = makeGate()
    const gen = streamInboxEvents(env, { agent: AGENT, since: WINDOW, pollMs: 1000 }, { sleep: gate.sleep })

    // Reconnect with since=100: the remaining 50 unread (101..150) arrive in one frame.
    const initial = await gen.next()
    expect(initial.done).toBe(false)
    const first = initial.value as InboxStreamEvent
    expect(first.type).toBe('initial')
    if (first.type !== 'initial') throw new Error('expected initial frame')
    expect(first.messages.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => WINDOW + 1 + i))
    expect(first.since).toBe(BACKLOG)

    await gen.return(undefined)
  })

  it('emits heartbeats while the window is pinned and nothing new is sent', async () => {
    for (let i = 1; i <= WINDOW; i += 1) await insertUnread(`seed ${i}`)

    const gate = makeGate()
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, pollMs: 1000 }, { sleep: gate.sleep })

    const initial = await gen.next()
    expect((initial.value as InboxStreamEvent).type).toBe('initial')

    // Two consecutive empty polls → two heartbeats, stream stays alive.
    for (let i = 0; i < 2; i += 1) {
      const p = gen.next()
      gate.tick()
      const ev = await p
      expect(ev.done).toBe(false)
      expect((ev.value as InboxStreamEvent).type).toBe('heartbeat')
    }

    await gen.return(undefined)
  })
})

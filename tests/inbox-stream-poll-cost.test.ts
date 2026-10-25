// tests/inbox-stream-poll-cost.test.ts — the SSE tick must stay cheap (prod 2026-10-25: 97% of D1 queries
// were /api/inbox/stream at 1 s x ~86 streams). Real migration schema; statements counted via a prepare proxy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { STREAM_REVALIDATE_MS, streamInboxEvents, type InboxStreamEvent } from '../src/agents/inbox-routes'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const AGENT = 'ag-poll-recipient'

let harness: SqliteD1Harness
let n = 0
let env: Env

// Virtual clock: sleep() advances time instantly, so 60 s of idle stream runs in ms.
function clock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    nowMs: () => t,
  }
}

async function nextOf(gen: AsyncGenerator<InboxStreamEvent>): Promise<IteratorResult<InboxStreamEvent>> {
  return gen.next()
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  n = 0
  const wrapped = new Proxy(harness.db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'prepare') return (sql: string) => { n++; return (v as (s: string) => unknown).call(target, sql) }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  env = { DB: wrapped, TENANT_SLUG: TENANT } as unknown as Env
})
afterEach(() => harness.close())

describe('inbox stream poll cost', () => {
  it('idle stream over 60 s: 1 statement per tick after the connect flush, one revalidate', async () => {
    const c = clock()
    let revalidations = 0
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, revalidate: async () => { revalidations++; return true } }, { sleep: c.sleep, nowMs: c.nowMs })
    // No initial frame (empty inbox): the first next() runs the connect flush then the first tick.
    const afterConnect = n
    for (let i = 0; i < 6; i++) {
      const ev = await nextOf(gen)
      expect((ev.value as InboxStreamEvent).type).toBe('heartbeat')
    }
    const total = n
    expect(c.sleeps).toEqual([10000, 10000, 10000, 10000, 10000, 10000])
    // connect flush = SELECT + fence + COUNT (3); then 6 ticks x 1 SELECT. Before: 6 x 3 = 18 tick statements.
    expect(total).toBeLessThanOrEqual(3 + 6)
    expect(total - afterConnect).toBeLessThanOrEqual(9)
    expect(revalidations).toBe(1)
    await gen.return(undefined)
  })

  it('delivers a new message on the next tick', async () => {
    const c = clock()
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0 }, { sleep: c.sleep, nowMs: c.nowMs })
    expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat')
    await harness.db.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
       VALUES ('m1', ?1, ?2, 'ag-s', 'mem-s', 'message', 'hello', datetime('now'))`,
    ).bind(TENANT, AGENT).run()
    const ev = (await nextOf(gen)).value as InboxStreamEvent
    expect(ev.type).toBe('message')
    if (ev.type === 'message') expect(ev.message.body).toBe('hello')
    await gen.return(undefined)
  })

  it('a revoked token ends the stream within 60 s + one tick, and not before the window', async () => {
    const c = clock()
    let valid = true
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, revalidate: async () => valid }, { sleep: c.sleep, nowMs: c.nowMs })
    const start = c.nowMs()
    valid = false // revoked right after connect
    let ticks = 0
    for (;;) {
      const ev = await nextOf(gen)
      if (ev.done) break
      ticks++
      expect(ticks).toBeLessThan(20)
    }
    const elapsed = c.nowMs() - start
    expect(elapsed).toBeGreaterThanOrEqual(STREAM_REVALIDATE_MS)
    expect(elapsed).toBeLessThanOrEqual(STREAM_REVALIDATE_MS + 10000)
  })

  it('clamps poll_ms: below 5000 up to 5000, above 30000 down to 30000, default 10000', async () => {
    for (const [ask, want] of [[250, 5000], [1000, 5000], [7000, 7000], [999999, 30000], [undefined, 10000]] as const) {
      const c = clock()
      const gen = streamInboxEvents(env, { agent: AGENT, since: 0, pollMs: ask }, { sleep: c.sleep, nowMs: c.nowMs })
      await nextOf(gen)
      expect(c.sleeps[0]).toBe(want)
      await gen.return(undefined)
    }
  })
})

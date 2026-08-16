// tests/registry-seat-activity.test.ts — seat ACTIVITY (mupot#1117, migration 0106),
// the orthogonal twin of presence's REACHABILITY (tests/registry-presence-service.test.ts).
//
// Runs against REAL D1/SQL via the sqlite-d1 harness with the full migration chain —
// the SET-clause seq guard and the `activity IS NOT ?5` transition test are SQL
// behaviour, and a JS reimplementation of them would prove nothing about the statement
// that actually ships.
//
// Every test here is written to FAIL if its specific mechanism were removed:
//   1. a report lands and stamps activity_at
//   2. an out-of-order (lower) seq is ignored for activity — WHILE THE HEARTBEAT STILL
//      LANDS (the reason the guard is in the SET, not the WHERE)
//   3. re-asserting the same state bumps seq but does NOT move activity_at (long turn
//      vs wedge — the whole point of the column)
//   4. an UNREACHABLE seat reads activity 'unknown' while activity_reported keeps its
//      last word (the defect mupot#1117 exists to kill)
//   5. a never-reported seat is 'unknown', never 'idle'
//   6. reachable + fresh heartbeat + long-unchanged activity = the WEDGE signal:
//      status online, activity 'working', activity_stale true — proving the two axes
//      are genuinely independent and not one field wearing two names

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  registerModule,
  heartbeatModule,
  getModule,
  listPresence,
  PRESENCE_STALE_SECONDS,
  ACTIVITY_STALE_SECONDS,
} from '../src/registry/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const T0 = new Date('2026-08-16T12:00:00.000Z')
const at = (secondsAfterT0: number) => new Date(T0.getTime() + secondsAfterT0 * 1000)

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec("INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A')")
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    // Raw stored columns — asserted directly so a test can tell a STORED value from a
    // read-DERIVED one. Without this, "activity is unknown" could not be distinguished
    // from "activity was wiped on write", and the two are very different designs.
    raw: (identity: string) =>
      harness.sqlite
        .prepare(
          'SELECT status, last_heartbeat, activity, activity_message, activity_seq, activity_at FROM module_registry WHERE tenant = ? AND identity = ? AND project_id IS ?',
        )
        .get(TENANT, identity, 'proj-a') as
        | {
            status: string
            last_heartbeat: string
            activity: string | null
            activity_message: string | null
            activity_seq: number
            activity_at: string | null
          }
        | undefined,
  }
}

async function seat(db: ReturnType<typeof makeDb>, identity = 'agent-1') {
  const result = await registerModule(
    db.env,
    { identity, kind: 'agent_system', adapter: 'prime_agent', projectId: 'proj-a' },
    T0,
  )
  expect(result.ok).toBe(true)
  return identity
}

describe('activity report — lands and stamps the transition', () => {
  it('a first report stores state, message and seq, and stamps activity_at', async () => {
    const db = makeDb()
    const id = await seat(db)

    const ok = await heartbeatModule(db.env, id, 'proj-a', at(10), {
      state: 'blocked',
      message: 'waiting on owner approval',
      seq: 7,
    })
    expect(ok).toBe(true)

    const row = db.raw(id)
    expect(row?.activity).toBe('blocked')
    expect(row?.activity_message).toBe('waiting on owner approval')
    expect(row?.activity_seq).toBe(7)
    expect(row?.activity_at).toBe(at(10).toISOString())

    const view = await getModule(db.env, id, 'proj-a', at(10))
    expect(view?.activity).toBe('blocked')
    expect(view?.activity_message).toBe('waiting on owner approval')
    expect(view?.activity_stale).toBe(false)
  })

  it('a plain heartbeat with no report leaves activity untouched', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })

    await heartbeatModule(db.env, id, 'proj-a', at(40))

    const row = db.raw(id)
    expect(row?.activity).toBe('working')
    expect(row?.activity_seq).toBe(1)
    expect(row?.activity_at).toBe(at(10).toISOString())
    // …but the heartbeat itself did land.
    expect(row?.last_heartbeat).toBe(at(40).toISOString())
  })
})

describe('seq guard — out-of-order reports cannot rewrite activity, but never block liveness', () => {
  it('a LOWER seq is ignored for activity WHILE the heartbeat still lands', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 5 })

    // A late report from a resumed/forked session, arriving after a newer one.
    const ok = await heartbeatModule(db.env, id, 'proj-a', at(60), { state: 'idle', seq: 3 })
    expect(ok).toBe(true)

    const row = db.raw(id)
    // Activity held at the higher-seq value…
    expect(row?.activity).toBe('working')
    expect(row?.activity_seq).toBe(5)
    expect(row?.activity_at).toBe(at(10).toISOString())
    // …and THIS is the assertion that fails if the guard is moved into the WHERE clause:
    // the seat is alive and must not age toward offline just because a report raced.
    expect(row?.last_heartbeat).toBe(at(60).toISOString())
  })

  it('an EQUAL seq is ignored too (strictly greater wins, so a replay cannot flip state)', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 5 })

    await heartbeatModule(db.env, id, 'proj-a', at(20), { state: 'done', seq: 5 })

    expect(db.raw(id)?.activity).toBe('working')
  })

  it('a HIGHER seq wins and re-stamps activity_at on a real transition', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 5 })

    await heartbeatModule(db.env, id, 'proj-a', at(70), { state: 'done', seq: 6 })

    const row = db.raw(id)
    expect(row?.activity).toBe('done')
    expect(row?.activity_seq).toBe(6)
    expect(row?.activity_at).toBe(at(70).toISOString())
  })
})

describe('activity_at — records a CHANGE, not a re-assertion', () => {
  it('re-asserting the same state advances seq but pins activity_at to the transition', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })

    // A seat re-reporting 'working' every 30s through a long turn.
    await heartbeatModule(db.env, id, 'proj-a', at(40), { state: 'working', seq: 2 })
    await heartbeatModule(db.env, id, 'proj-a', at(70), { state: 'working', seq: 3 })

    const row = db.raw(id)
    expect(row?.activity_seq).toBe(3)
    expect(row?.last_heartbeat).toBe(at(70).toISOString())
    // If activity_at moved on every report, a wedged seat would look perpetually fresh
    // and the wedge signal would be unbuildable. It must stay at the transition.
    expect(row?.activity_at).toBe(at(10).toISOString())
  })
})

describe('unreachable seats — the defect mupot#1117 exists to kill', () => {
  it("a seat that stops heartbeating reads activity 'unknown', not its last word", async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })

    // Well past the reachability window, with no further heartbeat: the seat died mid-turn.
    const later = at(10 + PRESENCE_STALE_SECONDS + 60)
    const view = await getModule(db.env, id, 'proj-a', later)

    expect(view?.status).toBe('offline')
    // The crashed seat must NOT keep reading as working — that is exactly how a dead
    // agent looks busy, which is the whole defect.
    expect(view?.activity).toBe('unknown')
    // …while its last word remains available to anyone who explicitly wants it.
    expect(view?.activity_reported).toBe('working')
    // And nothing was written to achieve that: derivation, not a sweep.
    expect(db.raw(id)?.activity).toBe('working')
  })

  it("a seat that never reported is 'unknown', never 'idle'", async () => {
    const db = makeDb()
    const id = await seat(db)

    const view = await getModule(db.env, id, 'proj-a', at(5))
    expect(view?.status).toBe('online')
    // Defaulting an unreported seat to 'idle' would invent a healthy reading out of
    // missing data — the same class of error as reading absent output as success.
    expect(view?.activity).toBe('unknown')
    expect(view?.activity_reported).toBeNull()
    expect(view?.activity_age_seconds).toBeNull()
    expect(view?.activity_stale).toBe(false)
  })
})

describe('the wedge signal — reachability and activity are genuinely independent', () => {
  it('a seat heartbeating happily while stuck on one activity reads online + stale', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })

    // Keep it reachable the whole way: heartbeat inside the presence window, repeatedly,
    // while the activity never changes. This is precisely the shape that read `active`
    // all evening on 2026-08-16 while nothing was actually progressing.
    let t = 10
    while (t < ACTIVITY_STALE_SECONDS + 120) {
      t += PRESENCE_STALE_SECONDS - 10
      await heartbeatModule(db.env, id, 'proj-a', at(t))
    }

    const view = await getModule(db.env, id, 'proj-a', at(t))
    expect(view?.status).toBe('online')
    expect(view?.activity).toBe('working')
    expect(view?.activity_stale).toBe(true)
    expect(view?.activity_age_seconds).toBeGreaterThan(ACTIVITY_STALE_SECONDS)
  })

  it('listPresence carries both axes for every row', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'idle', seq: 1 })

    const modules = await listPresence(db.env, { projectId: 'proj-a' }, at(20))
    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({
      identity: id,
      status: 'online',
      activity: 'idle',
      activity_stale: false,
    })
  })
})

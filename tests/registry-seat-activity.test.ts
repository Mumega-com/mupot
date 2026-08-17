// tests/registry-seat-activity.test.ts — seat ACTIVITY (mupot#1117, migration 0108),
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
          'SELECT status, last_heartbeat, activity, activity_message, activity_seq, activity_at, activity_report_at FROM module_registry WHERE tenant = ? AND identity = ? AND project_id IS ?',
        )
        .get(TENANT, identity, 'proj-a') as
        | {
            status: string
            last_heartbeat: string
            activity: string | null
            activity_message: string | null
            activity_seq: number
            activity_at: string | null
            activity_report_at: string | null
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

// ── Findings from the #1118 diverse gate (2026-08-17) ────────────────────────────────
// Three defects, none of which this suite caught while green and mutation-tested. Two
// independent reviewers on two model families found two different ones; the author found
// none. Each test below fails against the pre-gate code.
describe('gate finding (Loom/Gemini) — re-registration must reset the sequence origin', () => {
  it('a restarted seat starting its counter at 1 is NOT locked out by the old seq', async () => {
    const db = makeDb()
    const id = await seat(db)

    // Long-lived process climbs to a high seq, then dies mid-'working'.
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 45 })
    expect(db.raw(id)?.activity_seq).toBe(45)

    // systemd restarts it; the fresh process re-registers and its counter starts over.
    await registerModule(
      db.env,
      { identity: id, kind: 'agent_system', adapter: 'prime_agent', projectId: 'proj-a' },
      at(100),
    )

    // Pre-fix, ON CONFLICT left activity_seq at 45, so `1 > 45` was false and EVERY report
    // from the new process was silently dropped — the seat read online + 'working' + stale
    // forever while sitting idle. A healthy agent frozen as busy.
    const row = db.raw(id)
    expect(row?.activity_seq).toBe(0)
    expect(row?.activity).toBeNull()
    expect(row?.activity_at).toBeNull()

    const ok = await heartbeatModule(db.env, id, 'proj-a', at(110), { state: 'idle', seq: 1 })
    expect(ok).toBe(true)
    expect(db.raw(id)?.activity).toBe('idle')
    expect(db.raw(id)?.activity_seq).toBe(1)

    const view = await getModule(db.env, id, 'proj-a', at(115))
    expect(view?.activity).toBe('idle')
  })
})

describe('gate finding (Loom/Gemini) — stale is a claim-of-progress signal, not an age signal', () => {
  it('an idle seat unchanged for a long time is NOT stale', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'idle', seq: 1 })

    // Healthy, heartbeating, simply nothing queued — the normal state of a quiet fleet.
    let t = 10
    while (t < ACTIVITY_STALE_SECONDS + 300) {
      t += PRESENCE_STALE_SECONDS - 10
      await heartbeatModule(db.env, id, 'proj-a', at(t))
    }

    const view = await getModule(db.env, id, 'proj-a', at(t))
    expect(view?.status).toBe('online')
    expect(view?.activity).toBe('idle')
    // Pre-fix this was true, so any triage view filtering on activity_stale alerted on
    // every healthy resting seat — a flag that cries wolf until nobody reads it.
    expect(view?.activity_stale).toBe(false)
    expect(view?.activity_age_seconds).toBeGreaterThan(ACTIVITY_STALE_SECONDS)
  })

  it('a done seat unchanged for a long time is NOT stale either', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'done', seq: 1 })
    let t = 10
    while (t < ACTIVITY_STALE_SECONDS + 300) {
      t += PRESENCE_STALE_SECONDS - 10
      await heartbeatModule(db.env, id, 'proj-a', at(t))
    }
    const view = await getModule(db.env, id, 'proj-a', at(t))
    expect(view?.activity).toBe('done')
    expect(view?.activity_stale).toBe(false)
  })

  it('an UNREACHABLE seat is not stale either — unknown has nothing to be stale about', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })

    // No further heartbeat: it dies mid-turn and ages out of reachability.
    const later = at(10 + ACTIVITY_STALE_SECONDS + 600)
    const view = await getModule(db.env, id, 'proj-a', later)
    expect(view?.status).toBe('offline')
    expect(view?.activity).toBe('unknown')
    // 'stale' would imply a live claim gone quiet; this seat makes no live claim at all.
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

    // REWRITTEN after Loom's #1118 BLOCKER 1. This test previously asserted
    // activity === 'working' here, i.e. it PROVED the defect rather than catching it: the
    // field documented as "the value a reader may act on" was handing out a claim whose
    // reporter had been silent for twenty minutes.
    //
    // The wedge signal is unchanged and is still fully expressible — it just lives in the
    // honest fields now: the seat is reachable, it last CLAIMED 'working', that claim is
    // stale, and here is its age. What a reader may act on is 'unknown'.
    expect(view?.activity).toBe('unknown')
    expect(view?.activity_reported).toBe('working')
    expect(view?.activity_stale).toBe(true)
    expect(view?.activity_age_seconds).toBeGreaterThan(ACTIVITY_STALE_SECONDS)
  })

  it('a long turn INSIDE the window still reads as working — the fix must not blind the normal case', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })
    await heartbeatModule(db.env, id, 'proj-a', at(200))

    // Well inside ACTIVITY_STALE_SECONDS: a genuinely long turn must still be actionable,
    // or expiring the field would trade one blindness for another.
    const view = await getModule(db.env, id, 'proj-a', at(300))
    expect(view?.activity).toBe('working')
    expect(view?.activity_stale).toBe(false)
  })
})

describe('gate finding (Loom/Gemini) BLOCKER 2 — a rejected-seq storm must be visible', () => {
  it('a zombie clone replaying an old seq leaves activity_report_at frozen while the heartbeat advances', async () => {
    const db = makeDb()
    const id = await seat(db)

    // Process A reports seq 100, then crashes.
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 100 })
    const accepted = db.raw(id)?.activity_report_at
    expect(accepted).toBe(at(10).toISOString())

    // An old clone keeps emitting seq 99 every 90s. Each one loses the seq comparison.
    let t = 10
    for (let i = 0; i < 5; i += 1) {
      t += 90
      await heartbeatModule(db.env, id, 'proj-a', at(t), { state: 'idle', seq: 99 })
    }

    const row = db.raw(id)
    // Reachability keeps advancing — which is correct, and is exactly why this was invisible.
    expect(row?.last_heartbeat).toBe(at(t).toISOString())
    // …but nothing was accepted, and now that is READABLE rather than merely implied.
    expect(row?.activity_report_at).toBe(at(10).toISOString())
    expect(row?.activity_seq).toBe(100)

    const view = await getModule(db.env, id, 'proj-a', at(t))
    expect(view?.status).toBe('online')
    expect(view?.activity_seq).toBe(100)
    // The discriminator: heartbeat fresh, accepted-report old. An operator can now tell
    // "reports are arriving and being rejected" from "the seat went quiet".
    const heartbeatAge = (at(t).getTime() - Date.parse(row!.last_heartbeat)) / 1000
    const reportAge = (at(t).getTime() - Date.parse(view!.activity_report_at!)) / 1000
    expect(heartbeatAge).toBeLessThan(5)
    expect(reportAge).toBeGreaterThan(400)
  })

  it('an accepted report stamps activity_report_at even when the state does not change', async () => {
    const db = makeDb()
    const id = await seat(db)
    await heartbeatModule(db.env, id, 'proj-a', at(10), { state: 'working', seq: 1 })
    await heartbeatModule(db.env, id, 'proj-a', at(70), { state: 'working', seq: 2 })

    const row = db.raw(id)
    // activity_at pins the TRANSITION (still the wedge signal)…
    expect(row?.activity_at).toBe(at(10).toISOString())
    // …while activity_report_at proves reports are still landing. Two different questions,
    // two different columns; conflating them is what hid the zombie case.
    expect(row?.activity_report_at).toBe(at(70).toISOString())
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

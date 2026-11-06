import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sweepStalledGateReviews } from '../src/gates/stall-watchdog'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { listNeedsYou } from '../src/attention/service'
import { routinePrincipal } from '../src/routines/access'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const SQUAD_ID = 'squad-stall'
const AGENT = 'agent-gate-seat'
const LANE = 'gate:athena'
const T0 = new Date('2026-10-06T12:00:00.000Z')
const REVIEW_ENTERED = '2026-10-06T10:00:00.000Z'
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000)

// The wake path stamps its request id from the wall clock (reviewWakeRequestId(task, new Date())), and
// sendAgentMessage dedupes on it, so two sweeps in the same real millisecond collapse into one wake.
// Pin the wall clock to each sweep's own `now` so every sweep is its own instant, as in production.
const sweepAt = (env: Env, at: Date) => {
  vi.setSystemTime(at)
  return sweepStalledGateReviews(env, at)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

type Sqlite = ReturnType<typeof createSqliteD1>['sqlite']

function setup(vars: Partial<Env> = {}) {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-stall', 'dept-stall', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-stall', 'squad-stall', 'S');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT}', '${SQUAD_ID}', '${AGENT}', '${AGENT}', 'active');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('g1', '${LANE}', 'agent', '${AGENT}', 'owner-1', '2026-08-15T00:00:00.000Z');
  `)
  const env = { DB: harness.db, TENANT_SLUG: TENANT, ...vars } as unknown as Env
  return { harness, env, sqlite: harness.sqlite }
}

function seedReviewTask(sqlite: Sqlite, id: string, opts: { gateOwner?: string | null; status?: string; updatedAt?: string } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, updated_at)
       VALUES (?, ?, 'T', 'b', 'done', ?, ?, ?)`,
    )
    .run(id, SQUAD_ID, opts.status ?? 'review', opts.gateOwner === undefined ? LANE : opts.gateOwner, opts.updatedAt ?? REVIEW_ENTERED)
  sqlite.prepare('UPDATE tasks SET gate_wake_notice=? WHERE id=?').run(`Gate wake delivered: ${opts.gateOwner??LANE} -> agent ${AGENT} (bus=sent, inbox=sent).`,id)
}

function wakeCount(sqlite: Sqlite, taskId: string): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE request_id LIKE ?`)
    .get(`review-wake:${taskId}:%`) as { n: number }
  return row.n
}

function taskRow(sqlite: Sqlite, id: string): Record<string, unknown> {
  return sqlite.prepare(`SELECT status, gate_owner, updated_at, result FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>
}

describe('gate-stall watchdog', () => {
  it.each([
    null,
    'Gate wake resolution failed for gate:athena; no wake was attempted.',
    'Gate wake delivery_failed: gate:athena -> agent agent-gate-seat (bus=failed, inbox=failed).',
    'Gate wake partial: gate:athena -> agent agent-gate-seat (bus=sent, inbox=failed).',
    'Gate wake delivered: gate:athena -> agent previous-holder (bus=sent, inbox=sent).',
  ])('recovers an undelivered or wrong-holder first wake once after success (%s)',async notice=>{
    const {env,sqlite,harness}=setup();seedReviewTask(sqlite,'recover')
    sqlite.prepare("UPDATE tasks SET gate_wake_notice=? WHERE id='recover'").run(notice)
    expect(await sweepAt(env,T0)).toMatchObject({rewoken:1,undelivered:0,recorded:1})
    expect(wakeCount(sqlite,'recover')).toBe(1)
    expect(await sweepAt(env,minutes(31))).toMatchObject({rewoken:0,undelivered:0,recorded:1})
    expect(wakeCount(sqlite,'recover')).toBe(1)
    expect(sqlite.prepare("SELECT delivered_count FROM gate_stall_rewakes WHERE task_id='recover'").get()).toEqual({delivered_count:1})
    harness.close()
  })

  it('recovers when the grant was not live at review entry and later becomes live',async()=>{
    const {env,sqlite,harness}=setup();seedReviewTask(sqlite,'late-grant')
    sqlite.exec("DELETE FROM gate_grants WHERE id='g1'")
    const {wakeGateOwnerOnReview}=await import('../src/mcp')
    const task=sqlite.prepare("SELECT * FROM tasks WHERE id='late-grant'").get() as never
    expect((await wakeGateOwnerOnReview(env,task,{kind:'agent',id:'review-entry'},'review-entry')).status).toBe('no_live_holder')
    sqlite.prepare("INSERT INTO gate_grants(id,capability,principal_type,principal_id,granted_by,created_at) VALUES('g1',?,'agent',?,'owner-1','2026-08-15T00:00:00.000Z')").run(LANE,AGENT)
    expect(await sweepAt(env,T0)).toMatchObject({rewoken:1,undelivered:0})
    expect(wakeCount(sqlite,'late-grant')).toBe(1)
    await sweepAt(env,minutes(31));expect(wakeCount(sqlite,'late-grant')).toBe(1)
    harness.close()
  })

  it.each(['status','episode'])('does not recover a stale candidate after its %s changes',async change=>{
    const {env,sqlite,harness}=setup();seedReviewTask(sqlite,'changed-during-claim')
    sqlite.exec("UPDATE tasks SET gate_wake_notice=NULL WHERE id='changed-during-claim'")
    const prepare=harness.db.prepare.bind(harness.db);let changed=false
    harness.db.prepare=((query:string)=>{
      if(!changed&&query.includes('INSERT INTO gate_stall_rewakes')){
        changed=true
        if(change==='status')sqlite.exec("UPDATE tasks SET status='approved' WHERE id='changed-during-claim'")
        else sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id='changed-during-claim'").run(minutes(120).toISOString())
      }
      return prepare(query)
    }) as typeof harness.db.prepare
    expect(await sweepAt(env,T0)).toMatchObject({rewoken:0,recorded:1})
    expect(changed).toBe(true);expect(wakeCount(sqlite,'changed-during-claim')).toBe(0)
    harness.close()
  })

  it('keeps the first gate wake but records later stalls without sending mail', async () => {
    const {env,sqlite,harness}=setup()
    seedReviewTask(sqlite,'quiet')
    const {wakeGateOwnerOnReview}=await import('../src/mcp')
    const task=sqlite.prepare("SELECT * FROM tasks WHERE id='quiet'").get() as never
    await wakeGateOwnerOnReview(env,task,{kind:'agent',id:'initial-review'},'initial-review')
    expect(wakeCount(sqlite,'quiet')).toBe(1)
    const before=taskRow(sqlite,'quiet')
    const r=await sweepAt(env,T0)
    expect(wakeCount(sqlite,'quiet')).toBe(1)
    expect(r).toMatchObject({rewoken:0,undelivered:0,recorded:1})
    expect(sqlite.prepare("SELECT rewake_count,delivered_count,last_outcome FROM gate_stall_rewakes WHERE task_id='quiet'").get()).toEqual({rewake_count:1,delivered_count:0,last_outcome:'logged_no_mail'})
    expect(taskRow(sqlite,'quiet')).toEqual(before)
    harness.close()
  })

  it('records a stalled review without sending a second wake', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const res = await sweepAt(env, T0)
    expect(res).toMatchObject({ scanned: 1, recorded: 1, rewoken: 0, errors: 0 })
    expect(wakeCount(sqlite, 't1')).toBe(0)
    const claim = sqlite.prepare(`SELECT * FROM gate_stall_rewakes WHERE task_id = 't1'`).get() as Record<string, unknown>
    expect(claim).toMatchObject({ rewake_count: 1, review_since: REVIEW_ENTERED })
    expect(claim.last_outcome).toBeTruthy()
    harness.close()
  })

  it('does not wake a task younger than the threshold', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1', { updatedAt: new Date(T0.getTime() - 5 * 60_000).toISOString() })
    expect((await sweepAt(env, T0)).scanned).toBe(0)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    harness.close()
  })

  it('records only once per threshold window', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    await sweepAt(env, T0)
    const second = await sweepAt(env, minutes(10))
    expect(second.recorded).toBe(0)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    // Window (30 min default) elapsed.
    const third = await sweepAt(env, minutes(31))
    expect(third.recorded).toBe(1)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    harness.close()
  })

  it('two concurrent sweeps record exactly once without mail', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const [a, b] = await Promise.all([sweepAt(env, T0), sweepAt(env, T0)])
    expect(a.recorded + b.recorded).toBe(1)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    harness.close()
  })

  it('claim itself is atomic: a second claim in the same window changes no row', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    await sweepAt(env, T0)
    // Simulate a racer that already listed the candidate (stale read) and now sweeps at the same instant.
    const res = await sweepAt(env, T0)
    expect(res.recorded).toBe(0)
    expect((sqlite.prepare(`SELECT rewake_count FROM gate_stall_rewakes WHERE task_id='t1'`).get() as { rewake_count: number }).rewake_count).toBe(1)
    harness.close()
  })

  it('skips a task with a live verdict, but not one whose verdict was reversed', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'live')
    seedReviewTask(sqlite, 'reversed')
    sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v1','live','approved','a','2026-10-06T11:00:00.000Z')`).run()
    sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at, reversed_at) VALUES ('v2','reversed','approved','a','2026-10-06T11:00:00.000Z','2026-10-06T11:30:00.000Z')`).run()
    await sweepAt(env, T0)
    expect(wakeCount(sqlite, 'live')).toBe(0)
    expect(wakeCount(sqlite, 'reversed')).toBe(0)
    harness.close()
  })

  it('skips a task without a gate_owner and a task not in review', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'nogate', { gateOwner: null, status: 'in_progress' })
    sqlite.prepare(`UPDATE tasks SET status = 'review' WHERE id = 'nogate'`).run().valueOf()
    seedReviewTask(sqlite, 'wrongstatus', { status: 'in_progress' })
    const res = await sweepAt(env, T0)
    expect(res.scanned).toBe(0)
    expect(wakeCount(sqlite, 'nogate') + wakeCount(sqlite, 'wrongstatus')).toBe(0)
    harness.close()
  })

  it('respects the cap, then only surfaces the stall in Needs You', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    for (let i = 0; i < 6; i += 1) await sweepAt(env, minutes(i * 31))
    expect(wakeCount(sqlite, 't1')).toBe(0)
    expect((sqlite.prepare(`SELECT rewake_count FROM gate_stall_rewakes WHERE task_id='t1'`).get() as { rewake_count: number }).rewake_count).toBe(3)
    harness.close()
  })

  it('honours GATE_STALL_THRESHOLD_MINUTES and GATE_STALL_MAX_REWAKES', async () => {
    const { env, sqlite, harness } = setup({ GATE_STALL_THRESHOLD_MINUTES: '200', GATE_STALL_MAX_REWAKES: '1' })
    seedReviewTask(sqlite, 't1') // 120 min old < 200
    expect((await sweepAt(env, T0)).scanned).toBe(0)
    await sweepAt(env, minutes(90))
    await sweepAt(env, minutes(400))
    expect(wakeCount(sqlite, 't1')).toBe(0)
    harness.close()
  })

  it('leaves task status and verdicts untouched', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const before = taskRow(sqlite, 't1')
    await sweepAt(env, T0)
    await sweepAt(env, minutes(31))
    expect(taskRow(sqlite, 't1')).toEqual(before)
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM task_verdicts`).get() as { n: number }).n).toBe(0)
    harness.close()
  })

  it('sends no stall mail to any gate lane holder', async () => {
    const { env, sqlite, harness } = setup()
    sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('bystander', '${SQUAD_ID}', 'bystander', 'bystander', 'active')`)
    seedReviewTask(sqlite, 't1')
    await sweepAt(env, T0)
    const to = sqlite.prepare(`SELECT DISTINCT to_agent FROM agent_messages WHERE request_id LIKE 'review-wake:t1:%'`).all() as { to_agent: string }[]
    expect(to).toEqual([])
    harness.close()
  })

  it('surfaces the stall in the Needs You stuck view reason', async () => {
    const { env, sqlite, harness } = setup()
    sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('p1', 'p1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', '${SQUAD_ID}', 'write');`)
    seedReviewTask(sqlite, 't1')
    sqlite.exec(`UPDATE tasks SET project_id = 'p1' WHERE id = 't1'`)
    const auth: AuthContext = { userId: 'o', memberId: 'o', email: null, role: 'owner', tenant: TENANT, channel: 'workspace', boundAgentId: null }
    const reasons = async () =>
      (await listNeedsYou(env, routinePrincipal(auth), { view: 'stuck', auth }, T0.toISOString())).items.map((i) => i.reason)
    expect(await reasons()).toEqual(['Approval required by gate:athena'])
    await sweepAt(env, T0)
    expect(await reasons()).toEqual(['Approval required by gate:athena'])
    harness.close()
  })

  it('never counts or shows a re-wake that reached no holder (no_live_holder lane)', async () => {
    const { env, sqlite, harness } = setup()
    sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('p1', 'p1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', '${SQUAD_ID}', 'write');`)
    seedReviewTask(sqlite, 't1', { gateOwner: 'gate:nobody' })
    sqlite.exec(`UPDATE tasks SET project_id = 'p1' WHERE id = 't1'`)
    let rewoken = 0
    let undelivered = 0
    for (let i = 0; i < 4; i += 1) {
      const r = await sweepAt(env, minutes(i * 31))
      rewoken += r.recorded
      undelivered += r.undelivered
    }
    expect(rewoken).toBe(3)
    expect(undelivered).toBe(3)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    const row = sqlite.prepare(`SELECT rewake_count, delivered_count, last_outcome FROM gate_stall_rewakes WHERE task_id='t1'`).get() as Record<string, unknown>
    expect(row).toMatchObject({ rewake_count: 3, delivered_count: 0, last_outcome: 'no_live_holder' })
    const auth: AuthContext = { userId: 'o', memberId: 'o', email: null, role: 'owner', tenant: TENANT, channel: 'workspace', boundAgentId: null }
    const reasons = (await listNeedsYou(env, routinePrincipal(auth), { view: 'stuck', auth }, minutes(200).toISOString())).items.map((i) => i.reason)
    expect(reasons.every((r) => !r.includes('re-wake'))).toBe(true)
    harness.close()
  })

  it('a task that re-enters review gets a fresh budget, even past the cap with an old verdict', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    for (let i = 0; i < 4; i += 1) await sweepAt(env, minutes(i * 31))
    expect(wakeCount(sqlite, 't1')).toBe(0)
    // Old round's verdict (unreversed, decided before re-entry) must not suppress the new round.
    sqlite.exec(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
                 VALUES ('v-old', 't1', 'rejected', 'x', '2026-10-06T09:00:00.000Z')`)
    const reentered = minutes(150).toISOString()
    sqlite.exec(`UPDATE tasks SET updated_at = '${reentered}' WHERE id = 't1'`)
    await sweepAt(env, minutes(190))
    expect(wakeCount(sqlite, 't1')).toBe(0)
    const row = sqlite.prepare(`SELECT rewake_count, delivered_count, review_since FROM gate_stall_rewakes WHERE task_id='t1'`).get() as Record<string, unknown>
    expect(row).toMatchObject({ rewake_count: 1, delivered_count: 0, review_since: reentered })
    harness.close()
  })
})

describe('gate-stall watchdog: archive is an action boundary (mupot#1780)', () => {
  const archive = (sqlite: Sqlite, id: string): void => {
    sqlite.prepare(`INSERT OR IGNORE INTO members (id, display_name, status, tenant) VALUES ('m1', 'M', 'active', ?)`).run(TENANT)
    sqlite
      .prepare(
        `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
         VALUES (?, '2026-10-06T11:00:00.000Z', 'test', 'm1', 'review')`,
      )
      .run(id)
  }
  const effectRows = (sqlite: Sqlite): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_messages`).get() as { n: number }).n

  it('sweep over an archived stalled review task produces no wake, inbox row, claim or message', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'arch')
    archive(sqlite, 'arch')
    const emit = vi.fn()
    ;(env as unknown as Record<string, unknown>).BUS_EVENTS = { send: emit }
    const res = await sweepAt(env, T0)
    expect(res).toMatchObject({ scanned: 0, rewoken: 0, undelivered: 0, errors: 0 })
    expect(effectRows(sqlite)).toBe(0)
    expect(wakeCount(sqlite, 'arch')).toBe(0)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gate_stall_rewakes`).get()).toEqual({ n: 0 })
    harness.close()
  })

  it('SELECT guard stops archived accounting while an un-archived sibling is recorded', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'arch')
    seedReviewTask(sqlite, 'live')
    archive(sqlite, 'arch')
    const res = await sweepAt(env, T0)
    expect(res).toMatchObject({ scanned: 1, recorded: 1, rewoken: 0 })
    expect(wakeCount(sqlite, 'arch')).toBe(0)
    expect(wakeCount(sqlite, 'live')).toBe(0)
    harness.close()
  })

  it('wakeGateOwnerOnReview itself refuses an archived task: no rows, no notice, no bus event', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'arch')
    sqlite.exec("UPDATE tasks SET gate_wake_notice=NULL WHERE id='arch'")
    archive(sqlite, 'arch')
    const task = sqlite.prepare(`SELECT * FROM tasks WHERE id = 'arch'`).get() as never
    const { wakeGateOwnerOnReview } = await import('../src/mcp')
    const prepared: string[] = []
    const realPrepare = harness.db.prepare.bind(harness.db)
    harness.db.prepare = ((sql: string) => {
      prepared.push(sql)
      return realPrepare(sql)
    }) as typeof harness.db.prepare
    const out = await wakeGateOwnerOnReview(env, task, { kind: 'agent', id: 'x' }, 'x')
    expect(out.status).toBe('task_archived')
    expect(effectRows(sqlite)).toBe(0)
    expect(prepared.some((s) => /agent_messages|INSERT/i.test(s))).toBe(false)
    expect(sqlite.prepare(`SELECT gate_wake_notice FROM tasks WHERE id = 'arch'`).get()).toEqual({ gate_wake_notice: null })
    harness.close()
  })

  it('wakeGateOwnerOnReview still delivers for a live task (guard is not over-broad)', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'live')
    const task = sqlite.prepare(`SELECT * FROM tasks WHERE id = 'live'`).get() as never
    const { wakeGateOwnerOnReview } = await import('../src/mcp')
    const out = await wakeGateOwnerOnReview(env, task, { kind: 'agent', id: 'x' }, 'x')
    expect(out.status).not.toBe('task_archived')
    expect(effectRows(sqlite)).toBe(1)
    harness.close()
  })

  it('a task archived between the sweep SELECT and the wake yields no effect, burns no claim row and is not counted rewoken', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'race')
    const realPrepare = harness.db.prepare.bind(harness.db)
    let armed = true
    harness.db.prepare = ((sql: string) => {
      if (armed && sql.includes('INSERT INTO gate_stall_rewakes')) {
        armed = false
        archive(sqlite, 'race')
      }
      return realPrepare(sql)
    }) as typeof harness.db.prepare
    const res = await sweepAt(env, T0)
    expect(res.rewoken).toBe(0)
    expect(res.undelivered).toBe(0)
    expect(res.skipped_claimed).toBe(1)
    expect(effectRows(sqlite)).toBe(0)
    // #1783 P3: the guard is IN the claim write, so the race burns no gate_stall_rewakes row either.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gate_stall_rewakes`).get()).toEqual({ n: 0 })
    harness.close()
  })

  // ── #1783 P2-2: "no bus event" is asserted on the REAL emit seam (createBus -> env.BUS.send) ──
  it('wakeGateOwnerOnReview emits NO bus event for an archived task, and does emit for a live one (spy is live)', async () => {
    const { env, sqlite, harness } = setup()
    const send = vi.fn(async () => undefined)
    ;(env as unknown as Record<string, unknown>).BUS = { send }
    seedReviewTask(sqlite, 'arch')
    seedReviewTask(sqlite, 'live')
    archive(sqlite, 'arch')
    const { wakeGateOwnerOnReview } = await import('../src/mcp')
    const archTask = sqlite.prepare(`SELECT * FROM tasks WHERE id = 'arch'`).get() as never
    const liveTask = sqlite.prepare(`SELECT * FROM tasks WHERE id = 'live'`).get() as never
    const outArch = await wakeGateOwnerOnReview(env, archTask, { kind: 'agent', id: 'x' }, 'x')
    expect(outArch.status).toBe('task_archived')
    expect(send).not.toHaveBeenCalled()
    await wakeGateOwnerOnReview(env, liveTask, { kind: 'agent', id: 'x' }, 'x')
    expect(send).toHaveBeenCalled()
    harness.close()
  })
})

describe('gate-stall watchdog: member-held gate decision card (mupot#2015)', () => {
  function memberSetup() {
    const base = setup()
    const { sqlite } = base
    sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-h', 'h@t.com', 'H', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES ('kay', '${SQUAD_ID}', 'kay', 'kay', 'active', 'mem-h');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'kay', 'mem-h', datetime('now'));
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, tenant) VALUES ('tok-kay', 'mem-h', 'h', 'l', 'workspace', 'kay', '${TENANT}');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('g-m', 'gate:hm', 'member', 'mem-h', 'owner-1', '2026-08-15T00:00:00.000Z');
    `)
    const env = { ...base.env, HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS: 'tok-kay' } as Env
    return { ...base, env }
  }

  it('does not mistake a previous member holder card for delivery to the current member',async()=>{
    const {env,sqlite,harness}=memberSetup();seedReviewTask(sqlite,'member-changed',{gateOwner:'gate:hm'})
    sqlite.prepare("UPDATE tasks SET gate_wake_notice=? WHERE id='member-changed'").run("Decision card queued to stale's inbox (not yet acknowledged): gate:hm is held by member mem-h.previous. A verdict still needs the member's own decision.")
    expect(await sweepAt(env,T0)).toMatchObject({rewoken:1,undelivered:0})
    expect(sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:1})
    expect(await sweepAt(env,minutes(31))).toMatchObject({rewoken:0,undelivered:0})
    harness.close()
  })

  it('recovers a failed member decision-card delivery and then stays quiet',async()=>{
    const {env,sqlite,harness}=memberSetup();seedReviewTask(sqlite,'member-recovery',{gateOwner:'gate:hm'})
    sqlite.exec("CREATE TRIGGER fail_first_card BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(ABORT,'card unavailable'); END;")
    const {wakeGateOwnerOnReview}=await import('../src/mcp')
    const task=sqlite.prepare("SELECT * FROM tasks WHERE id='member-recovery'").get() as never
    expect((await wakeGateOwnerOnReview(env,task,{kind:'agent',id:'review-entry'},'review-entry')).status).toBe('owner_agent_delivery_failed')
    sqlite.exec('DROP TRIGGER fail_first_card')
    expect(await sweepAt(env,T0)).toMatchObject({rewoken:1,undelivered:0})
    expect(sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:1})
    expect(await sweepAt(env,minutes(31))).toMatchObject({rewoken:0,undelivered:0})
    expect(sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:1})
    harness.close()
  })

  it('the first member-held gate wake delivers a decision card and later stalls stay quiet', async () => {
    const {env,sqlite,harness}=memberSetup()
    seedReviewTask(sqlite,'tm1',{gateOwner:'gate:hm'})
    const {wakeGateOwnerOnReview}=await import('../src/mcp')
    const task=sqlite.prepare("SELECT * FROM tasks WHERE id='tm1'").get() as never
    const initial=await wakeGateOwnerOnReview(env,task,{kind:'agent',id:'review-entry'},'review-entry')
    expect(initial.status).toBe('queued_to_owner_agent')
    const count=()=>sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()
    expect(count()).toEqual({n:1})
    expect(await sweepAt(env,T0)).toMatchObject({recorded:1,rewoken:0})
    expect(await sweepAt(env,minutes(31))).toMatchObject({recorded:1,rewoken:0,undelivered:0})
    expect(count()).toEqual({n:1})
    expect(sqlite.prepare("SELECT delivered_count,last_outcome FROM gate_stall_rewakes WHERE task_id='tm1'").get()).toEqual({delivered_count:0,last_outcome:'logged_no_mail'})
    harness.close()
  })
})

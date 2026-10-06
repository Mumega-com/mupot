import { describe, expect, it } from 'vitest'
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
  it('re-wakes a stalled review task once and records the claim', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const res = await sweepStalledGateReviews(env, T0)
    expect(res).toMatchObject({ scanned: 1, rewoken: 1, errors: 0 })
    expect(wakeCount(sqlite, 't1')).toBe(1)
    const claim = sqlite.prepare(`SELECT * FROM gate_stall_rewakes WHERE task_id = 't1'`).get() as Record<string, unknown>
    expect(claim).toMatchObject({ rewake_count: 1, review_since: REVIEW_ENTERED })
    expect(claim.last_outcome).toBeTruthy()
    harness.close()
  })

  it('does not wake a task younger than the threshold', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1', { updatedAt: new Date(T0.getTime() - 5 * 60_000).toISOString() })
    expect((await sweepStalledGateReviews(env, T0)).scanned).toBe(0)
    expect(wakeCount(sqlite, 't1')).toBe(0)
    harness.close()
  })

  it('does not re-send inside the window, and re-sends once the window elapses', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    await sweepStalledGateReviews(env, T0)
    const second = await sweepStalledGateReviews(env, minutes(10))
    expect(second.rewoken).toBe(0)
    expect(wakeCount(sqlite, 't1')).toBe(1)
    // Window (30 min default) elapsed.
    const third = await sweepStalledGateReviews(env, minutes(31))
    expect(third.rewoken).toBe(1)
    expect(wakeCount(sqlite, 't1')).toBe(2)
    harness.close()
  })

  it('two concurrent sweeps send exactly once', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const [a, b] = await Promise.all([sweepStalledGateReviews(env, T0), sweepStalledGateReviews(env, T0)])
    expect(a.rewoken + b.rewoken).toBe(1)
    expect(wakeCount(sqlite, 't1')).toBe(1)
    harness.close()
  })

  it('claim itself is atomic: a second claim in the same window changes no row', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    await sweepStalledGateReviews(env, T0)
    // Simulate a racer that already listed the candidate (stale read) and now sweeps at the same instant.
    const res = await sweepStalledGateReviews(env, T0)
    expect(res.rewoken).toBe(0)
    expect((sqlite.prepare(`SELECT rewake_count FROM gate_stall_rewakes WHERE task_id='t1'`).get() as { rewake_count: number }).rewake_count).toBe(1)
    harness.close()
  })

  it('skips a task with a live verdict, but not one whose verdict was reversed', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'live')
    seedReviewTask(sqlite, 'reversed')
    sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v1','live','approved','a','2026-10-06T11:00:00.000Z')`).run()
    sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at, reversed_at) VALUES ('v2','reversed','approved','a','2026-10-06T11:00:00.000Z','2026-10-06T11:30:00.000Z')`).run()
    await sweepStalledGateReviews(env, T0)
    expect(wakeCount(sqlite, 'live')).toBe(0)
    expect(wakeCount(sqlite, 'reversed')).toBe(1)
    harness.close()
  })

  it('skips a task without a gate_owner and a task not in review', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 'nogate', { gateOwner: null, status: 'in_progress' })
    sqlite.prepare(`UPDATE tasks SET status = 'review' WHERE id = 'nogate'`).run().valueOf()
    seedReviewTask(sqlite, 'wrongstatus', { status: 'in_progress' })
    const res = await sweepStalledGateReviews(env, T0)
    expect(res.scanned).toBe(0)
    expect(wakeCount(sqlite, 'nogate') + wakeCount(sqlite, 'wrongstatus')).toBe(0)
    harness.close()
  })

  it('respects the cap, then only surfaces the stall in Needs You', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    for (let i = 0; i < 6; i += 1) await sweepStalledGateReviews(env, minutes(i * 31))
    expect(wakeCount(sqlite, 't1')).toBe(3)
    expect((sqlite.prepare(`SELECT rewake_count FROM gate_stall_rewakes WHERE task_id='t1'`).get() as { rewake_count: number }).rewake_count).toBe(3)
    harness.close()
  })

  it('honours GATE_STALL_THRESHOLD_MINUTES and GATE_STALL_MAX_REWAKES', async () => {
    const { env, sqlite, harness } = setup({ GATE_STALL_THRESHOLD_MINUTES: '200', GATE_STALL_MAX_REWAKES: '1' })
    seedReviewTask(sqlite, 't1') // 120 min old < 200
    expect((await sweepStalledGateReviews(env, T0)).scanned).toBe(0)
    await sweepStalledGateReviews(env, minutes(90))
    await sweepStalledGateReviews(env, minutes(400))
    expect(wakeCount(sqlite, 't1')).toBe(1)
    harness.close()
  })

  it('leaves task status and verdicts untouched', async () => {
    const { env, sqlite, harness } = setup()
    seedReviewTask(sqlite, 't1')
    const before = taskRow(sqlite, 't1')
    await sweepStalledGateReviews(env, T0)
    await sweepStalledGateReviews(env, minutes(31))
    expect(taskRow(sqlite, 't1')).toEqual(before)
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM task_verdicts`).get() as { n: number }).n).toBe(0)
    harness.close()
  })

  it('wakes only the resolved gate_owner lane holder', async () => {
    const { env, sqlite, harness } = setup()
    sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('bystander', '${SQUAD_ID}', 'bystander', 'bystander', 'active')`)
    seedReviewTask(sqlite, 't1')
    await sweepStalledGateReviews(env, T0)
    const to = sqlite.prepare(`SELECT DISTINCT to_agent FROM agent_messages WHERE request_id LIKE 'review-wake:t1:%'`).all() as { to_agent: string }[]
    expect(to.map((r) => r.to_agent)).toEqual([AGENT])
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
    await sweepStalledGateReviews(env, T0)
    expect(await reasons()).toEqual(['Approval required by gate:athena (no verdict after 1 gate re-wake)'])
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
      const r = await sweepStalledGateReviews(env, minutes(i * 31))
      rewoken += r.rewoken
      undelivered += r.undelivered
    }
    expect(rewoken).toBe(0)
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
    for (let i = 0; i < 4; i += 1) await sweepStalledGateReviews(env, minutes(i * 31))
    expect(wakeCount(sqlite, 't1')).toBe(3)
    // Old round's verdict (unreversed, decided before re-entry) must not suppress the new round.
    sqlite.exec(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
                 VALUES ('v-old', 't1', 'rejected', 'x', '2026-10-06T09:00:00.000Z')`)
    const reentered = minutes(150).toISOString()
    sqlite.exec(`UPDATE tasks SET updated_at = '${reentered}' WHERE id = 't1'`)
    await sweepStalledGateReviews(env, minutes(190))
    expect(wakeCount(sqlite, 't1')).toBe(4)
    const row = sqlite.prepare(`SELECT rewake_count, delivered_count, review_since FROM gate_stall_rewakes WHERE task_id='t1'`).get() as Record<string, unknown>
    expect(row).toMatchObject({ rewake_count: 1, delivered_count: 1, review_since: reentered })
    harness.close()
  })
})

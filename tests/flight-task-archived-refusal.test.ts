// tests/flight-task-archived-refusal.test.ts — mupot#1496 Round 2/3 (Athena
// P0-1 on PR #1561 round 2): src/flight/service.ts's
// validateFlightTaskProjectConsistency and src/flight/meta.ts's
// validateFlightMetaReferences both queried `tasks` without
// TASK_NOT_ARCHIVED_SQL, so flight_dispatch on an archived task succeeded.
// Real migration chain, direct unit calls against the exported validators
// (both are pure functions of env + already-resolved args — no auth/tool
// wrapper to go through here, unlike the MCP-tool-level tests elsewhere).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateFlightTaskProjectConsistency, FlightProjectError, createFlight } from '../src/flight/service'
import { validateFlightMetaReferences } from '../src/flight/meta'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'

describe('flight task validators refuse an archived task (mupot#1496)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env

    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-1', '${TENANT}', 'm1@example.com', 'M1', 'active');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq1-sqd', 'Squad One');
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-one', 'Project One', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-1', 'admin');
      INSERT INTO tasks (id, squad_id, title, status, done_when, project_id) VALUES
        ('task-live', 'squad-1', 'Live Task', 'open', 'n/a', 'proj-1'),
        ('task-dead', 'squad-1', 'Archived Task', 'done', 'n/a', 'proj-1');
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
        VALUES ('task-dead', datetime('now'), 'test', 'mem-1', 'done', datetime('now'));
    `)
  })
  afterEach(() => harness.close())

  it('validateFlightTaskProjectConsistency (src/flight/service.ts) throws task_archived, not the generic flight_task_not_found', async () => {
    await expect(
      validateFlightTaskProjectConsistency(env, 'proj-1', {
        schema: 'mupot.flight.meta/v1' as const,
        goal_id: 'goal-1',
        objective_id: 'obj-1',
        squad_ids: ['squad-1'],
        task_ids: ['task-live', 'task-dead'],
      } as never),
    ).rejects.toMatchObject(new FlightProjectError('task_archived'))
  })

  it('validateFlightTaskProjectConsistency passes when every task_id is live', async () => {
    await expect(
      validateFlightTaskProjectConsistency(env, 'proj-1', {
        schema: 'mupot.flight.meta/v1' as const,
        goal_id: 'goal-1',
        objective_id: 'obj-1',
        squad_ids: ['squad-1'],
        task_ids: ['task-live'],
      } as never),
    ).resolves.toBeUndefined()
  })

  it('validateFlightMetaReferences (src/flight/meta.ts) returns {ok:false, error:"task_archived"}, not flight_task_not_found', async () => {
    const result = await validateFlightMetaReferences(
      env,
      {
        schema: 'mupot.flight.meta/v1' as const,
        goal_id: 'goal-1',
        objective_id: 'obj-1',
        squad_ids: ['squad-1'],
        task_ids: ['task-dead'],
      } as never,
      'proj-1',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('task_archived')
    expect(result.ref).toBe('task-dead')
  })

  it('validateFlightMetaReferences resolves ok for a live task', async () => {
    const result = await validateFlightMetaReferences(
      env,
      {
        schema: 'mupot.flight.meta/v1' as const,
        goal_id: 'goal-1',
        objective_id: 'obj-1',
        squad_ids: ['squad-1'],
        task_ids: ['task-live'],
      } as never,
      'proj-1',
    )
    expect(result.ok).toBe(true)
  })

  // ── mupot#1783 (carried P1): createFlight's INSERT carries the archive guard ITSELF ──
  describe('createFlight atomic archive guard', () => {
    const meta = (ids: string[]) => ({ schema: 'mupot.flight.meta/v1' as const, goal_id: 'g', objective_id: 'o', squad_ids: ['squad-1'], task_ids: ids }) as never
    const flightCount = () => harness.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get()
    const variants: Array<[string, Parameters<typeof createFlight>[2]]> = [
      ['plain', {}],
      ['client_request_id', {}],
      ['bookkeeping', { bookkeeping: true }],
    ]

    it.each(variants)('%s branch: an archived task id in meta (no project => no validator runs) is refused, nothing written', async (name, options) => {
      const f = name === 'client_request_id'
        ? { agent: 'a', goal: 'g', meta: meta(['task-dead']), client_request_id: 'req-1' }
        : { agent: 'a', goal: 'g', meta: meta(['task-dead']) }
      await expect(createFlight(env, f, options)).rejects.toMatchObject(new FlightProjectError('task_archived'))
      expect(flightCount()).toEqual({ n: 0 })
    })

    it('redispatchReceipt branch: refused, no flight and no receipt written', async () => {
      await expect(createFlight(env, { agent: 'a', goal: 'g', meta: meta(['task-dead']) }, {
        redispatchReceipt: { actor: { kind: 'member', id: 'mem-1' }, reason: 'r', landedFlightIds: [], taskIds: ['task-dead'] },
      })).rejects.toMatchObject(new FlightProjectError('task_archived'))
      expect(flightCount()).toEqual({ n: 0 })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM flight_redispatch_receipts').get()).toEqual({ n: 0 })
    })

    it('a live task id still creates the flight (guard is not over-broad)', async () => {
      const id = await createFlight(env, { agent: 'a', goal: 'g', meta: meta(['task-live']) })
      expect(harness.sqlite.prepare('SELECT id FROM flights WHERE id = ?').get(id)).toEqual({ id })
    })

    it('RACE: archived between the validators and the INSERT -> refused task_archived, nothing written (project path)', async () => {
      const realPrepare = harness.db.prepare.bind(harness.db)
      let armed = true
      harness.db.prepare = ((sql: string) => {
        if (armed && sql.includes('INSERT INTO flights')) {
          armed = false
          harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
            VALUES ('task-live', datetime('now'), 'race', 'mem-1', 'open', datetime('now'))`)
        }
        return realPrepare(sql)
      }) as typeof harness.db.prepare
      await expect(createFlight(env, { agent: 'a', goal: 'g', project_id: 'proj-1', meta: meta(['task-live']) }))
        .rejects.toMatchObject(new FlightProjectError('task_archived'))
      expect(flightCount()).toEqual({ n: 0 })
    })
  })
})

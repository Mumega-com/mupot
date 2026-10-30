// Official local workerd/Miniflare D1; no remote database or deployed-runtime claim.
import { env, applyD1Migrations as applyAllMigrations } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'
import { routineEffectDeadlineSql, routineReviewDeadlineSql } from '../../src/routines/review-window'
import type { Env } from '../../src/types'

const bindings = env as unknown as { MUPOT_DB: Env['DB']; TEST_MIGRATIONS: Parameters<typeof applyAllMigrations>[1] }
beforeAll(async () => { await applyAllMigrations(bindings.MUPOT_DB, bindings.TEST_MIGRATIONS) })

it('the actual D1 engine evaluates the correlated effect-clock CTE and fences a late start', async () => {
  const db = bindings.MUPOT_DB, id = `review-${crypto.randomUUID()}`
  const requested = '2026-10-30T00:00:00.000Z', decided = '2026-10-30T23:30:00.000Z'
  await db.batch([
    db.prepare('INSERT INTO departments(id,slug,name) VALUES(?,?,?)').bind(id,id,id),
    db.prepare('INSERT INTO squads(id,department_id,slug,name) VALUES(?,?,?,?)').bind(id,id,id,id),
    db.prepare('INSERT INTO projects(id,slug,name,status) VALUES(?,?,?,?)').bind(id,id,id,'active'),
    db.prepare("INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES(?,?,'write')").bind(id,id),
    db.prepare(`INSERT INTO routines(id,tenant,project_id,name,objective,status,trigger_kind,timezone,
      overlap_policy,execution_mode,responsible_squad_id,budget_micro_usd,max_attempts,retry_backoff_seconds,
      revision,enabled_by,enabled_at,created_by) VALUES(?,?,?,?,'Review','enabled','manual','UTC','skip','propose',?,100,3,300,1,'owner',?,'owner')`)
      .bind(id,id,id,id,id,requested),
    db.prepare("INSERT INTO tasks(id,squad_id,project_id,title,status,gate_owner) VALUES(?,?,?,'Control','review','gate:routines')").bind(id,id,id),
    db.prepare(`INSERT INTO flights(id,tenant,agent,project_id,goal,status,meta) VALUES(?,?,'agent',?,'Review','running','{}')`).bind(id,id,id),
    db.prepare(`INSERT INTO routine_runs(id,tenant,project_id,routine_id,routine_revision,policy_json,occurrence_key,
      trigger_kind,status,waiting_reason,attempt,task_id,flight_id,proposal_json)
      VALUES(?,?,?,?,1,'{}','once','manual','waiting','review',1,?,?,?)`)
      .bind(id,id,id,id,id,id,JSON.stringify({ action: { key: 'a' } })),
    db.prepare(`INSERT INTO routine_run_actions(id,tenant,project_id,run_id,action_key,kind,input_json,
      validation_status,gate_status,status,source_type,source_id,created_at)
      VALUES(?,?,?,?,'a','no_action','{}','accepted','approved','pending','task',?,?)`)
      .bind(id,id,id,id,id,'2026-10-29T23:59:59.000Z'),
    db.prepare(`INSERT INTO routine_run_events(id,tenant,project_id,run_id,kind,actor_type,actor_id,occurred_at,metadata_json,correlation_id)
      VALUES(?,?,?,?,'approval_requested','system','mupot-routines',?,'{"action_key":"a"}',?)`).bind(id,id,id,id,requested,id),
  ])
  const read = () => db.prepare(`SELECT ${routineReviewDeadlineSql('rr')} AS review,
    ${routineEffectDeadlineSql('rr')} AS effect FROM routine_runs rr WHERE id=?`).bind(id).first()
  expect(await read()).toEqual({ review: '2026-10-31T00:00:00.000Z', effect: '2026-10-31T00:00:00.000Z' })
  await db.batch([
    db.prepare("UPDATE tasks SET status='approved' WHERE id=?").bind(id),
    db.prepare(`INSERT INTO task_verdicts(id,task_id,proposal_id,verdict,decided_by,decided_at)
      VALUES(?,?,?,'approved','owner',?)`).bind(id,id,id,decided),
  ])
  expect(await read()).toEqual({ review: null, effect: '2026-10-31T00:30:00.000Z' })
  const late = await db.prepare(`UPDATE routine_run_actions SET status='running' WHERE id=?1
    AND EXISTS(SELECT 1 FROM routine_runs WHERE id=?1 AND ${routineEffectDeadlineSql('routine_runs')} > ?2)`)
    .bind(id,'2026-10-31T00:30:00.000Z').run()
  expect(late.meta.changes).toBe(0)
  const timely = await db.prepare(`UPDATE routine_run_actions SET status='running' WHERE id=?1
    AND EXISTS(SELECT 1 FROM routine_runs WHERE id=?1 AND ${routineEffectDeadlineSql('routine_runs')} > ?2)`)
    .bind(id,'2026-10-31T00:10:00.000Z').run()
  expect(timely.meta.changes).toBe(1)
})

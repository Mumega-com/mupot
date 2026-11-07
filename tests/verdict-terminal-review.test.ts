import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env, Task } from '../src/types'
import { buildVerdictStatements, writeVerdict } from '../src/tasks/service'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('executor-free review completion', () => {
  let h: SqliteD1Harness
  let env: Env
  const row = () => h.sqlite.prepare("SELECT * FROM tasks WHERE id='task'").get() as Task
  const approve = () => writeVerdict(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer' })
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    env = { DB: h.db, TENANT_SLUG: 'test' } as Env
    h.sqlite.exec(`
      INSERT INTO departments(id,slug,name) VALUES ('dept','dept','Dept');
      INSERT INTO squads(id,department_id,slug,name) VALUES ('squad','dept','squad','Squad');
      INSERT INTO members(id,tenant,email,display_name,status) VALUES ('reviewer','test','r@example.com','Reviewer','active');
      INSERT INTO members(id,tenant,email,display_name,status) VALUES ('owner','test','o@example.com','Owner','active');
      INSERT INTO agents(id,squad_id,slug,name,status) VALUES ('agent','squad','agent','Agent','active');
      INSERT INTO tasks(id,squad_id,title,body,done_when,status,result) VALUES ('task','squad','Review','Body','Reviewed result','review','Result');
    `)
  })
  afterEach(() => h.close())

  it('finishes an executor-free approval with its approved verdict in the same batch', async () => {
    const result = await approve()
    expect(row().status).toBe('done')
    expect(result.task.status).toBe('done')
    expect(result.task.completed_at).toBe(row().completed_at)
    expect(row().completed_at).toBe(result.verdict.decided_at)
    expect(h.sqlite.prepare("SELECT verdict FROM task_verdicts WHERE task_id='task'").get()).toEqual({ verdict: 'approved' })
  })

  it('keeps rejection non-terminal', async () => {
    const result = await writeVerdict(env, { task: row(), verdict: 'rejected', note: 'Rework', decidedBy: 'reviewer' })
    expect(result.task.status).toBe('rejected')
    expect(row().status).toBe('rejected')
    expect(row().completed_at).toBeNull()
  })

  it.each([
    ['agent assignee', "assignee_agent_id='agent'"],
    ['member assignee', "assignee_member_id='owner'"],
    ['workflow', "workflow_instance_id='workflow'"],
    ['receipt pointer', "execution_receipt_id='receipt'"],
    ['claim pointer', 'execution_claim_expires_at=1'],
    ['gate effect', "gate_owner='gate:loops'"],
    ['remote pot', "source_pot='remote'"],
    ['external source', "external_source='external'"],
  ])('leaves %s approval for its existing executor or operator', async (_name, fields) => {
    h.sqlite.exec(`UPDATE tasks SET ${fields} WHERE id='task'`)
    expect((await approve()).task.status).toBe('approved')
    expect(row().status).toBe('approved')
  })

  it.each(['gate:office','gate:routines','gate:agent-self-completion','gate:project-completion','gate:addons:custom'])('keeps reserved %s at its dedicated executor boundary', async (gate) => {
    h.sqlite.prepare("UPDATE tasks SET gate_owner=? WHERE id='task'").run(gate)
    // Shared builder: dedicated gates impose their additional predicate at the caller.
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null, independenceWaiver: 'owner_override' })
    await env.DB.batch(build.statements)
    expect(row().status).toBe('approved')
  })

  it('finishes an ordinary gated review with no executor', async () => {
    h.sqlite.exec("UPDATE tasks SET gate_owner='gate:review' WHERE id='task'")
    expect((await approve()).task.status).toBe('done')
  })

  it('leaves outbound effects approved', async () => {
    h.sqlite.exec(`INSERT INTO outbound_acts(id,task_id,kind,payload,status,created_at) VALUES ('act','task','send_email','{}','pending',datetime('now'))`)
    expect((await approve()).task.status).toBe('approved')
  })

  it.each(['', '   ', '(backfill required)', '  (SET VIA TASK UPDATE)  ', '(agent-generated — set via task update)'])('preserves the completion predicate guard for %j', async (criterion) => {
    h.sqlite.prepare("UPDATE tasks SET done_when=? WHERE id='task'").run(criterion)
    expect((await approve()).task.status).toBe('approved')
  })

  it('does not complete against a changed completion predicate', async () => {
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null })
    h.sqlite.exec("UPDATE tasks SET done_when='New criterion' WHERE id='task'")
    await env.DB.batch(build.statements)
    expect(row().status).toBe('approved')
  })

  it('does not complete from a different or missing verdict anchor', async () => {
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null })
    h.sqlite.prepare("UPDATE tasks SET status='approved',updated_at=? WHERE id='task'").run(build.now)
    await env.DB.batch([build.statements[build.completionIndex]])
    expect(row().status).toBe('approved')
  })

  it.each(['dispatch', 'routine run', 'routine action', 'flight lane', 'flight assignment', 'flight metadata'])('preserves %s executor custody', async (kind) => {
    if (kind === 'dispatch') {
      h.sqlite.exec(`INSERT INTO task_dispatch_receipts(id,tenant,task_id,squad_id,agent_id,actor_kind,actor_id,created_at)
        VALUES ('dispatch','test','task','squad','agent','member','owner',datetime('now'))`)
    } else if (kind.startsWith('routine')) {
      h.sqlite.exec(`
        INSERT INTO projects(id,slug,name) VALUES ('project','project','Project');
        INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES ('project','squad','write');
        INSERT INTO routines(id,tenant,project_id,name,objective,trigger_kind,responsible_squad_id,created_by)
          VALUES ('routine','test','project','Routine','Objective','manual','squad','owner');
        INSERT INTO routine_runs(id,tenant,project_id,routine_id,routine_revision,policy_json,occurrence_key,trigger_kind,task_id)
          VALUES ('run','test','project','routine',1,'{}','one','manual',${kind === 'routine run' ? "'task'" : 'NULL'});
      `)
      if (kind === 'routine action') h.sqlite.exec(`INSERT INTO routine_run_actions(id,tenant,project_id,run_id,action_key,kind,input_json,source_type,source_id)
        VALUES ('action','test','project','run','one','ask_human','{}','task','task')`)
    } else {
      h.sqlite.exec(`INSERT INTO flights(id,tenant,agent,goal,meta) VALUES ('flight','test','agent','Goal','${kind === 'flight metadata' ? '{"task_ids":["task"]}' : '{}'}')`)
      if (kind !== 'flight metadata') {
        h.sqlite.exec(`INSERT INTO tasks(id,squad_id,title,body,done_when,status) VALUES ('other','squad','Other','Body','Other criterion','open');
          INSERT INTO flight_lanes(id,tenant,flight_id,lane_key,role,task_id,assignment_epoch,agent_id,done_when,created_at)
          VALUES ('lane','test','flight','worker','worker','${kind === 'flight lane' ? 'task' : 'other'}',1,'agent','Criterion',datetime('now'))`)
        if (kind === 'flight assignment') h.sqlite.exec(`INSERT INTO flight_task_assignments(id,tenant,flight_id,lane_id,task_id,assignment_epoch,agent_id,assigned_by_principal_kind,assigned_by_principal_id,assigned_at)
          VALUES ('assignment','test','flight','lane','task',1,'agent','member','owner',datetime('now'))`)
      }
    }
    expect((await approve()).task.status).toBe('approved')
  })

  it('rechecks executor assignment added between snapshot and commit', async () => {
    const snapshot = row()
    const build = buildVerdictStatements(env, { task: snapshot, verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null })
    h.sqlite.exec("UPDATE tasks SET assignee_agent_id='agent' WHERE id='task'")
    await env.DB.batch(build.statements)
    expect(row().status).toBe('approved')
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM task_verdicts WHERE task_id='task'").get()).toEqual({ n: 1 })
  })

  it('preserves the archive boundary inside completion', async () => {
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null })
    await env.DB.batch(build.statements.slice(0, build.completionIndex))
    h.sqlite.exec("INSERT INTO tasks_archive_state(task_id,archived_at,archived_reason,archived_by_member_id,prior_status) VALUES ('task',datetime('now'),'Archived','owner','approved')")
    await env.DB.batch([build.statements[build.completionIndex]])
    expect(row().status).toBe('approved')
  })

  it('preserves a chain receipt step and its existing reversible approved state', async () => {
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: 'member' })
    await env.DB.batch(build.statements)
    expect(row().status).toBe('approved')
  })

  it.each(['status', 'stamp'])('does not complete after the verdict %s proof changes', async (field) => {
    const build = buildVerdictStatements(env, { task: row(), verdict: 'approved', note: 'Reviewed', decidedBy: 'reviewer', submission: null, receiptActorKind: null })
    await env.DB.batch(build.statements.slice(0, build.completionIndex))
    if (field === 'status') h.sqlite.exec("UPDATE tasks SET status='blocked' WHERE id='task'")
    else h.sqlite.exec("UPDATE tasks SET updated_at='2099-01-01T00:00:00.000Z' WHERE id='task'")
    await env.DB.batch([build.statements[build.completionIndex]])
    expect(row().status).toBe(field === 'status' ? 'blocked' : 'approved')
  })

  it('rolls back the verdict if completion cannot commit', async () => {
    h.sqlite.exec("CREATE TRIGGER refuse_done BEFORE UPDATE OF status ON tasks WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'completion failed'); END")
    let error: unknown
    try { await approve() } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect(row().status).toBe('review')
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM task_verdicts").get()).toEqual({ n: 0 })
  })
})

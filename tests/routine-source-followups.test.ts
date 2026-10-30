import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJsonDigest } from '../src/lib/canonical-json'
import { loadProjectSituation } from '../src/projects/situation'
import { observeRoutineProposal, submitRoutineProposal, executeRoutineAction } from '../src/routines/actions'
import { invokeTool } from '../src/mcp'
import type { RoutineProposalAction, RoutineProposalReference } from '../src/routines/proposal'
import type { AuthContext, Project } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

const TARGET = 'b7eae252-5fa6-4d9e-9577-657fe2cf18ec'
const question: RoutineProposalAction = { key: 'question', kind: 'ask_human', input: { question: 'Review the declared evidence?', references: [] } }
const taskColumns = 'id, squad_id, project_id, title, body, done_when, status, priority, parent_task_id, assignee_agent_id, assignee_member_id, github_issue_url, result, completed_at, gate_owner, source_pot, external_source, created_at, updated_at'
const flightColumns = 'id, tenant, project_id, agent, goal, status, gate_verdict, gate_reason, budget_micro_usd, cost_micro_usd, next_run_at, created_at, started_at, ended_at, meta'

describe('routine source observation gate followups', () => {
  let f: ReadyRoutineFixture
  let hasOpenFixture = false
  const row = (sql: string, ...values: unknown[]) => f.harness.sqlite.prepare(sql).get(...values)!
  const count = (table: string) => row(`SELECT COUNT(*) AS n FROM ${table}`).n

  async function reset(mode: 'propose' | 'execute_internal' = 'execute_internal') {
    if (hasOpenFixture) f.harness.close()
    hasOpenFixture = false
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    f = await makeReadyRoutineFixture(mode, harness)
    hasOpenFixture = true
    f.harness.sqlite.exec(`
      INSERT INTO tasks (id,squad_id,project_id,title,body,done_when,status) VALUES
        ('decoy','squad-1','project-1','Stable context','Stable body','Verified','open'),
        ('${TARGET}','squad-1','project-1','Actual target','Original target','Verified','open');
      INSERT INTO members (id,display_name,tenant,status) VALUES ('owner-1','Owner','tenant-a','active');
    `)
    await refreshBoard()
  }
  async function refreshBoard() {
    const project = row('SELECT * FROM projects WHERE id=?', 'project-1') as unknown as Project
    const digest = await canonicalJsonDigest(await loadProjectSituation(f.env, project, ['squad-1'], {
      excludeTaskIds: ['control-task'], excludeFlightIds: ['control-flight'],
    }))
    f.harness.sqlite.prepare("UPDATE routine_runs SET situation_digest=? WHERE id='run-1'").run(digest)
  }
  beforeEach(() => reset())
  afterEach(() => { if (hasOpenFixture) f.harness.close(); hasOpenFixture = false })

  function base(action = question) {
    return { ...f.proposal(action), situation_digest: String(row("SELECT situation_digest FROM routine_runs WHERE id='run-1'").situation_digest) }
  }

  // An adversary can compute this public commitment offline. Do not call the
  // production source reader: these deliberately unscoped reads also produce
  // a valid witness for the hypothetical missing-scope-clause mutant.
  async function offline(action: RoutineProposalAction, references: RoutineProposalReference[]) {
    const run = row("SELECT * FROM routine_runs WHERE id='run-1'")
    const p = row(`SELECT id,slug,name,description,goal,status,parent_project_id,target_date,
      cycle_boundary_at,stalled,stall_threshold_days,completion_proposed_by,created_at,updated_at
      FROM projects WHERE id='project-1'`)
    const project = { ...p, repo_url: null, worker_name: null, live_url: null, assigned_squad_id: null,
      deploy_status: 'idle', created_by_member_id: null, created_via_elevation_grant: null }
    const sources = references.slice().sort((a,b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id)).map(ref => ({ ...ref, fact:
      ref.type === 'task' ? row(`SELECT ${taskColumns} FROM tasks WHERE id=?`, ref.id)
        : ref.type === 'flight' ? row(`SELECT ${flightColumns} FROM flights WHERE id=?`, ref.id)
          : f.harness.sqlite.prepare('SELECT ref_type,ref_id,relation,created_at FROM routine_run_refs WHERE ref_id=? ORDER BY ref_type,relation').all(ref.id),
    }))
    const digest = await canonicalJsonDigest({ version: 'routine.source-observation/v1', tenant: run.tenant,
      run_id: run.id, attempt: run.attempt, situation_digest: run.situation_digest,
      policy: JSON.parse(String(run.policy_json)), project, action, sources })
    return { digest, references }
  }

  async function observe(action = question, references: RoutineProposalReference[] = [{ type: 'task', id: 'decoy' }]) {
    const result = await observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action, references })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.error)
    return result.source_observation
  }
  async function approve() {
    const auth: AuthContext = { userId: 'owner-1', memberId: 'owner-1', email: null, role: 'owner', tenant: 'tenant-a',
      capabilities: [{ member_id: 'owner-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }] }
    await expect(invokeTool(auth, f.env, 'task_verdict', { task_id: 'control-task', verdict: 'approved', note: 'Reviewed current facts' }))
      .resolves.toMatchObject({ ok: true })
  }

  it('offline witness matches the real producer for ordinary extra task evidence', async () => {
    const references: RoutineProposalReference[] = [{ type: 'task', id: 'decoy' }]
    expect(await offline(question, references)).toEqual(await observe(question, references))
  })

  it.each(['submit', 'execution'])('create_task retains whole-board freshness for prose-only targets at %s', async phase => {
    await reset(phase === 'execution' ? 'propose' : 'execute_internal')
    const action: RoutineProposalAction = { key: 'create', kind: 'create_task', input: {
      title: `Close task ${TARGET}`, description: `Inspect and close task ${TARGET}; the decoy is context only.`,
    } }
    const proposal = { ...base(action), source_observation: await observe(action) }
    if (phase === 'execution') {
      await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'waiting' })
      await approve()
    }
    f.harness.sqlite.prepare("UPDATE tasks SET body='Target changed',status='blocked' WHERE id=?").run(TARGET)
    const result = phase === 'submit' ? await submitRoutineProposal(f.env, f.principal, proposal)
      : await executeRoutineAction(f.env, 'run-1', 'create')
    expect(result).toEqual({ ok: false, error: 'stale_situation' })
    expect(row("SELECT COUNT(*) AS n FROM tasks WHERE title=?", action.input.title)).toEqual({ n: 0 })
  })

  it('create_task keeps its declared-source check even when the board projection is unchanged', async () => {
    const action: RoutineProposalAction = { key: 'create', kind: 'create_task', input: { title: 'Next task', description: 'Read current evidence' } }
    const proposal = { ...base(action), source_observation: await observe(action) }
    f.harness.sqlite.exec("UPDATE tasks SET body='Changed context body' WHERE id='decoy'")
    // Open-task body is absent from the project projection; only the source check catches this.
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toEqual({ ok: false, error: 'stale_situation' })
    expect(count('routine_run_actions')).toBe(0)
  })

  it.each(['submit', 'execution'])('dispatch_flight retains whole-board freshness for prose-only targets at %s', async phase => {
    await reset(phase === 'execution' ? 'propose' : 'execute_internal')
    const action: RoutineProposalAction = { key: 'flight', kind: 'dispatch_flight', input: {
      goal: `Inspect and close task ${TARGET}`, task_ids: ['decoy'], artifact_refs: [], budget_micro_usd: 100,
    } }
    const proposal = { ...base(action), source_observation: await observe(action) }
    if (phase === 'execution') {
      await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'waiting' })
      await approve()
    }
    const flightsBefore = count('flights')
    f.harness.sqlite.prepare("UPDATE tasks SET body='Flight target changed',status='blocked' WHERE id=?").run(TARGET)
    const result = phase === 'submit' ? await submitRoutineProposal(f.env, f.principal, proposal)
      : await executeRoutineAction(f.env, 'run-1', 'flight')
    expect(result).toEqual({ ok: false, error: 'stale_situation' })
    expect(row('SELECT COUNT(*) AS n FROM flights WHERE goal=?', action.input.goal)).toEqual({ n: 0 })
    expect(count('flights')).toBe(flightsBefore)
  })

  it('dispatch_flight with fresh board and declared evidence creates one flight', async () => {
    const action: RoutineProposalAction = { key: 'fresh-flight', kind: 'dispatch_flight', input: {
      goal: 'Ship the declared work', task_ids: ['decoy'], artifact_refs: [], budget_micro_usd: 100,
    } }
    const proposal = { ...base(action), source_observation: await observe(action) }
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'succeeded' })
    expect(row('SELECT COUNT(*) AS n FROM flights WHERE goal=?', action.input.goal)).toEqual({ n: 1 })
  })

  function seedBoundary(boundary: string): RoutineProposalReference {
    f.harness.sqlite.exec(`INSERT INTO squads (id,department_id,slug,name) VALUES ('other','dept-1','other','Other');
      INSERT INTO projects (id,slug,name,status) VALUES ('other','other','Other','active');
      INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES
        ('project-1','other','write'),('other','squad-1','write');`)
    if (boundary.startsWith('task')) {
      f.harness.sqlite.prepare(`INSERT INTO tasks (id,squad_id,project_id,title,body,done_when,status)
        VALUES ('foreign',?,?,'Foreign task','Foreign confidential body','Verified','open')`)
        .run(boundary === 'task-squad' ? 'other' : 'squad-1', boundary === 'task-project' ? 'other' : 'project-1')
      return { type: 'task', id: 'foreign' }
    }
    if (boundary.startsWith('flight')) {
      const project = boundary === 'flight-project' ? 'other' : 'project-1'
      f.harness.sqlite.prepare(`INSERT INTO tasks (id,squad_id,project_id,title,done_when,status)
        VALUES ('flight-input','squad-1',?,'Input','Verified','open')`).run(project)
      const meta = JSON.parse(String(row("SELECT meta FROM flights WHERE id='control-flight'").meta))
      meta.task_ids = ['flight-input']
      f.harness.sqlite.prepare(`INSERT INTO flights (id,tenant,project_id,agent,goal,status,meta)
        VALUES ('foreign',?,?,'agent-2','Foreign confidential goal','running',?)`)
        .run(boundary === 'flight-tenant' ? 'other' : 'tenant-a', project, JSON.stringify(meta))
      return { type: 'flight', id: 'foreign' }
    }
    f.harness.sqlite.exec(`INSERT INTO routine_runs (id,tenant,project_id,routine_id,routine_revision,policy_json,occurrence_key,trigger_kind,status)
      SELECT 'other-run',tenant,project_id,routine_id,routine_revision,policy_json,'manual:other','manual','queued' FROM routine_runs WHERE id='run-1'`)
    f.harness.sqlite.prepare(`INSERT INTO routine_run_refs (id,tenant,project_id,run_id,ref_type,ref_id,relation)
      VALUES ('foreign-ref','tenant-a','project-1',?,?,'opaque-foreign','Foreign confidential relation')`)
      .run(boundary === 'artifact-run' ? 'other-run' : 'run-1', boundary === 'artifact-type' ? 'approval' : 'evidence')
    return { type: 'artifact', id: 'opaque-foreign' }
  }

  for (const boundary of ['task-squad', 'task-project', 'flight-tenant', 'flight-project', 'artifact-run', 'artifact-type']) {
    it.each(['observe', 'submit'])(`extra ${boundary} scope is enforced at %s without an intrinsic-reference guard`, async phase => {
      const references = [seedBoundary(boundary)]
      if (phase === 'observe') {
        const result = await observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: question, references })
        expect(result).toEqual({ ok: false, error: 'reference_out_of_scope' })
        expect(JSON.stringify(result)).not.toContain('Foreign confidential')
      } else {
        const result = await submitRoutineProposal(f.env, f.principal, { ...base(), source_observation: await offline(question, references) })
        expect(result).toEqual({ ok: false, error: 'stale_situation' })
      }
      expect(count('routine_run_actions')).toBe(0)
    })
  }

  it.each(['flight-valid', 'artifact-valid'])('offline witness matches the producer for allowed extra %s evidence', async boundary => {
    const references = [seedBoundary(boundary)]
    expect(await offline(question, references)).toEqual(await observe(question, references))
  })

  it('refuses a nonexistent extra source at observe without silently dropping the declaration', async () => {
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: question,
      references: [{ type: 'task', id: 'decoy' }, { type: 'task', id: 'missing' }],
    })).resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
    expect(count('routine_run_actions')).toBe(0)
  })

  it('project_access rejects a correctly forged source witness at submit under propose policy', async () => {
    await reset('propose')
    f.harness.sqlite.exec("INSERT INTO members (id,display_name,tenant,status) VALUES ('target-member','Member','tenant-a','active')")
    const action: RoutineProposalAction = { key: 'grant', kind: 'project_access', input: {
      member_id: 'target-member', project_id: 'project-1', access_level: 'read', reason: 'Onboarding',
    } }
    const source_observation = await offline(action, [{ type: 'task', id: 'decoy' }])
    await expect(submitRoutineProposal(f.env, f.principal, { ...base(action), source_observation })).resolves.toEqual({ ok: false, error: 'stale_situation' })
    expect(count('routine_run_actions')).toBe(0)
    expect(count('project_access_grant_receipts')).toBe(0)
  })

  for (const type of ['task', 'flight'] as const) {
    it.each(['observe', 'submit'])(`refuses this run control ${type} as an extra source at %s`, async phase => {
      const references = [{ type, id: `control-${type}` }]
      if (phase === 'observe') {
        await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: question, references }))
          .resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
      } else {
        await expect(submitRoutineProposal(f.env, f.principal, { ...base(), source_observation: await offline(question, references) }))
          .resolves.toEqual({ ok: false, error: 'stale_situation' })
      }
      expect(count('routine_run_actions')).toBe(0)
    })
  }

  for (const type of ['task', 'flight'] as const) {
    it.each(['observe', 'submit'])(`refuses historical dispatch control ${type} at %s`, async phase => {
      const reference = seedBoundary(`${type}-valid`)
      f.harness.sqlite.prepare(`INSERT INTO routine_run_refs (id,tenant,project_id,run_id,ref_type,ref_id,relation)
        VALUES ('historical-control','tenant-a','project-1','run-1',?,?,'dispatch_${type}')`).run(type, reference.id)
      if (phase === 'observe') {
        await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: question, references: [reference] }))
          .resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
      } else {
        await expect(submitRoutineProposal(f.env, f.principal, { ...base(), source_observation: await offline(question, [reference]) }))
          .resolves.toEqual({ ok: false, error: 'stale_situation' })
      }
      expect(count('routine_run_actions')).toBe(0)
    })
  }

  it.each(['task', 'flight'] as const)('keeps produced business %s records observable and fresh despite their run reference', async type => {
    const reference = seedBoundary(`${type}-valid`)
    f.harness.sqlite.prepare(`INSERT INTO routine_run_refs (id,tenant,project_id,run_id,ref_type,ref_id,relation)
      VALUES ('business-output','tenant-a','project-1','run-1',?,?,'action_result')`).run(type, reference.id)
    const source_observation = await observe(question, [reference])
    expect(source_observation).toEqual(await offline(question, [reference]))
    f.harness.sqlite.prepare(type === 'task' ? 'UPDATE tasks SET body=? WHERE id=?' : 'UPDATE flights SET goal=? WHERE id=?')
      .run('Changed business output', reference.id)
    await expect(submitRoutineProposal(f.env, f.principal, { ...base(), source_observation }))
      .resolves.toEqual({ ok: false, error: 'stale_situation' })
  })

  it('an approved create_task with both freshness checks satisfied succeeds exactly once', async () => {
    await reset('propose')
    const action: RoutineProposalAction = { key: 'approved-create', kind: 'create_task', input: { title: 'Approved work', description: 'Use current evidence' } }
    const proposal = { ...base(action), source_observation: await observe(action) }
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'waiting' })
    await approve()
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'succeeded', duplicate: false })
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'succeeded', duplicate: true })
    expect(row("SELECT COUNT(*) AS n FROM tasks WHERE title='Approved work'")).toEqual({ n: 1 })
  })

  it('an approved stored business observation succeeds despite unrelated board churn', async () => {
    const action: RoutineProposalAction = { key: 'review', kind: 'request_review', input: { source_type: 'task', source_id: TARGET, summary: 'Review the current target' } }
    const observed = await observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action })
    expect(observed).toMatchObject({ ok: true })
    if (!observed.ok) throw new Error(observed.error)
    const proposal = { ...base(action), source_observation: observed.source_observation }
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })
    f.harness.sqlite.exec("INSERT INTO tasks (id,squad_id,project_id,title,done_when,status) VALUES ('unrelated','squad-1','project-1','Unrelated','Verified','blocked')")
    await approve()
    await expect(submitRoutineProposal(f.env, f.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'succeeded' })
    expect(row("SELECT status FROM routine_run_actions WHERE action_key='review'")).toEqual({ status: 'succeeded' })
    expect(row("SELECT status FROM routine_runs WHERE id='run-1'")).toEqual({ status: 'succeeded' })
  })

  it('an over-budget union is invalid_proposal at submit without burning a retry', async () => {
    const action: RoutineProposalAction = { key: 'large', kind: 'dispatch_flight', input: {
      goal: 'Large input', task_ids: Array.from({ length: 200 }, (_, i) => `input-${i}`), artifact_refs: [], budget_micro_usd: 100,
    } }
    await expect(submitRoutineProposal(f.env, f.principal, { ...base(action), source_observation: {
      digest: 'a'.repeat(64), references: [{ type: 'task', id: 'decoy' }],
    } })).resolves.toEqual({ ok: false, error: 'invalid_proposal' })
    expect(row("SELECT status,result_summary FROM routine_runs WHERE id='run-1'")).toEqual({ status: 'running', result_summary: null })
    expect(count('routine_run_actions')).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { executeRoutineAction, observeRoutineProposal, submitRoutineProposal } from '../src/routines/actions'
import type { AuthContext } from '../src/types'
import type { RoutineProposalAction } from '../src/routines/proposal'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

describe('routine declared source observations', () => {
  let f: ReadyRoutineFixture
  const action: RoutineProposalAction = {
    key: 'audit', kind: 'ask_human',
    input: { question: 'Review the source?', references: [{ type: 'task', id: 'source' }] },
  }
  const auth = (agent = 'agent-1'): AuthContext => ({
    userId: 'member-1', memberId: 'member-1', email: null, role: 'member',
    tenant: 'tenant-a', channel: 'workspace', boundAgentId: agent,
    capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  })
  beforeEach(async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    f = await makeReadyRoutineFixture('execute_internal', harness)
    f.harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status)
      VALUES ('source', 'squad-1', 'project-1', 'Audit source', 'Original evidence', 'Verified', 'open')`)
  })
  afterEach(() => f.harness.close())

  async function observe(a = action, references: { type: string; id: string }[] = []) {
    const result = await invokeTool(auth(), f.env, 'routine_proposal_observe', {
      run_id: 'run-1', action: a, references,
    }, 'https://pot.test')
    expect(result).toMatchObject({ ok: true })
    return result.result as {
      situation_digest: string
      source_observation: { digest: string; references: { type: string; id: string }[] }
      sources: { type: string; id: string; fact: Record<string, unknown> }[]
    }
  }
  const proposal = (o: Awaited<ReturnType<typeof observe>>, a = action) => ({
    ...f.proposal(a), situation_digest: o.situation_digest, source_observation: o.source_observation,
  })
  function noReservation() {
    expect(f.harness.sqlite.prepare('SELECT COUNT(*) AS n FROM routine_run_actions').get()).toEqual({ n: 0 })
  }

  it('accepts a long read-only audit despite unrelated board churn and retains human wait', async () => {
    const before = f.harness.sqlite.prepare('SELECT COUNT(*) AS n FROM routine_run_events').get()
    const o = await observe()
    expect(o.sources).toEqual([expect.objectContaining({ type: 'task', id: 'source', fact: expect.objectContaining({ body: 'Original evidence', status: 'open' }) })])
    for (const field of ['external_source', 'github_issue_url', 'source_pot', 'priority', 'parent_task_id']) {
      expect(o.sources[0].fact).not.toHaveProperty(field)
    }
    expect(f.harness.sqlite.prepare('SELECT COUNT(*) AS n FROM routine_run_events').get()).toEqual(before)
    f.harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
      VALUES ('unrelated', 'squad-1', 'project-1', 'Unrelated board work', 'Verified', 'blocked')`)
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o))).resolves.toMatchObject({ ok: true, status: 'waiting' })
    expect(f.harness.sqlite.prepare("SELECT status, waiting_reason FROM routine_runs WHERE id='run-1'").get()).toEqual({ status: 'waiting', waiting_reason: 'answer' })
    expect(f.harness.sqlite.prepare("SELECT status FROM tasks WHERE id='source'").get()).toEqual({ status: 'open' })
  })

  it.each([
    "UPDATE tasks SET status='blocked' WHERE id='source'",
    "UPDATE tasks SET body='Changed evidence' WHERE id='source'",
    "INSERT INTO members (id, display_name, tenant) VALUES ('archiver', 'Archiver', 'tenant-a'); INSERT INTO tasks_archive_state (task_id, archived_at, archived_by_member_id, archived_reason, prior_status) VALUES ('source', '2026-10-30T00:00:00Z', 'archiver', 'Archived after observation', 'open')",
    "DELETE FROM tasks WHERE id='source'",
  ])('refuses changed declared source facts without reserving: %s', async sql => {
    const o = await observe()
    f.harness.sqlite.exec(sql)
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('binds observation to the exact action, explicit references, and dispatch attempt', async () => {
    const o = await observe()
    const changed = { ...action, input: { ...action.input, question: 'Different decision' } }
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, changed))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it.each(['attempt', 'dispatch digest'])('refuses an observation from a different %s', async changed => {
    const o = await observe()
    f.harness.sqlite.exec(changed === 'attempt'
      ? "UPDATE routine_runs SET attempt=2 WHERE id='run-1'"
      : "UPDATE routine_runs SET situation_digest='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id='run-1'")
    const p = proposal(o)
    if (changed === 'dispatch digest') p.situation_digest = 'b'.repeat(64)
    await expect(submitRoutineProposal(f.env, f.principal, p)).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('cannot remove explicitly declared sources while reusing their digest', async () => {
    const a: RoutineProposalAction = { key: 'none', kind: 'no_action', input: { reason: 'No work' } }
    const o = await observe(a, [{ type: 'task', id: 'source' }])
    await expect(submitRoutineProposal(f.env, f.principal, {
      ...proposal(o, a), source_observation: { ...o.source_observation, references: [] },
    })).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('pins intrinsic flight task sources even without extra declarations', async () => {
    const a: RoutineProposalAction = { key: 'fly', kind: 'dispatch_flight', input: { goal: 'Audit', task_ids: ['source'], artifact_refs: [], budget_micro_usd: 100 } }
    const o = await observe(a)
    expect(o.sources).toHaveLength(1)
    f.harness.sqlite.exec("UPDATE tasks SET body='Changed flight input' WHERE id='source'")
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, a))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('pins declared flight records and rejects another tenant or squad', async () => {
    const a: RoutineProposalAction = { key: 'flight-review', kind: 'ask_human', input: { question: 'Review flight?', references: [{ type: 'flight', id: 'control-flight' }] } }
    const o = await observe(a)
    expect(o.sources[0].fact).toMatchObject({ id: 'control-flight', status: 'running' })
    expect(o.sources[0].fact).not.toHaveProperty('meta')
    f.harness.sqlite.exec("UPDATE flights SET goal='New flight goal' WHERE id='control-flight'")
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, a))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('pins opaque artifact reference identity, without claiming external bytes', async () => {
    f.harness.sqlite.exec(`INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation)
      VALUES ('evidence-ref', 'tenant-a', 'project-1', 'run-1', 'evidence', 'sha256:proof', 'audited')`)
    const a: RoutineProposalAction = { key: 'evidence', kind: 'request_review', input: { source_type: 'artifact', source_id: 'sha256:proof', summary: 'Review proof' } }
    const o = await observe(a)
    expect(o.sources).toHaveLength(1)
    f.harness.sqlite.exec(`INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation)
      VALUES ('output-ref', 'tenant-a', 'project-1', 'run-1', 'output', 'sha256:proof', 'reclassified')`)
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, a))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it.each([
    { digest: 'a'.repeat(64) },
    { digest: 'invalid', references: [] },
    { digest: 'a'.repeat(64), references: [], unknown: true },
    { digest: 'a'.repeat(64), references: [{ type: 'member', id: 'source' }] },
  ])('fails closed on malformed observations: %j', async source_observation => {
    await expect(submitRoutineProposal(f.env, f.principal, { ...f.proposal(action), source_observation })).resolves.toEqual({ ok: false, error: 'invalid_proposal' })
    noReservation()
  })

  it('observes no run state writes and refuses stale scope and excessive declarations', async () => {
    const before = f.harness.sqlite.prepare('SELECT total_changes() AS n').get()
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action })).resolves.toMatchObject({ ok: true })
    expect(f.harness.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action, references: Array.from({ length: 21 }, (_, i) => ({ type: 'task', id: `t${i}` })) })).resolves.toEqual({ ok: false, error: 'invalid_proposal' })
    f.harness.sqlite.exec("DELETE FROM project_squad_access WHERE project_id='project-1'")
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action })).resolves.toEqual({ ok: false, error: 'run_not_found' })
  })

  it('keeps privileged project_access on the legacy freshness protocol', async () => {
    const a: RoutineProposalAction = { key: 'privileged', kind: 'project_access', input: { member_id: 'member-1', project_id: 'project-1', access_level: 'read', reason: 'Onboarding' } }
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: a })).resolves.toEqual({ ok: false, error: 'invalid_proposal' })
    noReservation()
  })

  it('requires at least one declared source before leaving legacy board freshness', async () => {
    const a: RoutineProposalAction = { key: 'none', kind: 'no_action', input: { reason: 'Nothing to do' } }
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: a })).resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
  })

  it('rejects an over-budget source union as invalid input before reading it', async () => {
    const insert = f.harness.sqlite.prepare("INSERT INTO tasks (id,squad_id,project_id,title,done_when,status) VALUES (?,'squad-1','project-1','Input','Verified','open')")
    const task_ids = Array.from({ length: 200 }, (_, i) => `input-${i}`)
    for (const id of task_ids) insert.run(id)
    const a: RoutineProposalAction = { key: 'large', kind: 'dispatch_flight', input: { goal: 'Large flight', task_ids, artifact_refs: [], budget_micro_usd: 100 } }
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: a, references: [{ type: 'task', id: 'source' }] })).resolves.toEqual({ ok: false, error: 'invalid_proposal' })
  })

  it.each([
    ["UPDATE routine_runs SET status='failed', finished_at='2026-10-30T00:00:00.000Z' WHERE id='run-1'", 'run_not_accepting_proposal'],
    ["UPDATE routine_runs SET situation_digest=NULL WHERE id='run-1'", 'run_not_accepting_proposal'],
    ["UPDATE projects SET status='paused' WHERE id='project-1'", 'project_not_active'],
    ["INSERT INTO routine_run_events (id,tenant,project_id,run_id,kind,actor_type,actor_id,occurred_at,metadata_json,correlation_id) VALUES ('cancel','tenant-a','project-1','run-1','cancellation_requested','agent','agent-1','2026-10-30T00:00:00.000Z','{}','run-1')", 'run_not_accepting_proposal'],
  ])('refuses observation after run eligibility changes: %s', async (sql, error) => {
    f.harness.sqlite.exec(sql)
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action })).resolves.toEqual({ ok: false, error })
    noReservation()
  })

  it('refuses a member principal, a foreign tenant, and a lost capability', async () => {
    for (const [principal, error] of [
      [{ ...f.principal, actor_type: 'member' as const }, 'forbidden'],
      [{ ...f.principal, tenant: 'other' }, 'run_not_found'],
      [{ ...f.principal, grants: [] }, 'forbidden'],
    ] as const) {
      await expect(observeRoutineProposal(f.env, principal, { run_id: 'run-1', action })).resolves.toEqual({ ok: false, error })
    }
  })

  it.each([
    "UPDATE tasks SET project_id=NULL WHERE id='source'",
    "INSERT INTO squads (id,department_id,slug,name) VALUES ('other','dept-1','other','Other'); INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES ('project-1','other','write'); UPDATE tasks SET squad_id='other' WHERE id='source'",
  ])('refuses a task source that moves outside observation scope: %s', async sql => {
    const o = await observe()
    f.harness.sqlite.exec(sql)
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it.each(['tenant', 'project', 'squad', 'multi-squad'])('refuses out-of-scope flight observation: %s', async scope => {
    f.harness.sqlite.exec(`INSERT INTO squads (id,department_id,slug,name) VALUES ('other','dept-1','other','Other');
      INSERT INTO projects (id,slug,name,status) VALUES ('other','other','Other','active');
      INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES ('other','squad-1','write'), ('project-1','other','write');`)
    const meta = JSON.parse(String(f.harness.sqlite.prepare("SELECT meta FROM flights WHERE id='control-flight'").get()?.meta))
    f.harness.sqlite.prepare(`INSERT INTO tasks (id,squad_id,project_id,title,done_when,status)
      VALUES ('flight-source', ?, ?, 'Flight source', 'Verified', 'open')`).run(scope === 'squad' ? 'other' : 'squad-1', scope === 'project' ? 'other' : 'project-1')
    meta.task_ids = ['flight-source']
    if (scope === 'squad') meta.squad_ids = ['other']
    if (scope === 'multi-squad') meta.squad_ids = ['squad-1', 'other']
    f.harness.sqlite.prepare(`INSERT INTO flights (id,tenant,project_id,agent,goal,status,meta)
      VALUES ('foreign', ?, ?, 'agent-2', 'Foreign flight', 'running', ?)`).run(scope === 'tenant' ? 'other' : 'tenant-a', scope === 'project' ? 'other' : 'project-1', JSON.stringify(meta))
    const a: RoutineProposalAction = { key: 'flight', kind: 'request_review', input: { source_type: 'flight', source_id: 'foreign', summary: 'Review' } }
    await expect(observeRoutineProposal(f.env, f.principal, { run_id: 'run-1', action: a })).resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
  })

  it('protects an explicitly declared source even for no_action', async () => {
    const a: RoutineProposalAction = { key: 'none', kind: 'no_action', input: { reason: 'Source needs no work' } }
    const o = await observe(a, [{ type: 'task', id: 'source' }])
    f.harness.sqlite.exec("UPDATE tasks SET body='New evidence' WHERE id='source'")
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, a))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('rechecks sources at execution after a human wait', async () => {
    const a: RoutineProposalAction = { key: 'review', kind: 'request_review', input: { source_type: 'task', source_id: 'source', summary: 'Check source' } }
    const o = await observe(a)
    await expect(submitRoutineProposal(f.env, f.principal, proposal(o, a))).resolves.toMatchObject({ ok: true, status: 'waiting' })
    f.harness.sqlite.exec("UPDATE tasks SET body='Revised after review request' WHERE id='source'")
    await expect(executeRoutineAction(f.env, 'run-1', 'review')).resolves.toEqual({ ok: false, error: 'stale_situation' })
    expect(f.harness.sqlite.prepare("SELECT status FROM routine_run_actions WHERE action_key='review'").get()).toEqual({ status: 'cancelled' })
  })

  it('does not refresh a legacy proposal silently', async () => {
    await expect(submitRoutineProposal(f.env, f.principal, f.proposal(action))).resolves.toEqual({ ok: false, error: 'stale_situation' })
    noReservation()
  })

  it('refuses another agent and out-of-scope references without exposing facts', async () => {
    await expect(invokeTool(auth('agent-2'), f.env, 'routine_proposal_observe', { run_id: 'run-1', action, references: [] }, 'https://pot.test')).resolves.toMatchObject({ ok: false, error: 'assigned_agent_mismatch' })
    f.harness.sqlite.exec("UPDATE tasks SET project_id=NULL WHERE id='source'")
    await expect(invokeTool(auth(), f.env, 'routine_proposal_observe', { run_id: 'run-1', action, references: [] }, 'https://pot.test')).resolves.toMatchObject({ ok: false, error: 'reference_out_of_scope' })
    noReservation()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { landGovernedFlight } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { canonicalJsonDigest } from '../src/lib/canonical-json'
import { loadProjectSituation } from '../src/projects/situation'
import { cancelRoutineRun, executeRoutineAction, submitRoutineProposal } from '../src/routines/actions'
import type { RoutinePrincipal } from '../src/routines/access'
import type { Env, Project } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

function row(fixture: ReadyRoutineFixture, sql: string, ...binds: unknown[]): Record<string, unknown> | undefined {
  return fixture.harness.sqlite.prepare(sql).get(...binds)
}

function failFlightCreation(env: Env): Env {
  const db = env.DB
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (/INSERT INTO flights/.test(sql)) {
          return {
            bind() { return this },
            async run() { throw new Error('simulated flight execution failure') },
          } as unknown as D1PreparedStatement
        }
        return db.prepare(sql)
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database,
  }
}

function loseActionClaim(env: Env, fixture: ReadyRoutineFixture): Env {
  const db = env.DB
  return {
    ...env,
    DB: {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        const claimsAction = statements.some(statement => (
          /UPDATE routine_run_actions SET status = 'running'/.test((statement as unknown as { sql?: string }).sql ?? '')
        ))
        if (claimsAction) {
          fixture.harness.sqlite.exec(`
            UPDATE routine_run_actions SET status = 'cancelled' WHERE id = 'action-lost';
            UPDATE routine_runs SET status = 'queued', proposal_json = NULL WHERE id = 'run-1';
          `)
        }
        return db.batch(statements)
      },
    } as unknown as D1Database,
  }
}

function landChildBeforeControlFlight(env: Env, fixture: ReadyRoutineFixture): Env {
  const db = env.DB
  let injected = false
  return {
    ...env,
    DB: {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        const landsControlFlight = statements.some(statement => {
          const prepared = statement as unknown as { sql?: string; values?: unknown[] }
          return /UPDATE flights SET status='landed'/.test(prepared.sql ?? '')
            && prepared.values?.[0] === 'control-flight'
        })
        if (landsControlFlight && !injected) {
          injected = true
          const child = row(fixture, `
            SELECT id, agent, meta FROM flights
             WHERE id <> 'control-flight'
               AND json_extract(meta, '$.routine_run_id') = 'run-1'
               AND status = 'running'
             ORDER BY created_at DESC LIMIT 1
          `)
          const meta = parseFlightMetaV1(JSON.parse(child?.meta as string))
          if (!child || !meta) throw new Error('expected running Routine child Flight')
          const landed = await landGovernedFlight(env, child.id as string, {
            cost_micro_usd: 3000,
            expected_agent: child.agent as string,
            agent_id: child.agent as string,
            meta,
            actor: { kind: 'agent', id: child.agent as string },
          })
          if (!landed) throw new Error('expected injected child Flight landing')
        }
        return db.batch(statements)
      },
    } as unknown as D1Database,
  }
}

describe('Routine proposal submission and governed actions', () => {
  let fixture: ReadyRoutineFixture | undefined

  afterEach(() => {
    fixture?.harness.close()
    fixture = undefined
  })

  it('rejects the wrong agent and mismatched run, Project, or Situation correlation', async () => {
    fixture = await makeReadyRoutineFixture()
    const action = { key: 'none-1', kind: 'no_action' as const, input: { reason: 'Nothing to do.' } }
    const wrongAgent: RoutinePrincipal = { ...fixture.principal, actor_id: 'agent-2' }
    await expect(submitRoutineProposal(fixture.env, wrongAgent, fixture.proposal(action))).resolves.toEqual({
      ok: false, error: 'assigned_agent_mismatch',
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, {
      ...fixture.proposal(action), project_id: 'project-other',
    })).resolves.toEqual({ ok: false, error: 'project_mismatch' })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, {
      ...fixture.proposal(action), situation_digest: 'b'.repeat(64),
    })).resolves.toEqual({ ok: false, error: 'situation_mismatch' })
    const revoked: RoutinePrincipal = {
      ...fixture.principal,
      grants: [],
      project_read: { workspaceAdmin: false, orgRead: false, squadIds: [], departmentIds: [] },
    }
    await expect(submitRoutineProposal(fixture.env, revoked, fixture.proposal(action))).resolves.toEqual({
      ok: false, error: 'run_not_found',
    })
  })

  it('queues a fresh observation when unrelated Project state changed', async () => {
    fixture = await makeReadyRoutineFixture()
    fixture.harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
      VALUES ('new-business-state', 'squad-1', 'project-1', 'New state', 'Verified', 'open')
    `)

    const result = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'none-1', kind: 'no_action', input: { reason: 'Nothing to do.' },
    }))

    expect(result).toEqual({ ok: false, error: 'stale_situation' })
    expect(row(fixture, "SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'queued', result_summary: 'stale_situation',
    })
  })

  it('rejects out-of-squad assignees, out-of-Project tasks, and budget overflow', async () => {
    fixture = await makeReadyRoutineFixture()
    fixture.harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-2', 'other', 'Other');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept-2', 'other', 'Other');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-other', 'squad-2', 'other', 'Other', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-2', 'project-2', 'Project Two', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-2', 'squad-2', 'write');
      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
      VALUES ('other-task', 'squad-2', 'project-2', 'Other task', 'Done', 'open');
    `)
    await expect(submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'task-1', kind: 'create_task', input: { title: 'Task', description: 'Description', assignee_agent_id: 'agent-other' },
    }))).resolves.toEqual({ ok: false, error: 'assignee_ineligible' })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'flight-1', kind: 'dispatch_flight',
      input: { goal: 'Go', task_ids: ['other-task'], artifact_refs: [], budget_micro_usd: 1000 },
    }))).resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'flight-2', kind: 'dispatch_flight',
      input: { goal: 'Go', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 100001 },
    }))).resolves.toEqual({ ok: false, error: 'budget_exceeded' })
  })

  it('routes propose mode through the existing Task review gate', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const result = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'task-1', kind: 'create_task', input: { title: 'Task', description: 'Description' },
    }))

    expect(result).toMatchObject({ ok: true, status: 'waiting', reason: 'review', duplicate: false })
    expect(row(fixture, "SELECT status, gate_owner FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'review', gate_owner: 'gate:routines',
    })
    expect(row(fixture, "SELECT status, waiting_reason FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'waiting', waiting_reason: 'review',
    })
  })

  it('converges concurrent propose-mode replay on one review request', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const proposal = fixture.proposal({
      key: 'task-review-concurrent', kind: 'create_task',
      input: { title: 'Review this once', description: 'One governed review request.' },
    })

    const results = await Promise.all([
      submitRoutineProposal(fixture.env, fixture.principal, proposal),
      submitRoutineProposal(fixture.env, fixture.principal, proposal),
    ])

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, status: 'waiting', reason: 'review', duplicate: false }),
      expect.objectContaining({ ok: true, status: 'waiting', reason: 'review', duplicate: true }),
    ]))
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE kind = 'approval_requested'")).toEqual({ count: 1 })
  })

  it('executes internal task creation once and returns the same result on replay', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const proposal = fixture.proposal({
      key: 'task-1', kind: 'create_task',
      input: { title: 'Verify conversion', description: 'Attach evidence.', assignee_agent_id: 'agent-2' },
    })

    const first = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    expect(first).toMatchObject({ ok: true, status: 'succeeded', duplicate: false, result: { task_id: expect.any(String) } })
    const replay = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    expect(replay).toMatchObject({ ok: true, status: 'succeeded', duplicate: true, result: first.ok ? first.result : {} })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM tasks WHERE title = 'Verify conversion'")).toEqual({ count: 1 })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'task-1', kind: 'create_task', input: { title: 'Different input', description: 'Conflict' },
    }))).resolves.toEqual({ ok: false, error: 'action_key_conflict' })
  })

  it('converges concurrent identical SQLite proposals on one stored result', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const proposal = fixture.proposal({
      key: 'task-concurrent', kind: 'create_task',
      input: { title: 'One concurrent task', description: 'Create this exactly once.' },
    })

    const [left, right] = await Promise.all([
      submitRoutineProposal(fixture.env, fixture.principal, proposal),
      submitRoutineProposal(fixture.env, fixture.principal, proposal),
    ])

    expect(left).toMatchObject({ ok: true, status: 'succeeded', result: { task_id: expect.any(String) } })
    expect(right).toMatchObject({
      ok: true, status: 'succeeded', duplicate: true,
      result: left.ok && left.status === 'succeeded' ? left.result : {},
    })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM tasks WHERE title = 'One concurrent task'")).toEqual({ count: 1 })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_actions WHERE action_key = 'task-concurrent'")).toEqual({ count: 1 })
  })

  it('successfully completes no_action through the control Task and governed Flight lifecycle', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')

    const result = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'none-1', kind: 'no_action', input: { reason: 'No accountable action is currently available.' },
    }))

    expect(result).toMatchObject({
      ok: true, status: 'succeeded', duplicate: false,
      result: { no_action: true, reason: 'No accountable action is currently available.' },
    })
    expect(row(fixture, "SELECT status, completed_at FROM tasks WHERE id = 'control-task'")).toMatchObject({
      status: 'done', completed_at: expect.any(String),
    })
    expect(row(fixture, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'landed' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM flight_event_outbox WHERE flight_id = 'control-flight' AND event_type = 'flight.landed'")).toEqual({ count: 1 })
  })

  it('dispatches an internal Flight within budget and keeps human questions waiting', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const flight = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'flight-1', kind: 'dispatch_flight',
      input: { goal: 'Verify conversion', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 5000 },
    }))
    expect(flight).toMatchObject({ ok: true, status: 'succeeded', result: { flight_id: expect.any(String) } })

    fixture.harness.close()
    fixture = await makeReadyRoutineFixture('execute_internal')
    const question = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'question-1', kind: 'ask_human',
      input: { question: 'Which event is authoritative?', choices: ['Booked', 'Paid'], references: [] },
    }))
    expect(question).toMatchObject({ ok: true, status: 'waiting', reason: 'answer' })
  })

  it('aggregates a dispatched child Flight cost when the Flight lands', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const submitted = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'flight-1', kind: 'dispatch_flight',
      input: { goal: 'Verify conversion', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 5000 },
    }))
    expect(submitted).toMatchObject({ ok: true, status: 'succeeded', result: { flight_id: expect.any(String) } })
    if (!submitted.ok || submitted.status !== 'succeeded') throw new Error('expected dispatched Flight')
    const flightId = submitted.result.flight_id as string
    const flight = row(fixture, 'SELECT agent, meta FROM flights WHERE id = ?', flightId)
    const meta = parseFlightMetaV1(JSON.parse(flight?.meta as string))
    if (!meta) throw new Error('expected governed Flight metadata')

    const landed = await landGovernedFlight(fixture.env, flightId, {
      cost_micro_usd: 3000,
      expected_agent: flight?.agent as string,
      agent_id: 'agent-1',
      meta,
      actor: { kind: 'agent', id: 'agent-1' },
    })

    expect(landed).toBe(true)
    expect(row(fixture, "SELECT cost_micro_usd FROM routine_runs WHERE id = 'run-1'")).toEqual({
      cost_micro_usd: 3000,
    })
  })

  it('aggregates cost when a child Flight lands before its run reference is persisted', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')

    const submitted = await submitRoutineProposal(
      landChildBeforeControlFlight(fixture.env, fixture),
      fixture.principal,
      fixture.proposal({
        key: 'flight-race', kind: 'dispatch_flight',
        input: { goal: 'Fast child Flight', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 5000 },
      }),
    )

    expect(submitted).toMatchObject({ ok: true, status: 'succeeded', result: { flight_id: expect.any(String) } })
    expect(row(fixture, "SELECT cost_micro_usd FROM routine_runs WHERE id = 'run-1'")).toEqual({
      cost_micro_usd: 3000,
    })
  })

  it('requires an approved existing gate before executing a propose-mode action', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const proposal = fixture.proposal({
      key: 'task-1', kind: 'create_task', input: { title: 'Approved task', description: 'Description' },
    })
    const submitted = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    expect(submitted).toMatchObject({ ok: true, status: 'waiting' })
    await expect(executeRoutineAction(fixture.env, 'run-1', 'task-1')).resolves.toEqual({
      ok: false, error: 'approval_required',
    })
    fixture.harness.sqlite.exec(`
      UPDATE tasks SET status = 'approved' WHERE id = 'control-task';
      INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
      VALUES ('verdict-1', 'control-task', 'approved', 'owner-1', '2026-07-19T16:10:00.000Z');
    `)

    await expect(executeRoutineAction(fixture.env, 'run-1', 'task-1')).resolves.toMatchObject({
      ok: true, status: 'succeeded', result: { task_id: expect.any(String) },
    })
  })

  it('refuses an approved proposal when the Project Situation changed before execution', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const proposal = fixture.proposal({
      key: 'task-1', kind: 'create_task', input: { title: 'Stale task', description: 'Description' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    fixture.harness.sqlite.exec(`
      UPDATE tasks SET status = 'approved' WHERE id = 'control-task';
      INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
      VALUES ('verdict-1', 'control-task', 'approved', 'owner-1', '2026-07-19T16:10:00.000Z');
      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
      VALUES ('changed-state', 'squad-1', 'project-1', 'Changed state', 'Verified', 'open');
    `)

    await expect(executeRoutineAction(fixture.env, 'run-1', 'task-1')).resolves.toEqual({
      ok: false, error: 'stale_situation',
    })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE action_key = 'task-1'")).toEqual({ status: 'cancelled' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM tasks WHERE title = 'Stale task'")).toEqual({ count: 0 })
  })

  it('does not cancel a running action when its accepted Situation is re-observed as stale', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const proposal = fixture.proposal({
      key: 'none-running', kind: 'no_action', input: { reason: 'The accepted observation owns completion.' },
    })
    fixture.harness.sqlite.prepare(
      "UPDATE routine_runs SET proposal_json = ? WHERE id = 'run-1'",
    ).run(JSON.stringify(proposal))
    fixture.harness.sqlite.prepare(
      `INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json,
        validation_status, gate_status, status
      ) VALUES ('action-running', 'tenant-a', 'project-1', 'run-1', 'none-running',
                'no_action', ?, 'accepted', 'not_required', 'running')`,
    ).run(JSON.stringify(proposal.action.input))
    fixture.harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
      VALUES ('newer-state', 'squad-1', 'project-1', 'Newer state', 'Verified', 'open')
    `)

    await expect(executeRoutineAction(fixture.env, 'run-1', 'none-running')).resolves.toMatchObject({
      ok: true, status: 'succeeded', result: { no_action: true },
    })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE id = 'action-running'")).toEqual({ status: 'succeeded' })
    expect(row(fixture, "SELECT status FROM routine_runs WHERE id = 'run-1'")).toEqual({ status: 'succeeded' })
  })

  it('writes no control terminal side effects after losing the action claim', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const proposal = fixture.proposal({
      key: 'none-lost', kind: 'no_action', input: { reason: 'This caller loses ownership.' },
    })
    fixture.harness.sqlite.prepare(
      "UPDATE routine_runs SET proposal_json = ? WHERE id = 'run-1'",
    ).run(JSON.stringify(proposal))
    fixture.harness.sqlite.prepare(
      `INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json,
        validation_status, gate_status, status
      ) VALUES ('action-lost', 'tenant-a', 'project-1', 'run-1', 'none-lost',
                'no_action', ?, 'accepted', 'not_required', 'pending')`,
    ).run(JSON.stringify(proposal.action.input))

    await expect(executeRoutineAction(loseActionClaim(fixture.env, fixture), 'run-1', 'none-lost')).resolves.toEqual({
      ok: false, error: 'receipt_failed',
    })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'in_progress' })
    expect(row(fixture, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'running' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE kind IN ('action_completed','succeeded')")).toEqual({ count: 0 })
  })

  it('retry-schedules a held child Flight without leaving the action running', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const collisionMeta = JSON.stringify({
      schema: 'mupot.flight.meta/v1', goal_id: 'collision', objective_id: 'collision',
      squad_ids: ['squad-1'], task_ids: ['control-task'], done_when: ['Verified'],
      artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none',
      parent_flight_id: null,
    }).replaceAll("'", "''")
    fixture.harness.sqlite.exec(`
      INSERT INTO flights (
        id, tenant, project_id, agent, goal, status, trigger_source, gate_verdict,
        budget_micro_usd, cost_micro_usd, created_at, started_at, meta
      ) VALUES (
        'conflicting-flight', 'tenant-a', 'project-1', 'agent-2', 'Conflicting work',
        'running', 'manual', 'go', 1000, 0, 1752940800001, 1752940800001, '${collisionMeta}'
      )
    `)
    const project = row(fixture, `
      SELECT id, slug, name, description, goal, status, parent_project_id,
             target_date, created_at, updated_at
        FROM projects WHERE id = 'project-1'
    `) as unknown as Project
    const digest = await canonicalJsonDigest(await loadProjectSituation(
      fixture.env, project, ['squad-1'], {
        excludeTaskIds: ['control-task'], excludeFlightIds: ['control-flight'],
      },
    ))
    fixture.harness.sqlite.prepare("UPDATE routine_runs SET situation_digest = ? WHERE id = 'run-1'").run(digest)

    const result = await submitRoutineProposal(fixture.env, fixture.principal, {
      ...fixture.proposal({
        key: 'flight-held', kind: 'dispatch_flight',
        input: { goal: 'Colliding work', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 1000 },
      }),
      situation_digest: digest,
    })

    expect(result).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'execution_failed' })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE action_key = 'flight-held'")).toEqual({ status: 'failed' })
    expect(row(fixture, "SELECT status, result_summary, retry_at FROM routine_runs WHERE id = 'run-1'")).toMatchObject({
      status: 'queued', result_summary: 'flight_clearance_hold', retry_at: expect.any(String),
    })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'in_progress' })
    expect(row(fixture, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'running' })

    fixture.harness.sqlite.exec(`
      UPDATE flights SET status = 'landed', ended_at = 1752940900000
       WHERE id = 'conflicting-flight';
    `)
    const retryDigest = await canonicalJsonDigest(await loadProjectSituation(
      fixture.env, project, ['squad-1'], {
        excludeTaskIds: ['control-task'], excludeFlightIds: ['control-flight'],
      },
    ))
    fixture.harness.sqlite.exec(`
      UPDATE routine_runs
         SET status = 'running', attempt = 2, retry_at = NULL, result_summary = NULL,
             proposal_json = NULL, situation_digest = '${retryDigest}'
       WHERE id = 'run-1';
    `)
    const retry = await submitRoutineProposal(fixture.env, fixture.principal, {
      ...fixture.proposal({
        key: 'flight-held', kind: 'dispatch_flight',
        input: { goal: 'Colliding work', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 1000 },
      }),
      situation_digest: retryDigest,
    })

    expect(retry).toMatchObject({ ok: true, status: 'succeeded', result: { flight_id: expect.any(String) } })
    expect(row(fixture, `
      SELECT COUNT(*) AS count FROM flights
       WHERE json_extract(meta, '$.objective_id') = (
         SELECT id FROM routine_run_actions WHERE action_key = 'flight-held'
       )
    `)).toEqual({ count: 2 })
  })

  it('fails an exhausted run when child Flight execution throws and never leaves the action running', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.prepare("UPDATE routine_runs SET attempt = 3 WHERE id = 'run-1'").run()

    const result = await submitRoutineProposal(failFlightCreation(fixture.env), fixture.principal, fixture.proposal({
      key: 'flight-throws', kind: 'dispatch_flight',
      input: { goal: 'Throw during dispatch', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 1000 },
    }))

    expect(result).toEqual({ ok: false, error: 'action_failed' })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE action_key = 'flight-throws'")).toEqual({ status: 'failed' })
    expect(row(fixture, "SELECT status, result_summary, retry_at FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'failed', result_summary: 'execution_failed', retry_at: null,
    })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'in_progress' })
    expect(row(fixture, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'running' })
  })

  it('reuses a cancelled stable action key with identical input on retry', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.exec(`
      INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json,
        validation_status, gate_status, status, result_json
      ) VALUES (
        'action-cancelled', 'tenant-a', 'project-1', 'run-1', 'none-retry', 'no_action',
        '{"reason":"Retry the same observation."}', 'rejected', 'not_required', 'cancelled',
        '{"reason":"stale_situation"}'
      )
    `)

    await expect(submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'none-retry', kind: 'no_action', input: { reason: 'Retry the same observation.' },
    }))).resolves.toMatchObject({ ok: true, status: 'succeeded' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_actions WHERE action_key = 'none-retry'")).toEqual({ count: 1 })
  })

  it('cancels a readable nonterminal run once, audits it, and preserves terminal safety', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.exec(`
      INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json, status
      ) VALUES ('action-cancel', 'tenant-a', 'project-1', 'run-1', 'cancel-me', 'no_action', '{"reason":"stop"}', 'waiting');
    `)
    const administrator: RoutinePrincipal = {
      ...fixture.principal,
      actor_type: 'member', actor_id: 'owner-1', workspace_admin: true,
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }
    const blocked = await cancelRoutineRun(fixture.env, fixture.principal, 'run-1')
    expect(blocked).toEqual({ ok: false, error: 'forbidden' })
    await expect(cancelRoutineRun(fixture.env, {
      ...administrator, actor_type: 'agent', actor_id: 'agent-1',
    }, 'run-1')).resolves.toEqual({ ok: false, error: 'forbidden' })

    const cancelled = await cancelRoutineRun(fixture.env, administrator, 'run-1')
    expect(cancelled).toEqual({ ok: true, run_id: 'run-1', duplicate: false, outcome: 'confirmed' })
    expect(row(fixture, "SELECT status, waiting_reason FROM routine_runs WHERE id = 'run-1'")).toEqual({ status: 'cancelled', waiting_reason: null })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE id = 'action-cancel'")).toEqual({ status: 'cancelled' })
    expect(row(fixture, "SELECT status, gate_reason FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'failed', gate_reason: 'routine_cancelled' })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'blocked' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'cancellation_requested'")).toEqual({ count: 1 })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'cancellation_confirmed'")).toEqual({ count: 1 })
    await expect(cancelRoutineRun(fixture.env, administrator, 'run-1')).resolves.toEqual({ ok: true, run_id: 'run-1', duplicate: true, outcome: 'confirmed' })
    const partial = await makeReadyRoutineFixture('execute_internal')
    partial.harness.sqlite.prepare(
      "UPDATE routine_runs SET status = 'cancelled', finished_at = '2026-07-19T17:00:00.000Z' WHERE id = 'run-1'",
    ).run()
    await expect(cancelRoutineRun(partial.env, administrator, 'run-1')).resolves.toEqual({ ok: false, error: 'receipt_failed' })
    partial.harness.close()
  })

  it('hides unreadable runs and revalidates Project and squad authority before replaying succeeded, waiting, or running actions', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const proposal = fixture.proposal({ key: 'revoked', kind: 'no_action', input: { reason: 'Done.' } })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal)).resolves.toMatchObject({ ok: true, status: 'succeeded' })
    const revoked: RoutinePrincipal = {
      ...fixture.principal,
      grants: [], project_read: { workspaceAdmin: false, orgRead: false, squadIds: [], departmentIds: [] },
    }
    await expect(submitRoutineProposal(fixture.env, revoked, proposal)).resolves.toEqual({ ok: false, error: 'run_not_found' })

    fixture.harness.sqlite.exec(`
      UPDATE routine_runs SET status = 'waiting', waiting_reason = 'review', proposal_json = NULL WHERE id = 'run-1';
      UPDATE routine_run_actions SET status = 'waiting', result_json = NULL WHERE run_id = 'run-1' AND action_key = 'revoked';
    `)
    await expect(submitRoutineProposal(fixture.env, revoked, proposal)).resolves.toEqual({ ok: false, error: 'run_not_found' })

    fixture.harness.sqlite.exec(`
      UPDATE routine_runs SET status = 'running', waiting_reason = NULL, proposal_json = NULL WHERE id = 'run-1';
      UPDATE routine_run_actions SET status = 'running' WHERE run_id = 'run-1' AND action_key = 'revoked';
    `)
    await expect(submitRoutineProposal(fixture.env, revoked, proposal)).resolves.toEqual({ ok: false, error: 'run_not_found' })
    const readableButNotRunnable: RoutinePrincipal = {
      ...fixture.principal,
      grants: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    }
    await expect(submitRoutineProposal(fixture.env, readableButNotRunnable, proposal)).resolves.toEqual({ ok: false, error: 'forbidden' })
    const missing = { ...proposal, run_id: 'missing-run' }
    await expect(submitRoutineProposal(fixture.env, revoked, missing)).resolves.toEqual({ ok: false, error: 'run_not_found' })
  })

  it('records an unconfirmed outcome when cancellation races an already claimed action', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.exec(`
      INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json, status)
      VALUES ('action-claimed', 'tenant-a', 'project-1', 'run-1', 'claimed', 'no_action', '{"reason":"in flight"}', 'running');
    `)
    const administrator: RoutinePrincipal = {
      ...fixture.principal, actor_type: 'member', actor_id: 'owner-1', workspace_admin: true,
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }
    await expect(cancelRoutineRun(fixture.env, administrator, 'run-1')).resolves.toEqual({
      ok: true, run_id: 'run-1', duplicate: false, outcome: 'unconfirmed',
    })
    expect(row(fixture, "SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'failed', result_summary: 'cancellation_unconfirmed',
    })
    expect(row(fixture, "SELECT status FROM routine_run_actions WHERE id = 'action-claimed'")).toEqual({ status: 'cancelled' })
    expect(row(fixture, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'failed' })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'blocked' })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'cancellation_requested'")).toEqual({ count: 1 })
    expect(row(fixture, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'cancellation_unconfirmed'")).toEqual({ count: 1 })
    await expect(cancelRoutineRun(fixture.env, administrator, 'run-1')).resolves.toEqual({
      ok: true, run_id: 'run-1', duplicate: true, outcome: 'unconfirmed',
    })
  })

  it('records an unconfirmed child-completion race and leaves an already terminal run untouched', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const administrator: RoutinePrincipal = {
      ...fixture.principal, actor_type: 'member', actor_id: 'owner-1', workspace_admin: true,
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }
    fixture.harness.sqlite.exec("UPDATE flights SET status = 'landed', ended_at = 1752940900000 WHERE id = 'control-flight'")
    await expect(cancelRoutineRun(fixture.env, administrator, 'run-1')).resolves.toMatchObject({ ok: true, outcome: 'unconfirmed' })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'blocked' })
    expect(row(fixture, "SELECT status FROM routine_runs WHERE id = 'run-1'")).toEqual({ status: 'failed' })

    const terminal = await makeReadyRoutineFixture('execute_internal')
    terminal.harness.sqlite.exec("UPDATE routine_runs SET status = 'succeeded', finished_at = '2026-07-19T17:00:00.000Z' WHERE id = 'run-1'")
    await expect(cancelRoutineRun(terminal.env, administrator, 'run-1')).resolves.toEqual({ ok: false, error: 'run_terminal' })
    expect(row(terminal, "SELECT status FROM flights WHERE id = 'control-flight'")).toEqual({ status: 'running' })
    expect(row(terminal, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'in_progress' })
    expect(row(terminal, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind LIKE 'cancellation_%'")).toEqual({ count: 0 })
    terminal.harness.close()
  })
})

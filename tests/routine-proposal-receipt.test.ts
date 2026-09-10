// tests/routine-proposal-receipt.test.ts — 436e1a47 approach 2
//
// receipt_refs is a path-owned typed witness. Routine flights get
// routine.proposal:<runId> when the proposal is STORED, not when land invents one.
// Land of the control flight fail-closes unless that ref RESOLVES to a stored
// routine.proposal/v1 on the run. A well-formed missing id is not a witness.
//
// Schema is applyAllMigrations() only.

import { afterEach, describe, expect, it } from 'vitest'
import { landGovernedFlight } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { submitRoutineProposal } from '../src/routines/actions'
import { applyAllMigrations } from './helpers/migrations'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'tenant-a'
const RUN = 'run-1'
const FLIGHT = 'control-flight'
const TASK = 'control-task'
const DIGEST = 'ab'.repeat(32)
const PROPOSAL_JSON = JSON.stringify({
  version: 'routine.proposal/v1',
  run_id: RUN,
  project_id: 'project-1',
  situation_digest: DIGEST,
  summary: 'This is the next accountable action.',
  action: { key: 'k1', kind: 'no_action', input: { reason: 'none needed' } },
})

let harness: SqliteD1Harness
let env: Env

afterEach(() => {
  harness?.close()
})

function seedControlFlight(opts: { receiptRefs: string[]; proposalJson: string | null }): void {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const meta = JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'routine-1',
    objective_id: RUN,
    squad_ids: ['squad-1'],
    task_ids: [TASK],
    done_when: ['A correlated routine.proposal/v1 is accepted.'],
    artifact_refs: [],
    receipt_refs: opts.receiptRefs,
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
    routine_run_id: RUN,
    routine_revision: 1,
  })
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
    INSERT INTO projects (id, slug, name, status)
      VALUES ('project-1', 'project-1', 'Project One', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-1', 'squad-1', 'write');
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
      timezone, overlap_policy, execution_mode, responsible_squad_id,
      budget_micro_usd, max_attempts, retry_backoff_seconds, revision,
      enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (
      'routine-1', '${TENANT}', 'project-1', 'Next', 'Advance', 'enabled', 'cron', '* * * * *',
      'UTC', 'skip', 'propose', 'squad-1', 100000, 3, 300, 1,
      'owner-1', '2026-07-19T16:00:00.000Z', 'owner-1',
      '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
    );
    INSERT INTO tasks (id, squad_id, project_id, title, status, created_at, updated_at)
      VALUES ('${TASK}', 'squad-1', 'project-1', 'Routine control', 'done',
              '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z');
    INSERT INTO flights (
      id, tenant, project_id, agent, goal, status, trigger_source, gate_verdict,
      score, budget_micro_usd, cost_micro_usd, created_at, started_at, meta
    ) VALUES (
      '${FLIGHT}', '${TENANT}', 'project-1', 'agent-1', 'Advance the Project',
      'running', 'schedule', 'go', 1, 100000, 0, 1752940800000, 1752940800000,
      '${meta.replaceAll("'", "''")}'
    );
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, status, attempt, assigned_agent_id, task_id, flight_id,
      proposal_json, created_at, updated_at
    ) VALUES (
      '${RUN}', '${TENANT}', 'project-1', 'routine-1', 1,
      '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":null,"budget_micro_usd":100000,"max_attempts":3,"retry_backoff_seconds":300}',
      'manual:test', 'cron', 'running', 1, 'agent-1', '${TASK}', '${FLIGHT}',
      ${opts.proposalJson === null ? 'NULL' : `'${opts.proposalJson.replaceAll("'", "''")}'`},
      '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

async function landControl() {
  const raw = harness.sqlite.prepare(`SELECT meta FROM flights WHERE id = ?`).get(FLIGHT) as { meta: string }
  const meta = parseFlightMetaV1(JSON.parse(raw.meta))
  if (!meta) throw new Error('meta must parse')
  return landGovernedFlight(env, FLIGHT, {
    cost_micro_usd: 0,
    score: 1,
    expected_agent: 'agent-1',
    agent_id: 'agent-1',
    meta,
    actor: { kind: 'agent', id: 'agent-1' },
  })
}

describe('436e1a47 routine.proposal receipt witness', () => {
  it('writes routine.proposal:<runId> onto the control flight when the proposal is stored', async () => {
    const fixture: ReadyRoutineFixture = await makeReadyRoutineFixture('propose')
    harness = fixture.harness
    const submitted = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'review-1',
      kind: 'request_review',
      input: { source_type: 'flight', source_id: 'control-flight', summary: 'Please review the run.' },
    }))
    expect(submitted.ok).toBe(true)

    const row = fixture.harness.sqlite.prepare(
      `SELECT meta, proposal_json FROM flights f
         JOIN routine_runs r ON r.flight_id = f.id
        WHERE f.id = 'control-flight'`,
    ).get() as { meta: string; proposal_json: string }
    const meta = JSON.parse(row.meta) as { receipt_refs: string[] }
    expect(row.proposal_json).toBeTruthy()
    expect(JSON.parse(row.proposal_json).version).toBe('routine.proposal/v1')
    expect(meta.receipt_refs).toContain(`routine.proposal:${RUN}`)
  })

  it('fail-closed: control land does not transition when the proposal ref is missing', async () => {
    seedControlFlight({ receiptRefs: [], proposalJson: null })
    const result = await landControl()
    expect(result.transitioned).toBe(false)
    const status = harness.sqlite.prepare(`SELECT status FROM flights WHERE id = ?`).get(FLIGHT) as { status: string }
    expect(status.status).toBe('running')
  })

  it('fail-closed: a well-formed routine.proposal:<id> that does not resolve is not a witness', async () => {
    seedControlFlight({
      receiptRefs: ['routine.proposal:does-not-exist'],
      proposalJson: PROPOSAL_JSON,
    })
    const result = await landControl()
    expect(result.transitioned).toBe(false)
    const status = harness.sqlite.prepare(`SELECT status FROM flights WHERE id = ?`).get(FLIGHT) as { status: string }
    expect(status.status).toBe('running')
  })

  it('positive control: control land succeeds when the ref is present and resolves to the stored proposal', async () => {
    seedControlFlight({
      receiptRefs: [`routine.proposal:${RUN}`],
      proposalJson: PROPOSAL_JSON,
    })
    const result = await landControl()
    expect(result).toEqual({ transitioned: true, receipt: true })
    const status = harness.sqlite.prepare(`SELECT status FROM flights WHERE id = ?`).get(FLIGHT) as { status: string }
    expect(status.status).toBe('landed')
  })
})

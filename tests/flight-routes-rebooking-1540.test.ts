// tests/flight-routes-rebooking-1540.test.ts — mupot#1540 C on the org-admin REST twin.
//
// POST /api/flights must apply the SAME duplicate-booking guards as the MCP
// flight_dispatch tool (src/flight/rebooking.ts — one predicate, two surfaces).
// Real SQLite over the whole migration chain, real member-bearer org-admin auth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flightsApp } from '../src/flight/routes'
import { hashMemberToken } from '../src/auth/member-bearer'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'pot-1540-rest'
const TOKEN = 'mupot_rest_1540_admin_token'

const signals = {
  contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 100, budgetEstimateMicroUsd: 0,
  recentProgress: 0.9, progressPerStep: 0.8, wastePerStep: 0.1, stepSeconds: 5,
}

function body(taskIds: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'agent-a',
    goal: 'REST booking',
    budget_micro_usd: 0,
    meta: {
      schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: ['squad-a'],
      task_ids: taskIds, done_when: ['done'], artifact_refs: [], receipt_refs: [],
      confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
    },
    signals,
    ...extra,
  }
}

let harness: SqliteD1Harness
let env: Env

async function post(payload: Record<string, unknown>) {
  const response = await flightsApp.request('https://pot.test/', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, env)
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

function count(sql: string): number {
  return Number((harness.sqlite.prepare(sql).get() as { n: number }).n)
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-admin', 'a@test', 'Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'member-admin', 'org', NULL, 'admin');
    INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('task-1', 'squad-a', 'T1', 'done', 'done');
    INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('task-2', 'squad-a', 'T2', 'done', 'in_progress');
    INSERT INTO flights (id, tenant, agent, goal, status, meta)
    VALUES ('flight-landed', '${TENANT}', 'agent-a', 'g', 'landed',
            '{"schema":"mupot.flight.meta/v1","task_ids":["task-1"],"squad_ids":["squad-a"]}');
  `)
  harness.sqlite
    .prepare(`INSERT INTO member_tokens (id, member_id, token_hash, revoked_at, agent_id, tenant) VALUES ('tok', 'member-admin', ?, NULL, NULL, ?)`)
    .run(await hashMemberToken(TOKEN), TENANT)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})

afterEach(() => harness.close())

describe('POST /api/flights duplicate-booking guards (mupot#1540 C)', () => {
  it('refuses a task that already landed, naming the landed flight', async () => {
    const res = await post(body(['task-1']))
    expect(res).toMatchObject({
      status: 409,
      json: { error: 'flight_task_already_landed', landed_flight_ids: ['flight-landed'], task_ids: ['task-1'] },
    })
    expect(count('SELECT COUNT(*) AS n FROM flights')).toBe(1)
  })

  it('an explicit override dispatches and is receipted against the new flight as the admin member', async () => {
    const res = await post(body(['task-1'], { redispatch_landed_reason: 'brain re-measure' }))
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const receipt = harness.sqlite.prepare('SELECT * FROM flight_redispatch_receipts').get() as Record<string, unknown>
    expect(receipt).toMatchObject({ flight_id: res.json.id, actor_kind: 'member', actor_id: 'member-admin', reason: 'brain re-measure' })
  })

  it('the same client_request_id returns the original flight, one row', async () => {
    const first = await post(body(['task-2'], { client_request_id: 'brain-7' }))
    expect(first.status, JSON.stringify(first.json)).toBe(201)
    const again = await post(body(['task-2'], { client_request_id: 'brain-7' }))
    expect(again).toMatchObject({ status: 200, json: { id: first.json.id, idempotent_replay: true } })
    expect(count(`SELECT COUNT(*) AS n FROM flights WHERE id <> 'flight-landed'`)).toBe(1)
    const conflict = await post(body(['task-2'], { client_request_id: 'brain-7', goal: 'different' }))
    expect(conflict).toMatchObject({ status: 409, json: { error: 'client_request_id_conflict', flight_id: first.json.id } })
  })
})

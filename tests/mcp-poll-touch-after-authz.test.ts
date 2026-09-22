// tests/mcp-poll-touch-after-authz.test.ts — mupot#1494 round 2 adversarial gate (P2-i).
// touchPollFleetPresence must run AFTER every 400/403/404 refusal in task_list, inbox, and
// inbox_lease — never before. A refused call must not refresh liveness (a caller probing for
// a live TTL window via a request it knows will be refused must learn nothing). Exercised
// against REAL SQLite + the full migration chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const FORBIDDEN_SQUAD_ID = 'squad-2'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-uuid-poller'
const T0 = '2026-09-01T00:00:00.000Z'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function auth(): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite'], staleAt: string): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_ID}', '${DEPT_ID}', 'squad-one', 'Squad One'),
      ('${FORBIDDEN_SQUAD_ID}', '${DEPT_ID}', 'squad-two', 'Squad Two');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
      VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'poller-agent', 'Poller Agent', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Poller', 'active', '${TENANT}');
    INSERT INTO fleet_agents (
      agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type,
      presence_mode, presence_ttl_sec, last_reported_at, updated_at
    ) VALUES (
      '${AGENT_ID}', '${TENANT}', 'Poller', '', '[]', 'on_demand', 'running', '${AGENT_ID}', 'generic',
      'poll', 600, '${staleAt}', '${staleAt}'
    );
  `)
}

function lastReportedAt(): string {
  const row = harness.sqlite.prepare(
    'SELECT last_reported_at FROM fleet_agents WHERE tenant = ? AND agent_id = ?',
  ).get(TENANT, AGENT_ID) as { last_reported_at: string }
  return row.last_reported_at
}

describe('touchPollFleetPresence runs AFTER authz, never before (mupot#1494 round 2, P2-i)', () => {
  let staleAt: string

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    staleAt = sqliteStamp(Date.now() - 300_000) // 5 min ago
    seed(harness.sqlite, staleAt)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  })

  afterEach(() => harness.close())

  it('a REFUSED task_list (squad the caller has no capability on) leaves last_reported_at unchanged', async () => {
    const res = await invokeTool(auth(), env, 'task_list', { squad_id: FORBIDDEN_SQUAD_ID }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(lastReportedAt()).toBe(staleAt)
  })

  it('a SUCCESSFUL task_list DOES refresh last_reported_at', async () => {
    const res = await invokeTool(auth(), env, 'task_list', { squad_id: SQUAD_ID }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(lastReportedAt()).not.toBe(staleAt)
  })

  it('a REFUSED inbox call (invalid arg) leaves last_reported_at unchanged', async () => {
    const res = await invokeTool(auth(), env, 'inbox', { limit: 'not-a-number' as unknown as number }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(lastReportedAt()).toBe(staleAt)
  })

  it('a SUCCESSFUL inbox call DOES refresh last_reported_at', async () => {
    const res = await invokeTool(auth(), env, 'inbox', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(lastReportedAt()).not.toBe(staleAt)
  })

  it('a REFUSED inbox_lease call (invalid arg) leaves last_reported_at unchanged', async () => {
    const res = await invokeTool(auth(), env, 'inbox_lease', { lease_seconds: 'nope' as unknown as number }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(lastReportedAt()).toBe(staleAt)
  })

  it('a SUCCESSFUL inbox_lease call DOES refresh last_reported_at', async () => {
    const res = await invokeTool(auth(), env, 'inbox_lease', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(lastReportedAt()).not.toBe(staleAt)
  })
})

// tests/poll-presence-touch-ordering.test.ts — mupot#1494 round 3 (P2-c). Real sqlite D1 + the
// full migration chain. touchPollFleetPresence must be the LAST thing on a SUCCESS path only,
// for inbox/inbox_lease/task_list — a refusal at ANY layer (tool-layer 400/403, or an
// in-function/service-layer refusal) must leave last_reported_at untouched. Round 2's own fix
// (P2-i) only enumerated the tool layer; inbox_lease({attempt_id:'x'}) still refused 400
// invalid_attempt from WITHIN leaseAgentInbox (a service-layer refusal) AFTER the touch had
// already run.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const MEMBER_ID = 'member-touch-1'
const DEPT_ID = 'dept-touch-1'
const SQUAD_ID = 'squad-touch-1'
const AGENT_ID = 'agent-touch-uuid'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: 'token-touch-1',
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'touch-dept', 'Touch Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'touch-squad', 'Touch Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
    VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'touch-runner', 'Touch Runner', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
    INSERT INTO members (id, display_name, email, status, tenant)
    VALUES ('${MEMBER_ID}', 'Touch Operator', 'touch@example.com', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-08-01T00:00:00Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
    VALUES ('token-touch-1', '${MEMBER_ID}', '${'a'.repeat(64)}', 'touch', 'workspace', '2026-08-01T00:00:00Z', '${AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z');
  `)
}

function fleetRow(): Record<string, unknown> | undefined {
  return harness.sqlite.prepare('SELECT * FROM fleet_agents WHERE tenant = ? AND agent_id = ?').get(TENANT, AGENT_ID) as
    | Record<string, unknown>
    | undefined
}

/** Poll-register the agent, then backdate last_reported_at so a later "still backdated" check
 *  proves nothing touched it. */
async function establishPollAndBackdate(backSeconds = 120): Promise<string> {
  await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
  const backdated = sqliteStamp(Date.now() - backSeconds * 1000)
  harness.sqlite.prepare(`UPDATE fleet_agents SET last_reported_at = ? WHERE tenant = ? AND agent_id = ?`)
    .run(backdated, TENANT, AGENT_ID)
  return backdated
}

describe('touchPollFleetPresence ordering — last thing on success only (mupot#1494 round 3, P2-c)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: { get: async () => null, put: async () => {} } } as unknown as Env
  })
  afterEach(() => harness.close())

  it('inbox_lease: a SERVICE-layer refusal (invalid_attempt, from inside leaseAgentInbox) leaves last_reported_at unchanged', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'inbox_lease', { attempt_id: 'x', limit: 1 }, 'https://pot.example')
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ status: 400, error: 'invalid_attempt' })

    expect(fleetRow()!.last_reported_at).toBe(backdated)
  })

  it('inbox_lease: a TOOL-layer refusal (not_agent_bound) leaves last_reported_at unchanged', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth({ boundAgentId: undefined }), env, 'inbox_lease', {}, 'https://pot.example')
    expect(res).toMatchObject({ ok: false, status: 403, error: 'not_agent_bound' })

    expect(fleetRow()!.last_reported_at).toBe(backdated)
  })

  it('inbox_lease: a SUCCESSFUL lease (even of an empty inbox) DOES refresh last_reported_at', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'inbox_lease', {}, 'https://pot.example')
    expect(res.ok).toBe(true)

    expect(fleetRow()!.last_reported_at).not.toBe(backdated)
  })

  it('inbox: a TOOL-layer refusal (invalid_args on since_seq without peek) leaves last_reported_at unchanged', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'inbox', { since_seq: 1 }, 'https://pot.example')
    expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })

    expect(fleetRow()!.last_reported_at).toBe(backdated)
  })

  it('inbox: a SUCCESSFUL read (even of an empty inbox) DOES refresh last_reported_at', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'inbox', {}, 'https://pot.example')
    expect(res.ok).toBe(true)

    expect(fleetRow()!.last_reported_at).not.toBe(backdated)
  })

  it('task_list: a TOOL-layer refusal (invalid_status) leaves last_reported_at unchanged', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'task_list', { status: 'not-a-real-status' }, 'https://pot.example')
    expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_status' })

    expect(fleetRow()!.last_reported_at).toBe(backdated)
  })

  it('task_list: a SUCCESSFUL list (even an empty one) DOES refresh last_reported_at', async () => {
    const backdated = await establishPollAndBackdate()

    const res = await invokeTool(auth(), env, 'task_list', {}, 'https://pot.example')
    expect(res.ok).toBe(true)

    expect(fleetRow()!.last_reported_at).not.toBe(backdated)
  })
})

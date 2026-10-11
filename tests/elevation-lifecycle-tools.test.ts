// A live elevation grant lets an agent-bound caller use the member-only
// lifecycle tools through the same predicate mint/grant use (hasElevatedAction):
//   routine_enable/pause/archive/update -> action:workspace_project (routine's squad)
//   project_update (status only), unarchive_row (projects/squads)
//                                        -> action:project_lifecycle
// Real migration chain + the real tool surface (invokeTool); no mocked D1.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  createElevationRequest,
  decideElevationRequest,
  listElevationUsage,
  type ElevationGrantRecord,
} from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'

const TENANT = 'tenant-elevlife'
const ORIGIN = 'https://pot.test'
const DEPT_ID = 'dept-1'
const HOME_SQUAD = 'squad-home'
const TARGET_SQUAD = 'squad-target'
const OTHER_SQUAD = 'squad-other'
const AGENT_ID = 'agent-acting'
const AGENT_MEMBER = 'member-acting'
const TOKEN_ID = 'tok-acting'
const ADMIN = 'member-admin'
const ADMIN_IDENTITY = 'identity-admin'
const OPERATOR = 'member-operator'

let harness: SqliteD1Harness
let env: Env
let routineTarget = ''
let routineOther = ''

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

const orgAdminGrant: CapabilityGrant = { member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }

function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR, memberId: OPERATOR, email: null, role: 'member', tenant: TENANT,
    channel: 'workspace', boundAgentId: null, capabilities: [orgAdminGrant],
  } as unknown as AuthContext
}

function agentAuth(): AuthContext {
  return {
    userId: AGENT_MEMBER, memberId: AGENT_MEMBER, email: null, role: 'member', tenant: TENANT,
    channel: 'workspace', boundAgentId: AGENT_ID, tokenId: TOKEN_ID, capabilities: [],
  } as unknown as AuthContext
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD}', '${DEPT_ID}', 'home', 'Home'),
      ('${TARGET_SQUAD}', '${DEPT_ID}', 'target', 'Target'),
      ('${OTHER_SQUAD}', '${DEPT_ID}', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${HOME_SQUAD}', 'acting', 'Acting', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${AGENT_MEMBER}', 'Acting', 'active', '${TENANT}'),
      ('${ADMIN}', 'Admin', 'active', '${TENANT}'),
      ('${OPERATOR}', 'Operator', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', '2026-08-05T00:00:00Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('${TOKEN_ID}', '${AGENT_MEMBER}', 'hash-acting', 'primary', 'workspace', '${TENANT}', '${AGENT_ID}', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-admin-target', '${ADMIN}', 'squad', '${TARGET_SQUAD}', 'admin'),
      ('cap-admin-other', '${ADMIN}', 'squad', '${OTHER_SQUAD}', 'admin');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${ADMIN_IDENTITY}', '${TENANT}', 'google', '${ADMIN}', 'admin@x.test', '${ADMIN}', datetime('now'));
    INSERT INTO projects (id, slug, name, status) VALUES
      ('proj-target', 'proj-target', 'Target project', 'active'),
      ('proj-other', 'proj-other', 'Other project', 'active'),
      ('proj-planned', 'proj-planned', 'Planned project', 'planned');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('proj-target', '${TARGET_SQUAD}', 'write'),
      ('proj-other', '${OTHER_SQUAD}', 'write'),
      ('proj-planned', '${TARGET_SQUAD}', 'write');
  `)
}

async function createRoutine(projectId: string, squadId: string): Promise<string> {
  const res = await invokeTool(operatorAuth(), env, 'routine_create', {
    project_id: projectId, name: 'Keep momentum', objective: 'Choose one next action', trigger_kind: 'manual',
    timezone: 'UTC', responsible_squad_id: squadId, budget_micro_usd: 250_000,
  }, ORIGIN)
  if (!res.ok) throw new Error(`setup: routine_create failed: ${JSON.stringify(res)}`)
  return (res.result as { routine: { id: string } }).routine.id
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(agentAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

async function approve(
  sessionId: string,
  action: string,
  scope: { type: 'squad'; id: string },
  minutes: number,
  nowMs: number,
): Promise<ElevationGrantRecord> {
  const web = await createWebSession(env, `raw-${nowMs}-${action}-${scope.id}`, { tenant: TENANT, memberId: ADMIN, loginIdentityId: ADMIN_IDENTITY }, nowMs)
  const created = await createElevationRequest(env, {
    tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
    actions: [action], scopeType: scope.type, scopeId: scope.id, durationMinutes: minutes, reason: 'lifecycle tools test',
  }, nowMs)
  if (!created.ok) throw new Error(`setup: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(env, {
    tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: [action],
    decidedByMemberId: ADMIN,
    decidedByCapabilities: [{ member_id: ADMIN, scope_type: 'squad', scope_id: scope.id, capability: 'admin' }],
    decidedByWebSessionHash: web.id_hash, recentReauthOk: true,
  }, nowMs)
  if (!decision.ok) throw new Error(`setup: decide failed: ${JSON.stringify(decision)}`)
  return decision.grants[0]
}

function expectRefused(res: Awaited<ReturnType<typeof invokeTool>>): void {
  expect(res.ok).toBe(false)
  if (!res.ok) expect(res.status).toBe(403)
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db, PUBLIC_ORIGIN: ORIGIN, SESSIONS: memoryKv() } as unknown as Env
  routineTarget = await createRoutine('proj-target', TARGET_SQUAD)
  routineOther = await createRoutine('proj-other', OTHER_SQUAD)
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('routine_enable/pause/archive/update under action:workspace_project', () => {
  it('a member (unbound org admin) still passes unchanged', async () => {
    const res = await invokeTool(operatorAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    expect(res.ok).toBe(true)
  })

  it('an agent-bound caller with no grant is refused with the request_elevation hint', async () => {
    await checkIn()
    const res = await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    expectRefused(res)
    if (!res.ok) expect(JSON.stringify(res.detail)).toContain('action:workspace_project')
  })

  it('an EXPIRED grant is refused', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    vi.setSystemTime(t0)
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 15, t0)
    vi.setSystemTime(t0 + 16 * 60 * 1000)
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN))
  })

  it('a live grant on the routine squad passes enable/pause/update/archive and the usage row carries the grant id', async () => {
    const sessionId = await checkIn()
    const grant = await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())

    const enable = await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    expect(enable.ok).toBe(true)
    expect((await invokeTool(agentAuth(), env, 'routine_pause', { routine_id: routineTarget }, ORIGIN)).ok).toBe(true)
    const update = await invokeTool(agentAuth(), env, 'routine_update', { routine_id: routineTarget, name: 'Renamed' }, ORIGIN)
    expect(update.ok).toBe(true)
    expect((await invokeTool(agentAuth(), env, 'routine_archive', { routine_id: routineTarget }, ORIGIN)).ok).toBe(true)

    const usage = await listElevationUsage(env, TENANT, grant.id)
    const tools = usage.map((u) => u.tool_name).sort()
    expect(tools).toEqual(['routine_archive', 'routine_enable', 'routine_pause', 'routine_update'])
    expect(usage.every((u) => u.elevation_grant_id === grant.id && u.action === 'action:workspace_project')).toBe(true)
    expect(usage.every((u) => JSON.parse(u.detail_json as string).routine_id === routineTarget)).toBe(true)
    const row = await env.DB.prepare('SELECT enabled_by FROM routines WHERE id = ?1').bind(routineTarget).first<{ enabled_by: string }>()
    expect(row?.enabled_by).toBe(AGENT_ID)
  })

  it('a live grant on a DIFFERENT squad is refused and nothing changes', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineOther }, ORIGIN))
    const row = await env.DB.prepare('SELECT status FROM routines WHERE id = ?1').bind(routineOther).first<{ status: string }>()
    expect(row?.status).toBe('draft')
  })

  it('a grant for a DIFFERENT action is refused', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN))
  })

  it('routine_update cannot move a routine onto a squad the grant does not cover', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    const res = await invokeTool(agentAuth(), env, 'routine_update', { routine_id: routineTarget, responsible_squad_id: OTHER_SQUAD }, ORIGIN)
    expectRefused(res)
    const row = await env.DB.prepare('SELECT responsible_squad_id FROM routines WHERE id = ?1').bind(routineTarget).first<{ responsible_squad_id: string }>()
    expect(row?.responsible_squad_id).toBe(TARGET_SQUAD)
  })

  it('routine_create stays member-only even with a live grant', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    const res = await invokeTool(agentAuth(), env, 'routine_create', {
      project_id: 'proj-target', name: 'x', objective: 'y', trigger_kind: 'manual', timezone: 'UTC',
      responsible_squad_id: TARGET_SQUAD, budget_micro_usd: 1,
    }, ORIGIN)
    expectRefused(res)
  })
})

describe('project_update status under action:project_lifecycle', () => {
  it('a member still passes unchanged', async () => {
    const res = await invokeTool(operatorAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)
    expect(res.ok).toBe(true)
  })

  it('no grant -> 403 with the hint', async () => {
    await checkIn()
    const res = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)
    expectRefused(res)
    if (!res.ok) expect(JSON.stringify(res.detail)).toContain('action:project_lifecycle')
  })

  it('expired grant -> 403', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    vi.setSystemTime(t0)
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 15, t0)
    vi.setSystemTime(t0 + 16 * 60 * 1000)
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN))
  })

  it('live grant on the project squad passes, is logged with the grant id, and only status may change', async () => {
    const sessionId = await checkIn()
    const grant = await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    const res = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)
    expect(res.ok).toBe(true)
    const row = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind('proj-target').first<{ status: string }>()
    expect(row?.status).toBe('paused')
    const usage = await listElevationUsage(env, TENANT, grant.id)
    expect(usage.map((u) => u.tool_name)).toEqual(['project_update'])
    expect(JSON.parse(usage[0].detail_json as string)).toMatchObject({ project_id: 'proj-target', status: 'paused' })

    const rename = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', name: 'Renamed' }, ORIGIN)
    expectRefused(rename)
    const mixed = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'active', name: 'Renamed' }, ORIGIN)
    expectRefused(mixed)
  })

  it('live grant for a squad the project is NOT attached to -> 403, status unchanged', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-other', status: 'paused' }, ORIGIN))
    const row = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind('proj-other').first<{ status: string }>()
    expect(row?.status).toBe('active')
  })

  it('grant for a different action -> 403', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN))
  })

  it('an elevated caller cannot trigger the planned -> active start gate', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-planned', status: 'active' }, ORIGIN))
    const row = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind('proj-planned').first<{ status: string }>()
    expect(row?.status).toBe('planned')
  })
})

describe('unarchive_row under action:project_lifecycle', () => {
  beforeEach(async () => {
    for (const id of ['proj-target', 'proj-other']) {
      const res = await invokeTool(operatorAuth(), env, 'archive_row', { table: 'projects', id, reason: 'setup' }, ORIGIN)
      if (!res.ok) throw new Error(`setup: archive project ${id}: ${JSON.stringify(res)}`)
    }
    // Squads hold admin capability rows (active_dependents), so archive them directly.
    harness.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id IN ('${TARGET_SQUAD}', '${OTHER_SQUAD}')`)
  })

  it('a member still passes unchanged', async () => {
    const res = await invokeTool(operatorAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN)
    expect(res.ok).toBe(true)
  })

  it('no grant -> 403 with the hint', async () => {
    await checkIn()
    const res = await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN)
    expectRefused(res)
    if (!res.ok) expect(JSON.stringify(res.detail)).toContain('action:project_lifecycle')
  })

  it('expired grant -> 403', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    vi.setSystemTime(t0)
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 15, t0)
    vi.setSystemTime(t0 + 16 * 60 * 1000)
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN))
  })

  it('live grant: restores the project and the squad, and the receipt names the grant id', async () => {
    const sessionId = await checkIn()
    const grant = await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    const proj = await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN)
    expect(proj.ok).toBe(true)
    const squad = await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'squads', id: TARGET_SQUAD, reason: 'restore squad' }, ORIGIN)
    expect(squad.ok).toBe(true)
    const receipts = await env.DB.prepare(
      `SELECT entity_table, reason FROM archive_receipts WHERE action = 'unarchive' ORDER BY entity_table`,
    ).all<{ entity_table: string; reason: string }>()
    expect(receipts.results.map((r) => r.entity_table)).toEqual(['projects', 'squads'])
    expect(receipts.results.every((r) => r.reason.includes(`[elevation_grant:${grant.id}]`))).toBe(true)
    const usage = await listElevationUsage(env, TENANT, grant.id)
    expect(usage.map((u) => u.tool_name)).toEqual(['unarchive_row', 'unarchive_row'])
  })

  it('live grant on the wrong squad -> 403, row stays archived', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-other', reason: 'restore' }, ORIGIN))
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'squads', id: OTHER_SQUAD, reason: 'restore' }, ORIGIN))
    const row = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind('proj-other').first<{ status: string }>()
    expect(row?.status).toBe('archived')
  })

  it('grant for a different action -> 403', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:workspace_project', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN))
  })

  it('members stay operator-only even with a live grant', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_lifecycle', { type: 'squad', id: TARGET_SQUAD }, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'members', id: ADMIN, reason: 'restore' }, ORIGIN))
  })
})

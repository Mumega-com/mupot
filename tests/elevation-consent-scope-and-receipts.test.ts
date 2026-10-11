// PR #1831 review round 3.
//   F1 consent scope: routine policy and project status/restore have their OWN
//      actions (action:routine_policy, action:project_status). A live grant for
//      the creation-only actions action:project_lifecycle / action:workspace_project
//      must not acquire them.
//   F2 receipt atomicity: elevation_usage_log is a durable two-phase receipt
//      (pending -> applied|failed); the applied flip rides the mutation's own D1
//      batch where we control the write path.
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
  revokeElevationGrant,
  type ElevationGrantRecord,
} from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { beginElevationReceipt } from '../src/auth/elevation-receipt'
import { updateProject } from '../src/projects/service'

const TENANT = 'tenant-elevlife'
const ORIGIN = 'https://pot.test'
const DEPT_ID = 'dept-1'
const HOME_SQUAD = 'squad-home'
const TARGET_SQUAD = 'squad-target'
const OTHER_SQUAD = 'squad-other'
const KIND_HOME_SQUAD = 'squad-kindhome'
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
      ('${OTHER_SQUAD}', '${DEPT_ID}', 'other', 'Other'),
      ('${KIND_HOME_SQUAD}', '${DEPT_ID}', 'kindhome', 'Kind Home');
    UPDATE squads SET kind = 'home' WHERE id = '${KIND_HOME_SQUAD}';
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
      ('cap-admin-other', '${ADMIN}', 'squad', '${OTHER_SQUAD}', 'admin'),
      ('cap-admin-org', '${ADMIN}', 'org', NULL, 'admin');
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
  scope: { type: 'squad'; id: string } | { type: 'org' },
  minutes: number,
  nowMs: number,
): Promise<ElevationGrantRecord> {
  const scopeId = scope.type === 'squad' ? scope.id : ''
  const web = await createWebSession(env, `raw-${nowMs}-${action}-${scope.type}-${scopeId}`, { tenant: TENANT, memberId: ADMIN, loginIdentityId: ADMIN_IDENTITY }, nowMs)
  const created = await createElevationRequest(env, {
    tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
    actions: [action], scopeType: scope.type, scopeId, durationMinutes: minutes, reason: 'lifecycle tools test',
  }, nowMs)
  if (!created.ok) throw new Error(`setup: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(env, {
    tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: [action],
    decidedByMemberId: ADMIN,
    decidedByCapabilities: [{ member_id: ADMIN, scope_type: scope.type, scope_id: scope.type === 'squad' ? scope.id : null, capability: 'admin' }],
    decidedByWebSessionHash: web.id_hash, recentReauthOk: true,
  }, nowMs)
  if (!decision.ok) throw new Error(`setup: decide failed: ${JSON.stringify(decision)}`)
  return decision.grants[0]
}

async function usageRows(): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM elevation_usage_log').first<{ n: number }>()
  return Number(r?.n ?? 0)
}

async function receiptStatuses(): Promise<string[]> {
  const r = await env.DB.prepare('SELECT status FROM elevation_usage_log ORDER BY status').all<{ status: string }>()
  return (r.results ?? []).map((x) => x.status)
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

async function rows(): Promise<Array<{ status: string; error_code: string | null; resolved_at: string | null; tool_name: string | null }>> {
  const r = await env.DB.prepare('SELECT status, error_code, resolved_at, tool_name FROM elevation_usage_log ORDER BY occurred_at').all<{ status: string; error_code: string | null; resolved_at: string | null; tool_name: string | null }>()
  return r.results ?? []
}

async function projectStatus(id: string): Promise<string | undefined> {
  return (await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind(id).first<{ status: string }>())?.status
}

async function routineStatus(id: string): Promise<string | undefined> {
  return (await env.DB.prepare('SELECT status FROM routines WHERE id = ?1').bind(id).first<{ status: string }>())?.status
}

async function archiveProjects(): Promise<void> {
  for (const id of ['proj-target', 'proj-other']) {
    const res = await invokeTool(operatorAuth(), env, 'archive_row', { table: 'projects', id, reason: 'setup' }, ORIGIN)
    if (!res.ok) throw new Error(`setup: archive project ${id}: ${JSON.stringify(res)}`)
  }
}

const ORG = { type: 'org' } as const

describe('F1: consent scope — the new powers are not reachable through the old creation-only actions', () => {
  it.each(['action:project_lifecycle', 'action:workspace_project'])('a live %s ORG grant gets 403 on routine_enable/pause/archive/update and writes nothing', async (action) => {
    const sessionId = await checkIn()
    await approve(sessionId, action, ORG, 60, Date.now())
    for (const [tool, extra] of [['routine_enable', {}], ['routine_pause', {}], ['routine_archive', {}], ['routine_update', { name: 'x' }]] as const) {
      expectRefused(await invokeTool(agentAuth(), env, tool, { routine_id: routineTarget, ...extra }, ORIGIN))
    }
    expect(await routineStatus(routineTarget)).toBe('draft')
    expect(await rows()).toEqual([])
  })

  it.each(['action:project_lifecycle', 'action:workspace_project', 'action:routine_policy'])('a live %s ORG grant gets 403 on project_update status and unarchive_row', async (action) => {
    await archiveProjects()
    const sessionId = await checkIn()
    await approve(sessionId, action, ORG, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-planned', status: 'archived' }, ORIGIN))
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN))
    expect(await projectStatus('proj-target')).toBe('archived')
    expect(await projectStatus('proj-planned')).toBe('planned')
    expect(await rows()).toEqual([])
  })

  it('action:routine_policy: ok on routines, 403 on project status and unarchive', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:routine_policy', ORG, 60, Date.now())
    const enabled = await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    expect(enabled, JSON.stringify(enabled)).toMatchObject({ ok: true })
    await archiveProjects()
    expectRefused(await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-other', status: 'paused' }, ORIGIN))
    expectRefused(await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN))
  })

  it('action:project_status: ok on project status and unarchive (projects, squads), 403 on routines', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    expect((await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)).ok).toBe(true)
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN))
    await archiveProjects()
    harness.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = '${TARGET_SQUAD}'`)
    expect((await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN)).ok).toBe(true)
    expect((await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'squads', id: TARGET_SQUAD, reason: 'restore' }, ORIGIN)).ok).toBe(true)
    expect(await routineStatus(routineTarget)).toBe('draft')
  })

  it('refusal hints name the new action keys', async () => {
    await checkIn()
    const routine = await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    const project = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)
    if (routine.ok || project.ok) throw new Error('expected refusals')
    expect(JSON.stringify(routine.detail)).toContain('action:routine_policy')
    expect(JSON.stringify(project.detail)).toContain('action:project_status')
  })
})

describe('F2: durable two-phase elevation receipt', () => {
  function blockPendingInsert(): void {
    harness.sqlite.exec(`CREATE TRIGGER block_pending BEFORE INSERT ON elevation_usage_log WHEN NEW.status = 'pending'
      BEGIN SELECT RAISE(ABORT, 'forced pending insert failure'); END`)
  }
  function blockAppliedFlip(): void {
    harness.sqlite.exec(`CREATE TRIGGER block_applied BEFORE UPDATE ON elevation_usage_log WHEN NEW.status = 'applied'
      BEGIN SELECT RAISE(ABORT, 'forced applied flip failure'); END`)
  }

  it('success -> exactly one row, status applied, resolved_at set', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:routine_policy', ORG, 60, Date.now())
    expect((await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)).ok).toBe(true)
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'applied', error_code: null, tool_name: 'routine_enable' })
    expect(r[0].resolved_at).not.toBeNull()
  })

  it('usage insert failure BEFORE the mutation -> mutation not attempted (routine, project, unarchive)', async () => {
    await archiveProjects()
    const sessionId = await checkIn()
    await approve(sessionId, 'action:routine_policy', ORG, 60, Date.now())
    await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    blockPendingInsert()
    const a = await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN)
    const b = await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'restore' }, ORIGIN)
    harness.sqlite.exec('DROP TRIGGER block_pending')
    harness.sqlite.exec(`UPDATE projects SET status = 'active' WHERE id = 'proj-planned'`)
    blockPendingInsert()
    const c = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-planned', status: 'paused' }, ORIGIN)
    for (const res of [a, b, c]) {
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('elevation_receipt_failed')
    }
    expect(await routineStatus(routineTarget)).toBe('draft')
    expect(await projectStatus('proj-target')).toBe('archived')
    expect(await projectStatus('proj-planned')).toBe('active')
    const archiveReceipts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM archive_receipts WHERE action = 'unarchive'`).first<{ n: number }>()
    expect(Number(archiveReceipts?.n)).toBe(0)
    expect(await usageRows()).toBe(0)
  })

  it('mutation failure -> row failed with the error code (non-batch and batch paths)', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:routine_policy', ORG, 60, Date.now())
    await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    expect((await invokeTool(agentAuth(), env, 'routine_pause', { routine_id: routineTarget }, ORIGIN)).ok).toBe(false)
    expect((await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'bogus' }, ORIGIN)).ok).toBe(false)
    expect((await invokeTool(agentAuth(), env, 'unarchive_row', { table: 'projects', id: 'proj-target', reason: 'not archived' }, ORIGIN)).ok).toBe(true) // noop
    const r = await rows()
    expect(r.map((x) => x.status)).toEqual(['failed', 'failed', 'failed'])
    expect(r.every((x) => x.error_code !== null && x.resolved_at !== null)).toBe(true)
    expect(r.find((x) => x.tool_name === 'project_update')?.error_code).toBe('invalid_status')
  })

  it('batch path (project_update): the applied flip and the mutation are ONE batch — a failing flip rolls the status change back', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    blockAppliedFlip()
    try {
      const res = await invokeTool(agentAuth(), env, 'project_update', { project_id: 'proj-target', status: 'paused' }, ORIGIN)
      expect(res.ok).toBe(false)
    } catch {
      // an unhandled throw also refuses the call; the state assertions below are the point
    }
    expect(await projectStatus('proj-target')).toBe('active')
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('failed')
    expect(r[0].error_code).toBe('exception')
  })

  it('batch path (unarchive): a failing flip rolls the restore AND its archive receipt back', async () => {
    await archiveProjects()
    harness.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = '${TARGET_SQUAD}'`)
    const sessionId = await checkIn()
    await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    blockAppliedFlip()
    for (const [table, id] of [['projects', 'proj-target'], ['squads', TARGET_SQUAD]] as const) {
      try {
        const res = await invokeTool(agentAuth(), env, 'unarchive_row', { table, id, reason: 'restore' }, ORIGIN)
        expect(res.ok).toBe(false)
      } catch {
        // an unhandled throw is also a refusal of the call; the state assertions below are the point
      }
    }
    expect(await projectStatus('proj-target')).toBe('archived')
    const squad = await env.DB.prepare('SELECT status FROM squads WHERE id = ?1').bind(TARGET_SQUAD).first<{ status: string }>()
    expect(squad?.status).toBe('archived')
    const receipts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM archive_receipts WHERE action = 'unarchive'`).first<{ n: number }>()
    expect(Number(receipts?.n)).toBe(0)
    expect((await rows()).map((x) => x.status)).toEqual(['failed', 'failed'])
  })

  it('a refused call writes nothing (no grant / wrong action)', async () => {
    const sessionId = await checkIn()
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN))
    await approve(sessionId, 'action:workspace_project', ORG, 60, Date.now())
    expectRefused(await invokeTool(agentAuth(), env, 'routine_enable', { routine_id: routineTarget }, ORIGIN))
    expect(await rows()).toEqual([])
  })

  it('elevation_status reports pending receipts older than 10 minutes as stuck_receipts (fresh/applied are not)', async () => {
    const sessionId = await checkIn()
    const grant = await approve(sessionId, 'action:routine_policy', ORG, 60, Date.now())
    const ins = (id: string, status: string, ageMin: number) =>
      harness.sqlite.exec(`INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, occurred_at, status)
        VALUES ('${id}', '${TENANT}', '${grant.id}', '${sessionId}', 'action:routine_policy', 'routine_enable', '${new Date(Date.now() - ageMin * 60_000).toISOString()}', '${status}')`)
    ins('old-pending', 'pending', 11)
    ins('fresh-pending', 'pending', 2)
    ins('old-applied', 'applied', 30)
    ins('old-failed', 'failed', 30)
    const res = await invokeTool(agentAuth(), env, 'elevation_status', {}, ORIGIN)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const stuck = (res.result as { stuck_receipts: Array<{ id: string }> }).stuck_receipts
      expect(stuck.map((s) => s.id)).toEqual(['old-pending'])
    }
  })

  it('P1-C: two competing elevated project_update calls (same read version, same ms updated_at) -> exactly ONE applied; the loser fails and its status is never recorded applied', async () => {
    const sessionId = await checkIn()
    const grant = await approve(sessionId, 'action:project_status', ORG, 60, Date.now())
    const r1 = await beginElevationReceipt(env, TENANT, grant, 'project_update', { status: 'paused' })
    const r2 = await beginElevationReceipt(env, TENANT, grant, 'project_update', { status: 'archived' })
    // Pin the clock so both competitors compute the SAME updated_at (the winner's
    // timestamp then equals the loser's, which is what defeated a timestamp guard).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    const [a, b] = await Promise.all([
      updateProject(env, 'proj-target', { status: 'paused' }, { elevationReceiptId: r1 }),
      updateProject(env, 'proj-target', { status: 'archived' }, { elevationReceiptId: r2 }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const winnerReceipt = a.ok ? r1 : r2
    const loserReceipt = a.ok ? r2 : r1
    const status = async (id: string) => (await env.DB.prepare('SELECT status FROM elevation_usage_log WHERE id = ?1').bind(id).first<{ status: string }>())?.status
    expect(await status(winnerReceipt)).toBe('applied')
    expect(await status(loserReceipt)).toBe('pending') // never 'applied' for a statement that changed 0 rows
    expect(await projectStatus('proj-target')).toBe(a.ok ? 'paused' : 'archived')
  })
})

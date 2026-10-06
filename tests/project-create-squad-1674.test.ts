// tests/project-create-squad-1674.test.ts — mupot#1674 customer-zero walk fixes.
// Fixture lifted from elevation-squad-lead-e2e.test.ts (same real-SQLite D1 + real approve flow).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { ELEVATION_ACTIONS } from '../src/auth/elevation-actions'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { resolveCapabilities } from '../src/auth/capability'

const TENANT = 'tenant-goal'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-eng'
const LEAD_SQUAD_ID = 'squad-mcpwp'      // the lead's OWN squad
const OTHER_SQUAD_ID = 'squad-core'      // somebody else's squad — must stay shut
const OTHER_DEPT_ID = 'dept-finance'     // somebody else's department — must stay shut

const LEAD_AGENT_ID = 'agent-lead'
const LEAD_MEMBER_ID = 'member-lead'
const LEAD_TOKEN_ID = 'tok-lead-1'

const APPROVER_MEMBER_ID = 'member-approver'
const APPROVER_IDENTITY_ID = 'identity-approver'

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('${DEPT_ID}', 'eng', 'Engineering'),
      ('${OTHER_DEPT_ID}', 'finance', 'Finance');

    -- LIFT THE PLAN QUOTA. On the free tier maxDepartments/maxSquads are 1, so
    -- create_department and create_squad return a 400 quota refusal that reads
    -- EXACTLY like an authorization gate holding. Every "cannot" below has to
    -- fail for the right reason, so the quota is taken out of the picture first.
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${LEAD_SQUAD_ID}', '${DEPT_ID}', 'mcpwp', 'MCPWP'),
      ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'core', 'Core Platform');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES ('${LEAD_AGENT_ID}', '${LEAD_SQUAD_ID}', 'cairn-like', 'Squad Lead', 'active');

    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${LEAD_MEMBER_ID}', 'Squad Lead Member', 'active', '${TENANT}'),
      ('${APPROVER_MEMBER_ID}', 'Approver', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES ('${TENANT}', '${LEAD_AGENT_ID}', '${LEAD_MEMBER_ID}', '2026-09-01T00:00:00Z');

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
    VALUES ('${LEAD_TOKEN_ID}', '${LEAD_MEMBER_ID}', 'hash-lead-1', 'primary', 'workspace', '${TENANT}', '${LEAD_AGENT_ID}', datetime('now'));

    -- THE ENTIRE STANDING AUTHORITY OF THE LEAD: 'lead' on its OWN squad.
    -- No org row. No department row. No admin anywhere. This one row is the
    -- premise of the whole file.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-lead-own', '${LEAD_MEMBER_ID}', 'squad', '${LEAD_SQUAD_ID}', 'lead');

    -- The human. ORG-scope admin, which inherits to department and squad.
    --
    -- It has to be org scope, and that is itself a finding worth stating: an
    -- approver may never approve above their OWN authority, so a DEPARTMENT
    -- admin cannot approve the org-scoped action:project_lifecycle that
    -- project_create requires (measured: decideElevationRequest returns
    -- forbidden need:'admin' scope:{type:'org'}). Projects are workspace
    -- objects, so authorizing one is an org-level act no matter who asks.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-approver', '${APPROVER_MEMBER_ID}', 'org', NULL, 'admin');

    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
    VALUES ('${APPROVER_IDENTITY_ID}', '${TENANT}', 'google', '${APPROVER_MEMBER_ID}', 'approver@x.test', '${APPROVER_MEMBER_ID}', datetime('now'));
  `)
}

function leadAuth(): AuthContext {
  return {
    userId: LEAD_MEMBER_ID,
    memberId: LEAD_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: LEAD_AGENT_ID,
    tokenId: LEAD_TOKEN_ID,
    capabilities: [
      { member_id: LEAD_MEMBER_ID, scope_type: 'squad', scope_id: LEAD_SQUAD_ID, capability: 'lead' },
    ],
  } as unknown as AuthContext
}

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(leadAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

/** The human approval step, at an explicit scope. */
async function approve(
  sessionId: string,
  actions: string[],
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string,
  durationMinutes: number,
  nowMs: number,
): Promise<void> {
  const approverSession = await createWebSession(
    env,
    `raw-approver-${scopeType}-${scopeId}-${nowMs}`,
    { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID },
    nowMs,
  )
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT,
      agentSessionId: sessionId,
      agentId: LEAD_AGENT_ID,
      memberId: LEAD_MEMBER_ID,
      actions,
      scopeType,
      scopeId,
      durationMinutes,
      reason: 'standing up my squad',
    },
    nowMs,
  )
  if (!created.ok) throw new Error(`approve: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT,
      requestId: created.request.id,
      decision: 'approve',
      selectedActions: actions,
      decidedByMemberId: APPROVER_MEMBER_ID,
      // The approver's real grants: org admin, nothing more.
      decidedByCapabilities: [
        { member_id: APPROVER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`approve: decision failed: ${JSON.stringify(decision)}`)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: memoryKv(),
    PUBLIC_ORIGIN: ORIGIN,
  } as unknown as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})


const HOME_SQUAD_ID = 'squad-home-x'

function seedExtra(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, kind) VALUES ('dept-home-x', 'dept-home-x', 'Home X', 'home');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${HOME_SQUAD_ID}', 'dept-home-x', 'home-x', 'Home X', 'home');
  `)
}

async function elevate(actions: string[], scopeType: 'org' | 'squad', scopeId: string): Promise<void> {
  const t0 = Date.now()
  await approve(await checkIn(), actions, scopeType, scopeId, 60, t0)
}

function adminAuth(): AuthContext {
  return {
    userId: APPROVER_MEMBER_ID,
    memberId: APPROVER_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: APPROVER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
  } as unknown as AuthContext
}

function edges(projectId: string): Array<{ squad_id: string; access_level: string }> {
  return harness.sqlite
    .prepare('SELECT squad_id, access_level FROM project_squad_access WHERE project_id = ? ORDER BY squad_id')
    .all(projectId) as Array<{ squad_id: string; access_level: string }>
}

function projectIdBySlug(slug: string): string | undefined {
  return (harness.sqlite.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as { id: string } | undefined)?.id
}

describe('#1674 (1) project_create attaches the creator squad', () => {
  beforeEach(() => seedExtra())

  it('explicit squad_id: project + write edge in one write; creator sees it by id', async () => {
    await elevate(['action:workspace_project'], 'org', '')
    const res = await invokeTool(leadAuth(), env, 'project_create', { slug: 'p-one', name: 'P One', squad_id: LEAD_SQUAD_ID }, ORIGIN)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const id = (res.result as { project: { id: string } }).project.id
    expect(edges(id)).toEqual([{ squad_id: LEAD_SQUAD_ID, access_level: 'write' }])
    const got = await invokeTool(leadAuth(), env, 'project_get', { project_id: id }, ORIGIN)
    expect(got.ok, JSON.stringify(got)).toBe(true)
  })

  it('default: an agent-bound caller with no squad_id gets its OWN squad attached', async () => {
    await elevate(['action:workspace_project'], 'org', '')
    const res = await invokeTool(leadAuth(), env, 'project_create', { slug: 'p-two', name: 'P Two' }, ORIGIN)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(edges(projectIdBySlug('p-two') as string)).toEqual([{ squad_id: LEAD_SQUAD_ID, access_level: 'write' }])
  })

  it('a squad the caller does not belong to is refused and NO project row is created', async () => {
    await elevate(['action:workspace_project'], 'org', '')
    const res = await invokeTool(leadAuth(), env, 'project_create', { slug: 'p-three', name: 'P Three', squad_id: OTHER_SQUAD_ID }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(projectIdBySlug('p-three')).toBeUndefined()
  })

  it('a home squad is refused even for explicit squad_id; unknown squad is 404', async () => {
    await elevate(['action:workspace_project'], 'org', '')
    const home = await invokeTool(leadAuth(), env, 'project_create', { slug: 'p-four', name: 'P Four', squad_id: HOME_SQUAD_ID }, ORIGIN)
    expect(home.ok).toBe(false)
    const unknown = await invokeTool(leadAuth(), env, 'project_create', { slug: 'p-five', name: 'P Five', squad_id: 'nope' }, ORIGIN)
    expect(unknown.ok).toBe(false)
    expect(projectIdBySlug('p-four')).toBeUndefined()
    expect(projectIdBySlug('p-five')).toBeUndefined()
  })

  it('standing admin with no agent binding and no squad_id: unattached, as before', async () => {
    const res = await invokeTool(adminAuth(), env, 'project_create', { slug: 'p-six', name: 'P Six' }, ORIGIN)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(edges(projectIdBySlug('p-six') as string)).toEqual([])
  })
})

describe('#1674 (2, cut) project_squad_set stays standing-org-admin only: no elevation opens it', () => {
  let projectId: string
  beforeEach(async () => {
    seedExtra()
    const res = await invokeTool(adminAuth(), env, 'project_create', { slug: 'p-set', name: 'P Set' }, ORIGIN)
    projectId = (res.result as { project: { id: string } }).project.id
  })

  it.each([
    ['squad', LEAD_SQUAD_ID],
    ['org', ''],
  ] as const)('a live manage_access grant (%s scope) does not let an agent attach any squad', async (scopeType, scopeId) => {
    await elevate(['action:manage_access'], scopeType, scopeId)
    for (const level of ['write', 'admin']) {
      const res = await invokeTool(leadAuth(), env, 'project_squad_set', { project_id: projectId, squad_id: LEAD_SQUAD_ID, access_level: level }, ORIGIN)
      expect(res.ok).toBe(false)
    }
    expect(edges(projectId)).toEqual([])
  })

  it('the plain refusal does not advertise request_elevation', async () => {
    const res = await invokeTool(leadAuth(), env, 'project_squad_set', { project_id: projectId, squad_id: LEAD_SQUAD_ID, access_level: 'write' }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('request_elevation')
  })

  it('the catalog does not claim project access edits', () => {
    expect(ELEVATION_ACTIONS['action:manage_access'].description).toContain('Does NOT cover project')
  })
})

describe('#1674 (1b) the creator-squad edge is guarded on the squad current state', () => {
  it('a squad archived after the caller check but before the write gets no edge', async () => {
    const { createProject } = await import('../src/projects/service')
    harness.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = '${LEAD_SQUAD_ID}'`)
    const res = await createProject(env, { slug: 'race', name: 'Race' }, { attachSquadId: LEAD_SQUAD_ID })
    expect(res.ok).toBe(true)
    if (res.ok) expect(edges(res.value.id)).toEqual([])
  })
})

describe('#1674 (3) project_get accepts the slug project_list shows', () => {
  beforeEach(() => seedExtra())

  it('resolves by slug with the same visibility rules', async () => {
    const created = await invokeTool(adminAuth(), env, 'project_create', { slug: 'slug-vis', name: 'Slug Vis', squad_id: OTHER_SQUAD_ID }, ORIGIN)
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const admin = await invokeTool(adminAuth(), env, 'project_get', { project_id: 'slug-vis' }, ORIGIN)
    expect(admin.ok, JSON.stringify(admin)).toBe(true)
    expect((admin.result as { project: { slug: string } }).project.slug).toBe('slug-vis')
    // lead holds nothing on OTHER_SQUAD: the slug is exactly as invisible as the id.
    const lead = await invokeTool(leadAuth(), env, 'project_get', { project_id: 'slug-vis' }, ORIGIN)
    expect(lead.ok).toBe(false)
  })
})

describe('#1674 (4) request_elevation validates the scope id', () => {
  it('refuses a slug / unknown squad and department with invalid_scope; accepts real ids and org', async () => {
    await checkIn()
    const ask = (scope_type: string, scope_id?: string) =>
      invokeTool(leadAuth(), env, 'request_elevation', {
        actions: ['action:manage_access'], scope_type, ...(scope_id === undefined ? {} : { scope_id }), duration_minutes: 60, reason: 'r',
      }, ORIGIN)
    const slug = await ask('squad', 'mcpwp')
    expect(slug.ok).toBe(false)
    expect(JSON.stringify(slug)).toContain('invalid_scope')
    expect((await ask('squad')).ok).toBe(false)
    expect((await ask('department', 'nope')).ok).toBe(false)
    expect((await ask('squad', LEAD_SQUAD_ID)).ok).toBe(true)
    expect((await ask('department', DEPT_ID)).ok).toBe(true)
    expect((await ask('org')).ok).toBe(true)
  })
})

describe('#1674 (5) need=<cap> refusals name the elevation door', () => {
  it('project_create member refusal carries request_elevation + action key', async () => {
    const res = await invokeTool(leadAuth(), env, 'project_create', { slug: 'h', name: 'H' }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('request_elevation')
    expect(JSON.stringify(res)).toContain('action:workspace_project')
  })
})

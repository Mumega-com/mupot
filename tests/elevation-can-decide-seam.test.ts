// tests/elevation-can-decide-seam.test.ts — mupot#1673: ONE authority predicate
// (canDecideElevation) for the elevation list surfaces and the decide
// transaction. Seam property: for every (actor, scope) cell, "listed on the
// dashboard pending page" <=> "canDecideElevation" <=> "decideElevationRequest
// does not answer forbidden". Real migrations, real decide transaction.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pendingRequestsBody } from '../src/dashboard/elevation'
import { canDecideElevation, createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createHomeForMember } from '../src/org/service'
import type { AuthContext, CapabilityGrant, CapabilityScopeType, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const DEPT = 'dept-1'
const WORK_SQUAD = 'squad-work'
const OTHER_SQUAD = 'squad-other'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const HOME_OWNER = 'member-home-owner'
const OP = 'member-operator'
const TOKEN_ID = 'token-a-1'

let harness: SqliteD1Harness
let env: Env
let sessionId: string
let homeSquadId: string
let webSessionHash: string

function grant(scope_type: CapabilityScopeType, scope_id: string | null): CapabilityGrant {
  return { member_id: OP, scope_type, scope_id, capability: 'admin' } as CapabilityGrant
}

interface Actor {
  name: string
  auth: AuthContext
}

function actor(name: string, role: string, caps: CapabilityGrant[] | undefined): Actor {
  // Test fixture AuthContext — only the fields the predicate/dashboard read.
  const auth = { role, webSessionMemberId: OP, capabilities: caps } as unknown as AuthContext
  return { name, auth }
}

const ACTORS: Actor[] = [
  actor('org admin (legacy role, no grants)', 'admin', undefined),
  actor('org admin (org-scope grant only)', 'member', [grant('org', null)]),
  actor('squad admin on work squad', 'member', [grant('squad', WORK_SQUAD)]),
  actor('department admin (grant)', 'member', [grant('department', DEPT)]),
  actor('plain member', 'member', []),
]

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: {} } as unknown as Env
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run()
  await q(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`, DEPT)
  await q(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-work', 'Squad Work')`, WORK_SQUAD, DEPT)
  await q(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-other', 'Squad Other')`, OTHER_SQUAD, DEPT)
  await q(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, 'agent-a', 'Agent Alpha', 'member', 'test', 'active')`, AGENT_ID, WORK_SQUAD)
  await q(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, 'Agent A Member', 'active', datetime('now'))`, AGENT_MEMBER, TENANT)
  await q(`INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'home@x.test', 'Home Owner', 'active', datetime('now'))`, HOME_OWNER, TENANT)
  await q(`INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'op@x.test', 'Operator', 'active', datetime('now'))`, OP, TENANT)
  await q(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, TENANT, AGENT_ID, AGENT_MEMBER)
  await q(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
     VALUES (?1, ?2, 'hash-1', 'primary', 'workspace', ?3, ?4, datetime('now'))`,
    TOKEN_ID, AGENT_MEMBER, TENANT, AGENT_ID,
  )
  await q(
    `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
     VALUES ('ident-op', ?1, 'google', ?2, 'op@x.test', ?2, datetime('now'))`,
    TENANT, OP,
  )
  webSessionHash = (await createWebSession(env, 'raw-op-session', { tenant: TENANT, memberId: OP, loginIdentityId: 'ident-op' })).id_hash
  const home = await createHomeForMember(env, HOME_OWNER)
  if (!home.ok) throw new Error(`setup: createHomeForMember failed: ${JSON.stringify(home)}`)
  homeSquadId = home.squad.id
  const session = await createAgentSession(env, {
    tenant: TENANT, agentId: AGENT_ID, memberId: AGENT_MEMBER, authKind: 'workspace_token', credentialId: TOKEN_ID,
  })
  sessionId = session.id
})

afterEach(() => harness.close())

async function seedRequest(scopeType: CapabilityScopeType, scopeId: string | null, action: string): Promise<string> {
  const r = await createElevationRequest(env, {
    tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
    actions: [action], scopeType, scopeId: scopeId ?? undefined, durationMinutes: 60, reason: 'seam',
  })
  if (!r.ok) throw new Error(`setup: createElevationRequest failed: ${JSON.stringify(r)}`)
  return r.request.id
}

const SCOPES: Array<{ name: string; type: CapabilityScopeType; id: () => string | null; action: string }> = [
  { name: 'org', type: 'org', id: () => null, action: 'action:manage_access' },
  { name: 'department', type: 'department', id: () => DEPT, action: 'action:manage_access' },
  { name: 'work squad', type: 'squad', id: () => WORK_SQUAD, action: 'action:manage_access' },
  { name: 'other work squad', type: 'squad', id: () => OTHER_SQUAD, action: 'action:manage_access' },
  { name: 'home squad', type: 'squad', id: () => homeSquadId, action: 'action:home_access' },
]

describe('canDecideElevation seam: listed <=> decidable (#1673)', () => {
  for (const scope of SCOPES) {
    for (const a of ACTORS) {
      it(`${a.name} x ${scope.name}`, async () => {
        const id = await seedRequest(scope.type, scope.id(), scope.action)
        const predicate = await canDecideElevation(env, a.auth, a.auth.capabilities, scope.type, scope.id())
        const page = String(await pendingRequestsBody(env, a.auth))
        const listed = page.includes(`/elevation/${id}`)
        const result = await decideElevationRequest(env, {
          tenant: TENANT, requestId: id, decision: 'deny',
          decidedByMemberId: OP,
          decidedByIsOrgAdmin: a.auth.role === 'admin' || (a.auth.capabilities ?? []).some((c) => c.scope_type === 'org'),
          decidedByCapabilities: a.auth.capabilities ?? [],
          decidedByWebSessionHash: webSessionHash, recentReauthOk: true,
        })
        const decidable = !(!result.ok && result.reason === 'forbidden')
        expect(listed).toBe(predicate)
        expect(decidable).toBe(predicate)
      })
    }
  }

  it('pins the expected matrix on the cells that matter', async () => {
    const orgAdmin = ACTORS[0].auth
    const squadAdmin = ACTORS[2].auth
    const deptAdmin = ACTORS[3].auth
    // org admin: work squads yes, home squad NO (G-FP1b exception preserved).
    expect(await canDecideElevation(env, orgAdmin, undefined, 'squad', OTHER_SQUAD)).toBe(true)
    expect(await canDecideElevation(env, orgAdmin, undefined, 'squad', homeSquadId)).toBe(false)
    // squad admin: only their squad.
    expect(await canDecideElevation(env, squadAdmin, squadAdmin.capabilities, 'squad', WORK_SQUAD)).toBe(true)
    expect(await canDecideElevation(env, squadAdmin, squadAdmin.capabilities, 'squad', OTHER_SQUAD)).toBe(false)
    // department grant covers work squads in it, never a home.
    expect(await canDecideElevation(env, deptAdmin, deptAdmin.capabilities, 'squad', WORK_SQUAD)).toBe(true)
    expect(await canDecideElevation(env, deptAdmin, deptAdmin.capabilities, 'squad', homeSquadId)).toBe(false)
  })
})

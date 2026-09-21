// tests/home-squad-org-admin-isolation.test.ts — FP-01 Slice 1 v2 (G-FP1b): the successor
// design to mupot#1452 round 2. Round 2 added a kind='home' exclusion as an OPTIONAL
// `squadKind?` parameter on hasCapability/canOnSquad/canOnSquadAuth — an optional parameter
// on an authz predicate is the opposite of a chokepoint, and the adversarial round found the
// exact bypass on org-scope grants AND the legacy `auth.role` plane (see MEMORY
// feedback_optional_parameter_on_authz_predicate_is_not_a_chokepoint.md).
//
// This suite proves the SPECIFIC defect classes round 2 missed, using the fixture the memory
// names as the one production never emits FALSE for and this codebase must still refuse:
// `{ role: 'owner', capabilities: undefined }` — the legacy web-login owner/admin, which is
// the bootstrap owner's REAL shape (zero capability rows, standing lives entirely on
// `auth.role`) — as well as an org-scope GRANT holder (`capabilities: [{scope_type:'org', ...}]`).
// Both planes must get ZERO standing on a member's home squad from inheritance; only an EXACT
// squad-scope grant (the row createHomeForMember itself writes) ever covers it.
//
// Real migration chain (createSqliteD1 + applyAllMigrations) — no hand-written schema. Every
// MCP tool call goes through invokeTool (src/mcp), never a ToolSpec's run() directly
// (scripts/check-mcp-tool-seam.mjs).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHomeForMember, createDepartment, createSquad, findHomeSquadByDepartment } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import {
  actorRankOnScopeFor,
  canOnSquad,
  canOnSquadAuth,
  hasCapability,
  loadSquadScope,
  targetMaxRankAcrossScopes,
} from '../src/auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'

describe('legacy owner / org-grant plane never covers a home squad (G-FP1b point 2)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let homeSquadId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-shadi', ?1, NULL, 'Shadi', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    const home = await createHomeForMember(env, 'member-shadi')
    if (!home.ok) throw new Error('setup failed')
    homeSquadId = home.squad.id
  })

  afterEach(() => harness.close())

  // The exact fixture the memory names: a bootstrap-owner-shaped principal.
  // `[]` is a principal production never emits and requireCapability's own
  // legacy-role escape already treats specially — `undefined` is the real shape.
  const LEGACY_OWNER: AuthContext = {
    userId: 'owner-1',
    memberId: null,
    email: 'owner@example.test',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: undefined,
  }

  const LEGACY_ADMIN: AuthContext = { ...LEGACY_OWNER, role: 'admin' }

  function orgGrantHolder(memberId: string): AuthContext {
    return {
      userId: memberId,
      memberId,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
  }

  it('actorRankOnScopeFor: a legacy owner/admin ranks 0 on a home squad (not 5/4)', async () => {
    const rankOwner = await actorRankOnScopeFor(env, LEGACY_OWNER, 'squad', homeSquadId)
    const rankAdmin = await actorRankOnScopeFor(env, LEGACY_ADMIN, 'squad', homeSquadId)
    expect(rankOwner).toBe(0)
    expect(rankAdmin).toBe(0)
  })

  it('hasCapability/canOnSquad: an org-scope ADMIN grant does not cover a home squad', async () => {
    const scope = await loadSquadScope(env, homeSquadId)
    expect(scope).not.toBeNull()
    if (!scope) return
    const orgGrants: CapabilityGrant[] = [
      { member_id: 'org-admin-1', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    expect(hasCapability(orgGrants, 'squad', scope, 'observer')).toBe(false)
    expect(await canOnSquad(env, orgGrants, homeSquadId, 'observer')).toBe(false)
  })

  it('canOnSquadAuth: neither the legacy-role plane nor an org grant reaches a home squad', async () => {
    expect(await canOnSquadAuth(env, LEGACY_OWNER, homeSquadId, 'observer')).toBe(false)
    expect(await canOnSquadAuth(env, orgGrantHolder('org-admin-2'), homeSquadId, 'observer')).toBe(false)
    // Sanity: the SAME check on a real work squad still admits the legacy owner —
    // proves the refusal above is the home exclusion, not a broken predicate.
    const dept = await createDepartment(env, { slug: 'dept-work-sanity', name: 'Work' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-work-sanity', name: 'Work Squad' })
    if (!squad.ok) throw new Error('setup failed')
    expect(await canOnSquadAuth(env, LEGACY_OWNER, squad.value.id, 'observer')).toBe(true)
  })

  it('targetMaxRankAcrossScopes: a home-admin grant does not inflate the MEMBER\'s global rank ceiling', async () => {
    // member-shadi's ONLY standing anywhere is admin on their own home. Athena's
    // intent (G-FP1b point 2): "a home row is capability-dead outside the home" —
    // this must not make Shadi look like a global rank-4 principal, which would
    // make them immune to suspension/mint-for/grant actions targeting them
    // elsewhere (the exact #1411 P0-1 class, just fed by a home row instead of
    // an unrelated work-squad row).
    const rank = await targetMaxRankAcrossScopes(env, 'member-shadi')
    expect(rank).toBe(0)
  })

  // ── real MCP tool surface: org-grant holder refused across the named surfaces ──
  function orgAdminAuth(memberId: string): AuthContext {
    return orgGrantHolder(memberId)
  }

  it('squad_recall / squad_member_list: an org-admin grant holder is refused on a home squad', async () => {
    const auth = orgAdminAuth('org-admin-3')
    const recall = await invokeTool(auth, env, 'squad_recall', { squad_id: homeSquadId, query: 'anything' }, 'test')
    expect(recall.ok).toBe(false)
    expect((recall as unknown as { status: number }).status).toBe(403)

    const list = await invokeTool(auth, env, 'squad_member_list', { squad: homeSquadId }, 'test')
    expect(list.ok).toBe(false)
    expect((list as unknown as { status: number }).status).toBe(403)
  })

  it('task_list / task_board: an org-admin grant holder is refused on a home squad (resolveTaskSquad, point 3/F)', async () => {
    const auth = orgAdminAuth('org-admin-4')
    const list = await invokeTool(auth, env, 'task_list', { squad_id: homeSquadId }, 'test')
    expect(list.ok).toBe(false)
    expect((list as unknown as { status: number }).status).toBe(403)

    const board = await invokeTool(auth, env, 'task_board', { squad_id: homeSquadId }, 'test')
    expect(board.ok).toBe(false)
    expect((board as unknown as { status: number }).status).toBe(403)
  })

  it('wake_agent: an org-admin grant holder is refused on an agent living in someone\'s home squad', async () => {
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-home-shadi', ?1, 'self-shadi', 'Shadi Self', 'active')`,
    ).bind(homeSquadId).run()
    const auth = orgAdminAuth('org-admin-5')
    const wake = await invokeTool(auth, env, 'wake_agent', { agent_id: 'agent-home-shadi' }, 'test')
    expect(wake.ok).toBe(false)
    expect((wake as unknown as { status: number }).status).toBe(403)
  })

  it('peers: an org-admin holder gets refused when explicitly asking for a home squad\'s roster', async () => {
    const auth = orgAdminAuth('org-admin-6')
    const peers = await invokeTool(auth, env, 'peers', { squad_id: homeSquadId }, 'test')
    expect(peers.ok).toBe(false)
  })
})

// ── C: no standing grant path into kind='home' ─────────────────────────────────
describe('no standing grant path into a home squad (G-FP1b point 4)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let homeSquadId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-shadi', ?1, NULL, 'Shadi', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-attacker', ?1, NULL, 'Attacker', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    const home = await createHomeForMember(env, 'member-shadi')
    if (!home.ok) throw new Error('setup failed')
    homeSquadId = home.squad.id
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-attacker', (SELECT id FROM squads WHERE kind != 'home' LIMIT 1), 'attacker', 'Attacker Agent', 'active')`,
    ).run().catch(() => {})
  })

  afterEach(() => harness.close())

  function orgAdminAuth(memberId: string): AuthContext {
    return {
      userId: memberId,
      memberId,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
  }

  it('grant_agent_capability refuses a home-squad target, even for an org-admin caller', async () => {
    // Give the attacker's agent a real identity/membership somewhere first, so
    // the refusal is provably about the TARGET squad's kind, not agent lookup.
    const dept = await createDepartment(env, { slug: 'dept-attacker', name: 'Attacker Dept' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-attacker', name: 'Attacker Squad' })
    if (!squad.ok) throw new Error('setup failed')
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-attacker-2', ?1, 'attacker2', 'Attacker Agent 2', 'active')`,
    ).bind(squad.value.id).run()

    const auth = orgAdminAuth('org-admin-grant')
    const result = await invokeTool(auth, env, 'grant_agent_capability', {
      agent: 'agent-attacker-2',
      squad: homeSquadId,
      capability: 'admin',
    }, 'test')
    expect(result.ok).toBe(false)
    const fail = result as unknown as { status: number; error: string }
    expect(fail.error).toBe('home_scope_not_grantable')

    // MUTATION GUARD: no capabilities row was written for the attacker on the home squad.
    const row = await env.DB.prepare(
      `SELECT 1 FROM capabilities WHERE member_id != 'member-shadi' AND scope_type = 'squad' AND scope_id = ?1`,
    ).bind(homeSquadId).first()
    expect(row).toBeNull()
  })

  it('squad_member_add refuses a home-squad target with home_squad_immutable', async () => {
    const dept = await createDepartment(env, { slug: 'dept-attacker-2', name: 'Attacker Dept 2' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-attacker-2', name: 'Attacker Squad 2' })
    if (!squad.ok) throw new Error('setup failed')
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-attacker-3', ?1, 'attacker3', 'Attacker Agent 3', 'active')`,
    ).bind(squad.value.id).run()

    // squad_member_add's own gate requires admin somewhere plausible on the
    // TARGET squad — home's admin is member-shadi only, so use member-shadi's
    // own auth to prove even the HOME OWNER cannot add someone else in via
    // this generic path; the ONLY writer of a home capability row remains
    // createHomeForMember.
    const shadiAuth: AuthContext = {
      userId: 'member-shadi',
      memberId: 'member-shadi',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: 'member-shadi', scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' }],
    }
    const result = await invokeTool(shadiAuth, env, 'squad_member_add', {
      agent: 'agent-attacker-3',
      squad: homeSquadId,
      capability: 'member',
    }, 'test')
    expect(result.ok).toBe(false)
    const fail = result as unknown as { status: number; error: string }
    expect(fail.error).toBe('home_squad_immutable')
  })
})

// ── HTTP route: POST /members/:id/capabilities refuses a home target ────────────
const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { membersApp } = await import('../src/members')
const { createHomeForMember: createHomeForMemberDup } = await import('../src/org/service')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function fullMigrationHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return harness
}

describe('POST /members/:id/capabilities refuses a kind=\'home\' target (G-FP1b point 4, HTTP route)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = fullMigrationHarness()
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    harness.sqlite.exec(
      `INSERT INTO members (id, display_name, status, tenant) VALUES ('member-shadi', 'Shadi', 'active', '${TENANT}');`,
    )
    authState.current = { userId: 'owner-1', email: 'owner@example.test', role: 'owner', tenant: TENANT }
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('refuses to grant a capability on a home squad, even for a legacy owner (requireCapability(org) escape)', async () => {
    const home = await createHomeForMemberDup(env, 'member-shadi')
    if (!home.ok) throw new Error('setup failed')

    const req = new Request(`https://pot.example/members/member-shadi/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope_type: 'squad', scope_id: home.squad.id, capability: 'admin' }),
    })
    const res = await membersApp.fetch(req, env)
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: 'home_scope_not_grantable' })
  })
})

// ── E: one home lookup by department (G-FP1b point 5) ───────────────────────────
describe('one home lookup by department — two homes per human is structurally impossible (G-FP1b point 5)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  async function seedMember(id: string) {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, NULL, ?1, 'active', datetime('now'))`,
    ).bind(id, TENANT).run()
  }

  it('two createHomeForMember calls converge on ONE squad (baseline idempotency)', async () => {
    await seedMember('member-a')
    const first = await createHomeForMember(env, 'member-a')
    const second = await createHomeForMember(env, 'member-a')
    if (!first.ok || !second.ok) throw new Error('setup failed')
    expect(first.squad.id).toBe(second.squad.id)
    expect(second.disposition).toBe('existing')

    const squadCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM squads WHERE department_id = ?1`,
    ).bind(first.squad.department_id).first<{ n: number }>()
    expect(squadCount?.n).toBe(1)
  })

  it('findHomeSquadByDepartment sees a home squad created under a DIFFERENT slug convention (simulating bootstrapSelf)', async () => {
    await seedMember('member-b')
    // Simulate bootstrapSelf having already created the home department AND a
    // home squad under ITS OWN slug convention (home-<full-uuid>), BEFORE
    // createHomeForMember ever runs — the two functions use different squad
    // slug conventions for the SAME member, which is exactly why the shared
    // lookup must be BY DEPARTMENT, not by squad slug.
    const deptResult = await createDepartment(env, { slug: 'dept-home-member-b', name: 'Home — Member B' }, { kind: 'home' })
    if (!deptResult.ok) throw new Error('setup failed')
    const squadResult = await createSquad(
      env,
      deptResult.value.id,
      { slug: 'home-member-b', name: 'Home — Member B' }, // bootstrapSelf's OWN slug convention (full id)
      { kind: 'home' },
    )
    if (!squadResult.ok) throw new Error('setup failed')
    // bootstrapSelf's own founder grant.
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-bootstrap-founder', 'member-b', 'squad', ?1, 'admin')`,
    ).bind(squadResult.value.id).run()

    // createHomeForMember must ADOPT this squad (via findHomeSquadByDepartment),
    // never mint a second one under its own 8-char-prefix slug convention.
    const viaCreateHome = await createHomeForMember(env, 'member-b')
    if (!viaCreateHome.ok) throw new Error('assertion setup failed')
    expect(viaCreateHome.squad.id).toBe(squadResult.value.id)
    expect(viaCreateHome.disposition).toBe('existing')

    const squadCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM squads WHERE department_id = ?1`,
    ).bind(deptResult.value.id).first<{ n: number }>()
    expect(squadCount?.n).toBe(1)

    // Direct check of the shared lookup itself.
    const found = await findHomeSquadByDepartment(env, deptResult.value.id)
    expect(found?.id).toBe(squadResult.value.id)
  })

  it('"repaired" disposition: caller === member gets a missing capability row written; a non-member caller does not', async () => {
    await seedMember('member-c')
    // Squad exists (as if minted by the other function) but member-c's OWN
    // capability row is missing — the gap createHomeForMember's 'repaired'
    // disposition exists to close.
    const deptResult = await createDepartment(env, { slug: 'dept-home-member-c', name: 'Home — Member C' }, { kind: 'home' })
    if (!deptResult.ok) throw new Error('setup failed')
    const squadResult = await createSquad(
      env,
      deptResult.value.id,
      { slug: 'home-member-c-full', name: 'Home — Member C' },
      { kind: 'home' },
    )
    if (!squadResult.ok) throw new Error('setup failed')

    // Point 6: a caller who is NOT the member gets 'existing', no write.
    const asOther = await createHomeForMember(env, 'member-c', 'member-someone-else')
    if (!asOther.ok) throw new Error('assertion setup failed')
    expect(asOther.disposition).toBe('existing')
    const noGrantYet = await env.DB.prepare(
      `SELECT 1 FROM capabilities WHERE member_id = 'member-c' AND scope_type = 'squad' AND scope_id = ?1`,
    ).bind(squadResult.value.id).first()
    expect(noGrantYet).toBeNull()

    // The member themselves DOES get the gap repaired.
    const asSelf = await createHomeForMember(env, 'member-c', 'member-c')
    if (!asSelf.ok) throw new Error('assertion failed')
    expect(asSelf.disposition).toBe('repaired')
    expect(asSelf.squad.id).toBe(squadResult.value.id)
    const grantNow = await env.DB.prepare(
      `SELECT capability FROM capabilities WHERE member_id = 'member-c' AND scope_type = 'squad' AND scope_id = ?1`,
    ).bind(squadResult.value.id).first<{ capability: string }>()
    expect(grantNow?.capability).toBe('admin')

    // Idempotent from here on — a THIRD call (as self) is now 'existing'.
    const asSelfAgain = await createHomeForMember(env, 'member-c', 'member-c')
    if (!asSelfAgain.ok) throw new Error('assertion failed')
    expect(asSelfAgain.disposition).toBe('existing')
  })
})

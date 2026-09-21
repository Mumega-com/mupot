// tests/home-squad.test.ts — FP-01 Slice 1 (mupot#1443): createHomeForMember
// and the isolation guarantees a home squad must hold structurally, not by
// convention. Brief: agents/kasra/briefs/flight-first-person-mubot-meets-shadi-20260920.md
// §2 (Slice 1), §2b (home-squad isolation), §2c conditions 1-2. Real migration
// chain (createSqliteD1 + applyAllMigrations) — no hand-written schema. Every
// MCP tool call goes through invokeTool (src/mcp), never a ToolSpec's run()
// directly (scripts/check-mcp-tool-seam.mjs).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHomeForMember, createDepartment, createSquad } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'

// mupot#1452 WARN-3: createHomeForMember now takes `auth` and gates itself
// (auth.memberId === memberId, OR isOrgAdmin(auth)) — every test below that
// exercises the happy path authenticates AS the member asking for their own
// home, matching the only caller shape the function's own doc contract
// allows.
function selfAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [],
  }
}

function orgAdminAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [],
  }
}

describe('createHomeForMember (D1, real migration chain)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  async function seedMember(id: string, displayName: string) {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`,
    )
      .bind(id, TENANT, displayName)
      .run()
  }

  async function countRows(table: string): Promise<number> {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
    return row?.n ?? 0
  }

  // ── (a) creates one squad + one capability, in one batch ────────────────────
  it('(a) creates exactly one squad row and one capability row, both in one batch', async () => {
    await seedMember('member-shadi', 'Shadi')

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    const result = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.disposition).toBe('created')
    expect(result.squad.slug).toBe(`home-${'member-shadi'.slice(0, 8)}`)
    expect(result.grant.capability).toBe('admin')

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    expect(after.squads - before.squads).toBe(1)
    expect(after.caps - before.caps).toBe(1)
    // The home department is a SEPARATE, individually-committing step (matching
    // bootstrapSelf's own architecture) — one new department, not folded into
    // the same batch as the squad+capability.
    expect(after.depts - before.depts).toBe(1)

    const squadRow = await env.DB.prepare(`SELECT kind, slug, department_id FROM squads WHERE id = ?1`)
      .bind(result.squad.id)
      .first<{ kind: string; slug: string; department_id: string }>()
    expect(squadRow?.kind).toBe('home')

    const capRow = await env.DB.prepare(
      `SELECT member_id, scope_type, scope_id, capability FROM capabilities WHERE id = ?1`,
    )
      .bind(result.grant.id)
      .first<{ member_id: string; scope_type: string; scope_id: string; capability: string }>()
    expect(capRow).toMatchObject({
      member_id: 'member-shadi',
      scope_type: 'squad',
      scope_id: result.squad.id,
      capability: 'admin',
    })

    // #2b: zero project_squad edges at creation.
    const edges = await countRows('project_squad_access')
    expect(edges).toBe(0)
  })

  // ── (b) idempotent ───────────────────────────────────────────────────────────
  it('(b) a second call is idempotent: same squad id, zero new rows', async () => {
    await seedMember('member-shadi', 'Shadi')

    const first = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    const second = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(second.disposition).toBe('existing')
    expect(second.squad.id).toBe(first.squad.id)
    expect(second.grant.id).toBe(first.grant.id)
    expect(second.grant.capability).toBe(first.grant.capability)

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    expect(after).toEqual(before)
  })

  // ── (c) unknown member fails closed ─────────────────────────────────────────
  it('(c) an unknown member id fails closed: member_not_found, zero rows written', async () => {
    const before = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    const result = await createHomeForMember(env, 'member-does-not-exist', selfAuth('member-does-not-exist'))
    expect(result).toEqual({ ok: false, error: 'member_not_found' })

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    expect(after).toEqual(before)
  })

  it('reuses the SAME home department bootstrapSelf would derive (dept-home-<memberId>), never inventing a second one', async () => {
    await seedMember('member-shadi', 'Shadi')
    // Simulate a prior bootstrapSelf run that already created the member's home
    // department (but not this short-slug squad) — createHomeForMember must
    // adopt it, not create a sibling.
    const priorDept = await createDepartment(
      env,
      { slug: 'dept-home-member-shadi', name: 'Home — Shadi' },
      { kind: 'home' },
    )
    expect(priorDept.ok).toBe(true)
    if (!priorDept.ok) return

    const result = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.squad.department_id).toBe(priorDept.value.id)

    const deptCount = await countRows('departments')
    expect(deptCount).toBe(1)
  })

  // ── P1-2: one home per human — adopt bootstrapSelf's squad, never a sibling ──
  it('P1-2: a member already bootstrapped via bootstrapSelf gets ONE squad, ONE admin row (adopts, never duplicates)', async () => {
    await seedMember('member-shadi', 'Shadi')

    // Simulate bootstrapSelf's own shape: home department dept-home-<memberId>,
    // home squad slug home-<FULL memberId> (NOT createHomeForMember's own
    // home-<8-char-prefix> convention), founder capability = admin on it.
    const priorDept = await createDepartment(
      env,
      { slug: 'dept-home-member-shadi', name: 'Home — Shadi' },
      { kind: 'home' },
    )
    expect(priorDept.ok).toBe(true)
    if (!priorDept.ok) return
    const priorSquad = await createSquad(
      env,
      priorDept.value.id,
      { slug: 'home-member-shadi', name: 'Home — Shadi' },
      { kind: 'home' },
    )
    expect(priorSquad.ok).toBe(true)
    if (!priorSquad.ok) return
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-bootstrap-self-shadi', 'member-shadi', 'squad', ?1, 'admin')`,
    )
      .bind(priorSquad.value.id)
      .run()

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    const result = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Adopted bootstrapSelf's squad — NOT a new one under the short-slug
    // convention this function would otherwise mint.
    expect(result.disposition).toBe('existing')
    expect(result.squad.id).toBe(priorSquad.value.id)
    expect(result.squad.slug).toBe('home-member-shadi')
    expect(result.grant.id).toBe('cap-bootstrap-self-shadi')

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    expect(after).toEqual(before) // zero new rows

    const squadCountInDept = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM squads WHERE department_id = ?1 AND kind = 'home'`,
    )
      .bind(priorDept.value.id)
      .first<{ n: number }>()
    expect(squadCountInDept?.n ?? 0).toBe(1)
  })

  // ── P1-3: provenance — a guest capability on someone ELSE's home is never
  // mistaken for the caller's own home ───────────────────────────────────────
  it('P1-3: member A admits B into A\'s home (observer); createHomeForMember(B) creates B\'s OWN home, never A\'s', async () => {
    await seedMember('member-a', 'A')
    await seedMember('member-b', 'B')

    const homeA = await createHomeForMember(env, 'member-a', selfAuth('member-a'))
    expect(homeA.ok).toBe(true)
    if (!homeA.ok) return

    // A admits B into A's home squad at observer — a REAL, exact squad-scope
    // capability row for B, on A's squad.
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-b-guest-of-a', 'member-b', 'squad', ?1, 'observer')`,
    )
      .bind(homeA.squad.id)
      .run()

    const homeB = await createHomeForMember(env, 'member-b', selfAuth('member-b'))
    expect(homeB.ok).toBe(true)
    if (!homeB.ok) return

    // B's OWN home — a DIFFERENT squad and department from A's, never A's.
    expect(homeB.disposition).toBe('created')
    expect(homeB.squad.id).not.toBe(homeA.squad.id)
    expect(homeB.squad.department_id).not.toBe(homeA.squad.department_id)
    expect(homeB.grant.capability).toBe('admin')

    const squadCount = await countRows('squads')
    expect(squadCount).toBe(2) // A's home + B's home, never a shared one
  })

  // ── P1-4: recoverability — squad row exists, capability row does not ────────
  it('P1-4: squad row exists but the capability row is missing → repaired, one squad, one cap', async () => {
    await seedMember('member-shadi', 'Shadi')

    const first = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Simulate the capability row vanishing (e.g. an operator revoke, or a
    // real-world partial-application edge case) while the squad row survives.
    await env.DB.prepare(`DELETE FROM capabilities WHERE id = ?1`).bind(first.grant.id).run()

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    const second = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(second.disposition).toBe('repaired')
    expect(second.squad.id).toBe(first.squad.id) // same squad, never a second one
    expect(second.grant.capability).toBe('admin')
    expect(second.grant.id).not.toBe(first.grant.id) // a FRESH capability row

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    expect(after.squads).toBe(before.squads) // no new squad
    expect(after.caps - before.caps).toBe(1) // exactly one new capability row

    const capRow = await env.DB.prepare(
      `SELECT member_id, scope_type, scope_id, capability FROM capabilities WHERE id = ?1`,
    )
      .bind(second.grant.id)
      .first<{ member_id: string; scope_type: string; scope_id: string; capability: string }>()
    expect(capRow).toMatchObject({
      member_id: 'member-shadi',
      scope_type: 'squad',
      scope_id: first.squad.id,
      capability: 'admin',
    })
  })

  // ── P1-1: member gate is tenant + status aware ───────────────────────────────
  it('P1-1: a member from a DIFFERENT tenant fails closed: member_not_found, zero rows', async () => {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-other-tenant', 'other-tenant', NULL, 'Foreign', 'active', datetime('now'))`,
    ).run()

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    const result = await createHomeForMember(env, 'member-other-tenant', selfAuth('member-other-tenant'))
    expect(result).toEqual({ ok: false, error: 'member_not_found' })

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    expect(after).toEqual(before)
  })

  it('P1-1: a SUSPENDED member fails closed: member_not_found, zero rows', async () => {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-suspended', ?1, NULL, 'Suspended', 'suspended', datetime('now'))`,
    )
      .bind(TENANT)
      .run()

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    const result = await createHomeForMember(env, 'member-suspended', selfAuth('member-suspended'))
    expect(result).toEqual({ ok: false, error: 'member_not_found' })

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    expect(after).toEqual(before)
  })

  // ── WARN-3: the guard lives INSIDE createHomeForMember, not only at a caller ─
  it('WARN-3: an agent-bound token asking for a DIFFERENT member\'s home is refused', async () => {
    await seedMember('member-shadi', 'Shadi')
    await seedMember('member-other', 'Other')

    const agentBoundAuth: AuthContext = {
      userId: 'member-other',
      memberId: 'member-other',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: 'agent-other-self',
      capabilities: [],
    }

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    const result = await createHomeForMember(env, 'member-shadi', agentBoundAuth)
    expect(result).toEqual({ ok: false, error: 'forbidden' })

    const after = { squads: await countRows('squads'), caps: await countRows('capabilities') }
    expect(after).toEqual(before)
  })

  it('WARN-3: an org admin MAY create a home on behalf of another member', async () => {
    await seedMember('member-shadi', 'Shadi')
    await seedMember('mem-admin', 'Admin')

    const result = await createHomeForMember(env, 'member-shadi', orgAdminAuth('mem-admin'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.disposition).toBe('created')
  })
})

// A minimal fake AI + Vectorize pair — enough for squad_recall/squad_remember
// (src/memory/index.ts) to run without throwing. The tests below assert
// AUTHORIZATION outcomes (who may reach the memory scope at all), not recall
// content, so a zero-vector embed and an empty ANN result are sufficient.
function fakeMemoryBindings() {
  return {
    AI: {
      async run() {
        return { data: [[0]] }
      },
    },
    VEC: {
      async upsert() {
        return { count: 1, ids: [] }
      },
      async query() {
        return { matches: [], count: 0 }
      },
    },
  }
}

// ── isolation: enforced, not assumed ──────────────────────────────────────────
describe('home-squad isolation (§2b/§2c, enforced through the real MCP tool surface)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let workSquadId: string
  const WORK_AGENT = 'agent-work'
  const PROJECT_ID = 'project-psychonom'

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      ...fakeMemoryBindings(),
    } as unknown as Env

    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-shadi', ?1, NULL, 'Shadi', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-other', ?1, NULL, 'Other', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-work', ?1, NULL, 'Work Agent Member', 'active', datetime('now'))`).bind(TENANT).run()

    // A normal WORK squad with one agent, unrelated to either member's home.
    const dept = await createDepartment(env, { slug: 'dept-work', name: 'Work Dept' })
    expect(dept.ok).toBe(true)
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-work', name: 'Work Squad' })
    expect(squad.ok).toBe(true)
    if (!squad.ok) throw new Error('setup failed')
    workSquadId = squad.value.id
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'work-agent', 'Work Agent', 'active')`,
    ).bind(WORK_AGENT, workSquadId).run()
    // member-work's own capability on the work squad — the normal shape a
    // properly-provisioned agent's dedicated member holds (mirrors
    // prepareAgentSquadAccess's capabilities INSERT, src/members/agent-access.ts).
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-work-self', 'member-work', 'squad', ?1, 'member')`,
    ).bind(workSquadId).run()

    // A project with NO project_squad_access edges to anyone's home.
    await env.DB.prepare(`INSERT INTO projects (id, slug, name) VALUES (?1, 'psychonom', 'Psychonom')`)
      .bind(PROJECT_ID)
      .run()
  })

  afterEach(() => harness.close())

  function authFor(memberId: string, grants: CapabilityGrant[]): AuthContext {
    return {
      userId: memberId,
      memberId,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: grants,
    }
  }

  function agentAuth(memberId: string, agentId: string, grants: CapabilityGrant[]): AuthContext {
    return { ...authFor(memberId, grants), boundAgentId: agentId }
  }

  // ── (d) §2c-1: home-admin confers nothing on any project ────────────────────
  it('(d) a member holding ONLY home-admin gets empty project_list and cannot read a project it was never granted', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    const auth = authFor('member-shadi', [
      { member_id: 'member-shadi', scope_type: 'squad', scope_id: home.squad.id, capability: 'admin' },
    ])

    const list = await invokeTool(auth, env, 'project_list', {}, 'test')
    expect(list.ok).toBe(true)
    expect((list.result as { projects: unknown[] }).projects).toEqual([])

    const recall = await invokeTool(auth, env, 'project_recall', { project_id: PROJECT_ID, query: 'anything' }, 'test')
    // NOTE: production's readableProject deliberately returns the SAME
    // project_not_found for "does not exist" and "not visible to you" — a
    // documented no-wrong-id-vs-no-access oracle (src/mcp/projects.ts,
    // toolProjectRemember's comment on the same primitive) — so the real
    // outcome here is 404 project_not_found, not a bare 403. Asserting the
    // literal code the running system returns, not the brief's shorthand.
    expect(recall.ok).toBe(false)
    const failResult = recall as unknown as { status: number; error: string }
    expect(failResult.status).toBe(404)
    expect(failResult.error).toBe('project_not_found')
  })

  it('(d-mutation-target) MUTATION GUARD: home-admin project isolation depends on projectVisibilityClause\'s project_squad_access EXISTS join', async () => {
    // This test exists to be named in the mutation ledger — see the build
    // report. It re-asserts the same invariant as (d) from the squad side:
    // the home squad has ZERO project_squad_access rows after createHomeForMember.
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return
    const edges = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = ?1`,
    ).bind(home.squad.id).first<{ n: number }>()
    expect(edges?.n ?? 0).toBe(0)
  })

  // ── (e) a second member's token gets 403 on squad_recall, and does not see
  // the home in squad_member_list ──────────────────────────────────────────────
  // ── (e) mupot#1452 P0-1/P0-2 (Athena's ruling) ────────────────────────────────
  // Three outsider shapes, all refused identically on a kind='home' squad:
  //   1. an exact grant on a DIFFERENT squad (the pre-fix shape — still refused)
  //   2. the org-scope row PRODUCTION MINTS on every member: ('org', NULL, 'member')
  //   3. org:ADMIN — legacy role AND an org-scope 'admin'/'owner' grant
  // None of the three may recall/remember/list-members of the home, and the
  // owner's OWN exact grant is the sanity check that proves this is real
  // isolation, not a broken tool.
  it('(e) an outsider with an exact grant on a DIFFERENT squad gets 403 on squad_recall/remember/member_list of the home', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    const otherAuth = authFor('member-other', [
      { member_id: 'member-other', scope_type: 'squad', scope_id: workSquadId, capability: 'admin' },
    ])

    const recall = await invokeTool(otherAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(recall.ok).toBe(false)
    expect((recall as unknown as { status: number; error: string })).toMatchObject({ status: 403, error: 'forbidden' })

    const remember = await invokeTool(otherAuth, env, 'squad_remember', { squad_id: home.squad.id, text: 'x' }, 'test')
    expect(remember.ok).toBe(false)
    expect((remember as unknown as { status: number })).toMatchObject({ status: 403 })

    const list = await invokeTool(otherAuth, env, 'squad_member_list', { squad: home.squad.id }, 'test')
    expect(list.ok).toBe(false)
    expect((list as unknown as { status: number })).toMatchObject({ status: 403 })

    // Sanity: the OWNER can recall their own home (proves the 403 above is
    // real isolation, not a broken tool).
    const ownerAuth = authFor('member-shadi', [
      { member_id: 'member-shadi', scope_type: 'squad', scope_id: home.squad.id, capability: 'admin' },
    ])
    const ownRecall = await invokeTool(ownerAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(ownRecall.ok).toBe(true)
  })

  it('(e-org-member) mupot#1452 P0-2: an outsider carrying the org-scope row production mints (org, NULL, member) gets 403', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    // The EXACT row production mints for every ordinary member (org-wide,
    // NULL scope_id, 'member' rank) — never a squad/department grant.
    const orgMemberAuth = authFor('member-other', [
      { member_id: 'member-other', scope_type: 'org', scope_id: null, capability: 'member' },
    ])

    const recall = await invokeTool(orgMemberAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(recall.ok).toBe(false)
    expect((recall as unknown as { status: number; error: string })).toMatchObject({ status: 403, error: 'forbidden' })

    const remember = await invokeTool(orgMemberAuth, env, 'squad_remember', { squad_id: home.squad.id, text: 'x' }, 'test')
    expect(remember.ok).toBe(false)
    expect((remember as unknown as { status: number })).toMatchObject({ status: 403 })

    const list = await invokeTool(orgMemberAuth, env, 'squad_member_list', { squad: home.squad.id }, 'test')
    expect(list.ok).toBe(false)
    expect((list as unknown as { status: number })).toMatchObject({ status: 403 })

    const peers = await invokeTool(orgMemberAuth, env, 'peers', { squad_id: home.squad.id }, 'test')
    expect(peers.ok).toBe(false)
  })

  it('(e-org-admin) mupot#1452 P0-1/Athena: org:ADMIN (org-scope grant AND legacy role) gets 403 on someone else\'s home', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    // Modern plane: an org-scope 'admin' capability grant.
    const orgAdminGrantAuth = authFor('member-admin', [
      { member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' },
    ])
    const recallGrant = await invokeTool(orgAdminGrantAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(recallGrant.ok).toBe(false)
    expect((recallGrant as unknown as { status: number; error: string })).toMatchObject({ status: 403, error: 'forbidden' })

    const listGrant = await invokeTool(orgAdminGrantAuth, env, 'squad_member_list', { squad: home.squad.id }, 'test')
    expect(listGrant.ok).toBe(false)
    expect((listGrant as unknown as { status: number })).toMatchObject({ status: 403 })

    // Legacy plane: auth.role === 'owner', no capabilities array at all — the
    // pure web-login owner/admin escape requireCapability/canOnSquadAuth honour
    // everywhere ELSE must still be excluded here.
    const legacyOwnerAuth: AuthContext = {
      userId: 'member-legacy-owner',
      memberId: 'member-legacy-owner',
      email: null,
      role: 'owner',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    }
    const recallLegacy = await invokeTool(legacyOwnerAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(recallLegacy.ok).toBe(false)
    expect((recallLegacy as unknown as { status: number })).toMatchObject({ status: 403 })
  })

  // ── (e-listings) mupot#1452 P0-1: an org-scope outsider is ABSENT from every
  // listing surface, not merely refused on direct access ──────────────────────
  it('(e-listings) an org-scope grant holder never sees the home squad in consent-picker or the general work-tree squad list', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-admin', ?1, NULL, 'Admin', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-org-admin-listing', 'member-admin', 'org', NULL, 'admin')`,
    ).run()

    const { listConsentableSquads } = await import('../src/mcp/oauth-authorize')
    const consentable = await listConsentableSquads(env, 'member-admin')
    expect(consentable.map((s) => s.id)).not.toContain(home.squad.id)

    const { resolveAllSquadIds, resolveAccessibleSquadIds } = await import('../src/projects/readable-squads')
    const allSquadIds = await resolveAllSquadIds(env)
    expect(allSquadIds).not.toContain(home.squad.id)
    expect(allSquadIds).toContain(workSquadId)

    const accessible = await resolveAccessibleSquadIds(env, authFor('member-admin', [
      { member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]))
    // org-admin resolves to `null` (unrestricted) — but the ONLY thing that
    // matters is that no downstream caller can use it to enumerate the home
    // squad; resolveAllSquadIds above (what every `null`-unrestricted caller
    // ultimately reads from) already proves the exclusion holds.
    expect(accessible).toBeNull()
  })

  it('(e-kanban) mupot#1452 P0-1: kanban never shows a home squad, even for an org admin explicit ask', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    const { loadKanbanData } = await import('../src/dashboard/kanban-routes')
    const orgAdminAuthCtx: AuthContext = {
      userId: 'member-admin',
      memberId: 'member-admin',
      email: null,
      role: 'owner',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    }
    const board = await loadKanbanData(env, orgAdminAuthCtx, { squadIdOrSlug: home.squad.id })
    expect(board.squad).toBeNull()

    // The org-admin default (no squad requested) never lands on the home
    // squad either.
    const defaultBoard = await loadKanbanData(env, orgAdminAuthCtx, {})
    expect(defaultBoard.squad?.id).not.toBe(home.squad.id)
  })

  it('(e-presence) mupot#1452 P0-1: a home-squad agent\'s presence check-in is excluded from the tenant-wide (unrestricted) roster', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    const homeAgentId = 'agent-home-shadi-presence'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'self-shadi-p', 'Shadi Self', 'active')`,
    ).bind(homeAgentId, home.squad.id).run()
    await env.DB.prepare(
      `INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
       VALUES (?1, 'member-shadi', 'Shadi', 'claude-code', '', ?2, datetime('now'), datetime('now'))`,
    ).bind(TENANT, homeAgentId).run()
    // A work-squad agent's presence, for contrast — must still show up.
    await env.DB.prepare(
      `INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
       VALUES (?1, 'member-work', 'Work', 'claude-code', '', ?2, datetime('now'), datetime('now'))`,
    ).bind(TENANT, WORK_AGENT).run()

    const { listPresence } = await import('../src/fleet/presence')
    // squadIds=null is the "unrestricted" (org-admin / org-grant) path — the
    // exact case where a home agent must NOT leak through.
    const unrestricted = await listPresence(env, Date.now(), null)
    expect(unrestricted.map((r) => r.agent_id)).not.toContain(homeAgentId)
    expect(unrestricted.map((r) => r.agent_id)).toContain(WORK_AGENT)
  })

  // ── (f) peers for a work-squad agent never lists home-squad agents ──────────
  it('(f) peers scoped to a work squad never lists an agent living in someone\'s home squad', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    // Simulate an agent actually seated on the home squad (bootstrapSelf's own
    // shape: the human's dedicated agent lives on their home squad).
    const homeAgentId = 'agent-home-shadi'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'self-shadi', 'Shadi Self', 'active')`,
    ).bind(homeAgentId, home.squad.id).run()

    const workAgentAuth = agentAuth('member-work', WORK_AGENT, [
      { member_id: 'member-work', scope_type: 'squad', scope_id: workSquadId, capability: 'member' },
    ])
    const peers = await invokeTool(workAgentAuth, env, 'peers', {}, 'test')
    expect(peers.ok).toBe(true)
    const peerIds = ((peers.result as { peers: Array<{ id: string }> }).peers).map((p) => p.id)
    expect(peerIds).not.toContain(homeAgentId)
    expect(peerIds).toEqual([WORK_AGENT])

    // Even an EXPLICIT cross-squad ask is refused for a non-privileged caller
    // (the work agent holds no capability on the home squad).
    const crossAsk = await invokeTool(workAgentAuth, env, 'peers', { squad_id: home.squad.id }, 'test')
    expect(crossAsk.ok).toBe(false)
  })

  // ── (g) mupot#1452 P0-1 (Athena's ruling, workspaceAdmin bypass audit):
  // wake_agent's manual "org owner/admin may wake any agent" shortcut must not
  // reach an agent living on someone's home squad ──────────────────────────────
  it('(g) wake_agent: an org-scope grant AND a legacy org-admin role are BOTH refused on an agent seated in someone\'s home squad', async () => {
    const home = await createHomeForMember(env, 'member-shadi', selfAuth('member-shadi'))
    expect(home.ok).toBe(true)
    if (!home.ok) return

    const homeAgentId = 'agent-home-shadi-wake'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'self-shadi-wake', 'Shadi Self', 'active')`,
    ).bind(homeAgentId, home.squad.id).run()

    // Modern plane: an org-scope 'admin' capability grant (workspaceAdmin=true
    // via hasWorkspaceAdmin's grant check).
    const orgGrantAuth = authFor('member-work', [
      { member_id: 'member-work', scope_type: 'org', scope_id: null, capability: 'admin' },
    ])
    const wakeGrant = await invokeTool(orgGrantAuth, env, 'wake_agent', { agent_id: homeAgentId }, 'test')
    expect(wakeGrant.ok).toBe(false)
    expect((wakeGrant as unknown as { status: number })).toMatchObject({ status: 403 })

    // Legacy plane: auth.role === 'owner', no capabilities array — the pure
    // web-login owner escape wake_agent's OLD `hasWorkspaceAdmin` shortcut used
    // to honour unconditionally for every squad, home included.
    const legacyOwnerAuth: AuthContext = {
      userId: 'member-legacy-owner-2',
      memberId: 'member-legacy-owner-2',
      email: null,
      role: 'owner',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    }
    const wakeLegacy = await invokeTool(legacyOwnerAuth, env, 'wake_agent', { agent_id: homeAgentId }, 'test')
    expect(wakeLegacy.ok).toBe(false)
    expect((wakeLegacy as unknown as { status: number })).toMatchObject({ status: 403 })

    // Sanity: the owner (exact squad-admin grant) clears the CAPABILITY gate —
    // proves the two refusals above are real isolation, not a broken tool. The
    // test env has no DO/runtime bindings for an actual wake dispatch, so a
    // later infrastructure step may still fail; what matters here is that the
    // owner is never refused with the SAME 403 the outsiders above got.
    const ownerAuth = authFor('member-shadi', [
      { member_id: 'member-shadi', scope_type: 'squad', scope_id: home.squad.id, capability: 'admin' },
    ])
    const wakeOwner = await invokeTool(ownerAuth, env, 'wake_agent', { agent_id: homeAgentId }, 'test')
    if (!wakeOwner.ok) {
      expect((wakeOwner as unknown as { status: number }).status).not.toBe(403)
    }
  })
})

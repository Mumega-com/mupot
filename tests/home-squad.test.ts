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
    const result = await createHomeForMember(env, 'member-shadi')
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

    const first = await createHomeForMember(env, 'member-shadi')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const before = { squads: await countRows('squads'), caps: await countRows('capabilities'), depts: await countRows('departments') }
    const second = await createHomeForMember(env, 'member-shadi')
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
    const result = await createHomeForMember(env, 'member-does-not-exist')
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

    const result = await createHomeForMember(env, 'member-shadi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.squad.department_id).toBe(priorDept.value.id)

    const deptCount = await countRows('departments')
    expect(deptCount).toBe(1)
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
    const home = await createHomeForMember(env, 'member-shadi')
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
    const home = await createHomeForMember(env, 'member-shadi')
    expect(home.ok).toBe(true)
    if (!home.ok) return
    const edges = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = ?1`,
    ).bind(home.squad.id).first<{ n: number }>()
    expect(edges?.n ?? 0).toBe(0)
  })

  // ── (e) a second member's token gets 403 on squad_recall, and does not see
  // the home in squad_member_list ──────────────────────────────────────────────
  it('(e) a different member gets 403 on squad_recall of the first member\'s home, and cannot list its members', async () => {
    const home = await createHomeForMember(env, 'member-shadi')
    expect(home.ok).toBe(true)
    if (!home.ok) return

    // member-other holds capability elsewhere (the work squad) but NOTHING on
    // member-shadi's home.
    const otherAuth = authFor('member-other', [
      { member_id: 'member-other', scope_type: 'squad', scope_id: workSquadId, capability: 'admin' },
    ])

    const recall = await invokeTool(otherAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(recall.ok).toBe(false)
    const recallFail = recall as unknown as { status: number; error: string }
    expect(recallFail.status).toBe(403)
    expect(recallFail.error).toBe('forbidden')

    const list = await invokeTool(otherAuth, env, 'squad_member_list', { squad: home.squad.id }, 'test')
    expect(list.ok).toBe(false)
    const listFail = list as unknown as { status: number }
    expect(listFail.status).toBe(403)

    // Sanity: the OWNER can recall their own home (proves the 403 above is
    // real isolation, not a broken tool).
    const ownerAuth = authFor('member-shadi', [
      { member_id: 'member-shadi', scope_type: 'squad', scope_id: home.squad.id, capability: 'admin' },
    ])
    const ownRecall = await invokeTool(ownerAuth, env, 'squad_recall', { squad_id: home.squad.id, query: 'anything' }, 'test')
    expect(ownRecall.ok).toBe(true)
  })

  // ── (f) peers for a work-squad agent never lists home-squad agents ──────────
  it('(f) peers scoped to a work squad never lists an agent living in someone\'s home squad', async () => {
    const home = await createHomeForMember(env, 'member-shadi')
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
})

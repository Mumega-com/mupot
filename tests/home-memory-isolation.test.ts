// tests/home-memory-isolation.test.ts — FP-01 Slice 2 (mupot#1443, brief §2
// Task C: "HOME MEMORY ONLY"). Re-pins #1472's home-squad isolation
// invariant (tests/home-squad-org-admin-isolation.test.ts) specifically on
// the memory surface, plus the NEW facts Task C asks for: a write into a
// home squad's memory is invisible from project memory, and squad_recall on
// a home still refuses an org-admin grant holder.
//
// VECTORIZE NOTE (binding input, mupot#1486): production project_remember/
// squad_remember return an engram_id immediately, but real Vectorize
// indexing can lag ~5s before recall sees it — no production code may
// assume immediate read-after-write. This suite runs on REAL SQLite D1
// (createSqliteD1 + migrations) for every table EXCEPT the memory engine's
// two bindings (AI, VEC), which have no real-engine test double anywhere in
// this repo — the same fake, SYNCHRONOUS in-memory double
// tests/journey-new-member.test.ts (step 10) and tests/mcp-squad-memory.test.ts
// already use. That means this suite exercises the FAKE-Vectorize path with
// NO indexing lag, not production's async one — isolation here is proven by
// SCOPE-STRING identity (squad:<id> vs project:<id>, src/mcp/index.ts's
// squadMemoryScope/projectMemoryScope), which is the same mechanism in both
// the fake and the real store, not by timing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-home-memory'
const MEMBER_ID = 'member-shadi'
const AGENT_ID = 'agent-shadi-seat'
const PROJECT_ID = 'project-1'
const WORK_SQUAD_ID = 'squad-work'
const DEPT_ID = 'dept-work'

describe('home squad memory isolation (FP-01 Slice 2, mupot#1443, brief §2 Task C)', () => {
  let harness: SqliteD1Harness
  let dbEnv: Env
  let env: Env
  let homeSquadId: string
  let vectors: Array<{ id: string; metadata: Record<string, unknown> }>

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    dbEnv = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env

    // Same fake AI/VEC double as tests/journey-new-member.test.ts (step 10)
    // and tests/mcp-squad-memory.test.ts — see the file header note above.
    vectors = []
    env = {
      ...dbEnv,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VEC: {
        upsert: async (rows: Array<{ id: string; metadata: Record<string, unknown> }>) => { vectors.push(...rows) },
        query: async (_values: number[], opts: { topK: number; filter: Record<string, unknown> }) => ({
          matches: vectors
            .filter(v => Object.entries(opts.filter).every(([key, value]) => v.metadata[key] === value))
            .slice(0, opts.topK)
            .map((v, index) => ({ id: v.id, score: 0.9 - index / 10 })),
        }),
      },
    } as unknown as Env

    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, NULL, 'Shadi', 'active', datetime('now'))`,
    ).bind(MEMBER_ID, TENANT).run()
    const home = await createHomeForMember(env, MEMBER_ID)
    if (!home.ok) throw new Error('home not created')
    homeSquadId = home.squad.id

    // A real, readable project — a work squad (NEVER the home) holds the
    // project_squad_access edge, exactly as #1472's own note documents
    // ("home's own outbound project grant... deliberately UNGUARDED... never
    // grants anyone entry INTO the squad itself"). This project is what
    // project_recall below reads from — the home squad has ZERO edges to it.
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'work', 'Work');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${WORK_SQUAD_ID}', '${DEPT_ID}', 'work', 'Work Squad');
      INSERT INTO projects (id, slug, name, status) VALUES ('${PROJECT_ID}', 'project-1', 'Project One', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJECT_ID}', '${WORK_SQUAD_ID}', 'write');
    `)
  })

  afterEach(() => harness.close())

  // An agent-bound seat whose capabilities snapshot equals Shadi's OWN grants
  // (the /enroll shape the brief's Slice 3 describes: "Shadi seats an agent
  // only if she holds admin on her OWN home") — admin on the home (the exact
  // grant createHomeForMember itself wrote) PLUS observer on the work squad,
  // so this same principal can also read project-1 below.
  function shadiSeatAuth(): AuthContext {
    return {
      userId: MEMBER_ID, memberId: MEMBER_ID, email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: AGENT_ID,
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' },
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: WORK_SQUAD_ID, capability: 'observer' },
      ],
    }
  }

  function orgAdminAuth(): AuthContext {
    return {
      userId: 'org-admin-1', memberId: 'org-admin-1', email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: null,
      capabilities: [{ member_id: 'org-admin-1', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
  }

  it("an agent bound to a member with a home writes squad_remember to the home", async () => {
    const result = await invokeTool(shadiSeatAuth(), env, 'squad_remember', {
      squad_id: homeSquadId,
      text: 'My name is Shadi. I captain Psychonom. First thing: write access on the project.',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // engram_id is the write confirmation (mupot#1486 binding input) —
    // asserted directly, not inferred from a subsequent recall.
    expect(result.result).toMatchObject({ squad_id: homeSquadId, scope: `squad:${homeSquadId}` })
    expect((result.result as { engram_id: string }).engram_id).toBeTruthy()

    const engramRow = harness.sqlite.prepare(
      `SELECT agent_id, text FROM engrams WHERE id = ?1`,
    ).get((result.result as { engram_id: string }).engram_id) as { agent_id: string; text: string }
    expect(engramRow.agent_id).toBe(`squad:${homeSquadId}`)
    expect(engramRow.text).toContain('Shadi')
  })

  it('project_recall on a project the member can read returns NOTHING from the home engram', async () => {
    await invokeTool(shadiSeatAuth(), env, 'squad_remember', {
      squad_id: homeSquadId,
      text: 'Home-only story: my birthday is in March.',
    })

    // Sanity: shadiSeatAuth() really can read project-1 (via WORK_SQUAD_ID's
    // observer grant) — a false negative here would make the isolation
    // assertion below meaningless.
    const recall = await invokeTool(shadiSeatAuth(), env, 'project_recall', {
      project_id: PROJECT_ID, query: 'birthday',
    })
    expect(recall.ok).toBe(true)
    if (!recall.ok) return
    expect(recall.result).toMatchObject({ project_id: PROJECT_ID, scope: `project:${PROJECT_ID}`, hits: [] })

    // Positive control: the SAME text IS recallable from its own home scope —
    // proves the fake VEC double actually round-trips, so the [] above means
    // isolation, not a broken double.
    const homeRecall = await invokeTool(shadiSeatAuth(), env, 'squad_recall', {
      squad_id: homeSquadId, query: 'birthday',
    })
    expect(homeRecall.ok).toBe(true)
    if (!homeRecall.ok) return
    expect((homeRecall.result as { hits: Array<{ text: string }> }).hits).toHaveLength(1)
    expect((homeRecall.result as { hits: Array<{ text: string }> }).hits[0].text).toContain('birthday')
  })

  it('squad_recall on the home by an org admin -> 403 (re-pins #1472\'s home-squad isolation invariant on the memory surface)', async () => {
    await invokeTool(shadiSeatAuth(), env, 'squad_remember', {
      squad_id: homeSquadId, text: 'Private engram an org admin must never read.',
    })

    const recall = await invokeTool(orgAdminAuth(), env, 'squad_recall', {
      squad_id: homeSquadId, query: 'private',
    })
    expect(recall.ok).toBe(false)
    expect((recall as unknown as { status: number }).status).toBe(403)

    // squad_member_list, same org-grant plane, same squad — cross-checked so
    // this isn't a fluke of squad_recall's own gate.
    const list = await invokeTool(orgAdminAuth(), env, 'squad_member_list', { squad: homeSquadId })
    expect(list.ok).toBe(false)
    expect((list as unknown as { status: number }).status).toBe(403)
  })
})

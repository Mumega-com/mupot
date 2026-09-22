// tests/team-bootstrap.test.ts — mupot#1498 (team_bootstrap: one call
// creates project-prj + squad-sqd + project bot + token claim + Hermes
// profile scaffold — new teams in one step).
//
// Real SQLite, EVERY migration applied, tools invoked through invokeTool
// (never a ToolSpec's .run() directly — scripts/check-mcp-tool-seam.mjs)
// so the AAGATE floor, the tool's own admin re-check, and the core
// src/org/team-bootstrap.ts batch all run exactly as production reaches
// them. AI/VEC are the same fake, synchronous double
// tests/home-memory-isolation.test.ts and tests/journey-new-member.test.ts
// already use — no real-engine test double for the memory port exists in
// this repo.

import { beforeEach, describe, expect, it } from 'vitest'
import { invokeTool, TOOLS } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const DEPT_ID = 'dept-eng'
const ADMIN_MEMBER_ID = 'member-admin'

const CTX = { origin: ORIGIN, transport: 'mcp' as const }

function makeSessionsKv() {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async get(key: string) {
      return store.get(key) ?? null
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

function makeEnv(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: makeSessionsKv(),
    AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
    VEC: {
      upsert: async () => undefined,
      query: async () => ({ matches: [] }),
    },
  } as unknown as Env
}

function orgAdminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ADMIN_MEMBER_ID,
    memberId: ADMIN_MEMBER_ID,
    email: 'admin@pot.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: ADMIN_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
    ...overrides,
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'eng', 'Engineering');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${ADMIN_MEMBER_ID}', 'admin@pot.test', 'Admin', 'active', '${TENANT}');
  `)
  return harness
}

describe('team_bootstrap — mupot#1498', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = makeHarness()
    env = makeEnv(harness)
  })

  it('is registered', () => {
    expect(TOOLS.find((t) => t.name === 'team_bootstrap')).toBeTruthy()
  })

  it('happy path: creates project-prj, squad-sqd, ADMIN edge, bot, invites, receipt — all in one call', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'psychonom',
        name: 'Psychonom',
        department: DEPT_ID,
        humans: [{ email: 'lead@example.com', capability: 'member' }],
        bot: { name: 'Psychonom Bot' },
        seed_memory: 'first note',
      },
      CTX,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as Record<string, unknown>

    expect(result.disposition).toBe('created')
    expect((result.project as Record<string, unknown>).slug).toBe('psychonom-prj')
    expect((result.project as Record<string, unknown>).created).toBe(true) // P0(b)
    expect((result.squad as Record<string, unknown>).slug).toBe('psychonom-sqd')
    expect((result.squad as Record<string, unknown>).created).toBe(true) // P0(b)
    expect((result.squad as Record<string, unknown>).department_id).toBe(DEPT_ID)
    expect(result.edge_kept).toBeNull() // P1-2: a fresh admin edge, nothing preserved
    expect(result.duplicate_emails_in_request).toEqual([]) // P2-1

    const bot = result.bot as Record<string, unknown>
    expect(bot.slug).toBe('psychonom-bot')
    expect(bot.created).toBe(true)

    const invites = result.invites as Array<Record<string, unknown>>
    expect(invites).toHaveLength(1)
    expect(invites[0].email).toBe('lead@example.com')
    expect(invites[0].created).toBe(true)
    expect(invites[0].url).toContain('/invite/')

    // Never a raw token — only a single-use claim.
    expect(result.credential_claim).toBeTruthy()
    const claim = result.credential_claim as Record<string, unknown>
    expect(typeof claim.claim_id).toBe('string')
    expect(JSON.stringify(result)).not.toMatch(/mupot_[0-9a-f]{16,}/)

    const scaffold = result.hermes_scaffold as Record<string, unknown>
    expect(Array.isArray(scaffold.profile_dir_layout)).toBe(true)
    expect(String(scaffold.mcp_config_template_with_claim_placeholder)).toContain(String(claim.claim_id))

    // ADMIN edge actually landed.
    const edge = await env.DB.prepare(
      'SELECT access_level FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
    ).bind((result.project as Record<string, unknown>).id, (result.squad as Record<string, unknown>).id).first<{ access_level: string }>()
    expect(edge?.access_level).toBe('admin')

    // Receipt row landed, append-only, frozen actor.
    const receipt = await env.DB.prepare('SELECT * FROM team_bootstrap_receipts WHERE id = ?')
      .bind(result.receipt_id)
      .first<Record<string, unknown>>()
    expect(receipt?.actor_member_id).toBe(ADMIN_MEMBER_ID)
    expect(receipt?.slug_base).toBe('psychonom')
    expect(receipt?.invited_count).toBe(1)

    // Seed memory landed (disposition:'created').
    const engram = await env.DB.prepare('SELECT text FROM engrams WHERE agent_id = ?')
      .bind(`project:${(result.project as Record<string, unknown>).id}`)
      .first<{ text: string }>()
    expect(engram?.text).toBe('first note')
  })

  it('idempotent on slug_base: second call reuses project/squad/bot, sends no duplicate invite, mints no second bot', async () => {
    const first = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'psychonom',
        name: 'Psychonom',
        department: DEPT_ID,
        humans: [{ email: 'lead@example.com', capability: 'member' }],
      },
      CTX,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstResult = first.result as Record<string, unknown>

    const second = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'psychonom',
        name: 'Psychonom',
        department: DEPT_ID,
        // same email again, plus one NEW one
        humans: [
          { email: 'lead@example.com', capability: 'member' },
          { email: 'second@example.com', capability: 'observer' },
        ],
      },
      CTX,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const secondResult = second.result as Record<string, unknown>

    expect((secondResult.project as Record<string, unknown>).id).toBe((firstResult.project as Record<string, unknown>).id)
    expect((secondResult.project as Record<string, unknown>).created).toBe(false) // P0(b): adopted, not re-created
    expect((secondResult.squad as Record<string, unknown>).id).toBe((firstResult.squad as Record<string, unknown>).id)
    expect((secondResult.squad as Record<string, unknown>).created).toBe(false)
    expect(secondResult.edge_kept).toBeNull() // already admin from the first call — nothing preserved below it

    const invites = secondResult.invites as Array<Record<string, unknown>>
    const repeated = invites.find((i) => i.email === 'lead@example.com')!
    const fresh = invites.find((i) => i.email === 'second@example.com')!
    expect(repeated.created).toBe(false)
    expect(repeated.id).toBe((firstResult.invites as Array<Record<string, unknown>>)[0].id)
    expect(fresh.created).toBe(true)

    const inviteCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE email = ?')
      .bind('lead@example.com')
      .first<{ n: number }>()
    expect(inviteCount?.n).toBe(1)

    // No second bot: only ONE agent row for this slug in this squad.
    const agentCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ? AND slug = ?')
      .bind((secondResult.squad as Record<string, unknown>).id, 'psychonom-bot')
      .first<{ n: number }>()
    expect(agentCount?.n).toBe(1)

    // Second call's bot is enabled by default too, but already exists.
    const bot = secondResult.bot as Record<string, unknown>
    expect(bot.created).toBe(false)
    // No second credential claim minted on replay.
    expect(secondResult.credential_claim).toBeNull()

    // ONE RECEIPT ROW PER ATTEMPT (P1-3, kasra-review adversarial round-1
    // gate on PR #1510) — two calls means two rows, each with its OWN
    // invited_count (what THAT attempt itself inserted, never a running
    // total), never a shared/overwritten row.
    const receipts = await env.DB.prepare(
      'SELECT attempt_no, disposition, invited_count FROM team_bootstrap_receipts WHERE slug_base = ? ORDER BY attempt_no',
    )
      .bind('psychonom')
      .all<{ attempt_no: number; disposition: string; invited_count: number }>()
    const rows = receipts.results ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ attempt_no: 1, disposition: 'created', invited_count: 1 })
    // 'adopted', not 'created' (P2-1 successor fix): the second call adopted
    // the already-existing project AND squad — 'created' fires only when
    // BOTH are newly made by the SAME attempt.
    expect(rows[1]).toMatchObject({ attempt_no: 2, disposition: 'adopted', invited_count: 1 })
  })

  // The old "rank ceiling" test that lived here called teamBootstrap() the
  // CORE FUNCTION directly with `capabilities: []` — a principal invokeTool
  // itself refuses (team_bootstrap's floor is org:admin, checked both at the
  // AAGATE and again by the ToolSpec's own hasWorkspaceAdmin re-check; there
  // is no lower-privilege path into this tool at all). That is exactly the
  // "no fixture may pre-state a precondition production cannot reach" defect
  // — kasra-review adversarial round-2 gate on PR #1510, finding 6,
  // 2026-09-22, which also proved the ceiling itself was unreachable in
  // production: org:admin's rank always dominates the 'observer'/'member'
  // ranks it compared against. The guard AND this test are deleted together
  // (successor decision — see src/org/team-bootstrap.ts's file header); if a
  // lower-privilege path into team_bootstrap is ever added, a per-human rank
  // ceiling belongs back here, proven with a principal invokeTool admits.

  it('refuses an agent-bound principal — grant tools never run as an agent', async () => {
    const outcome = await invokeTool(
      orgAdminAuth({ boundAgentId: 'agent-x' }),
      env,
      'team_bootstrap',
      { slug_base: 'psychonom', name: 'Psychonom', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('operator_principal_required')
  })

  it('AAGATE floor refuses a caller with no admin standing at all', async () => {
    const memberAuth: AuthContext = {
      userId: 'member-plain',
      memberId: 'member-plain',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: 'member-plain', scope_type: 'squad', scope_id: 'some-squad', capability: 'lead' }],
    }
    const outcome = await invokeTool(
      memberAuth,
      env,
      'team_bootstrap',
      { slug_base: 'psychonom', name: 'Psychonom', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('forbidden')
  })

  // Injects a synthetic failure on the FIRST statement matching `sqlSubstring`
  // while `active.value` is true — same real-D1-plus-targeted-injection
  // technique as envWithInjectedInviteFailure below, generalized for a
  // single statement rather than a per-row match. The whole file calls
  // applyAllMigrations(), so this is not a hand-rolled D1 mock.
  function envWithInjectedFailure(base: Env, sqlSubstring: string, active: { value: boolean }): Env {
    const realDb = base.DB
    return {
      ...base,
      DB: {
        ...realDb,
        prepare(sql: string) {
          const real = realDb.prepare(sql)
          if (!active.value || !sql.includes(sqlSubstring)) return real
          return {
            bind(...values: unknown[]) {
              void real.bind(...values)
              return {
                run: async () => {
                  throw new Error(`injected failure for test: ${sqlSubstring}`)
                },
              }
            },
          }
        },
      },
    } as unknown as Env
  }

  it('project_archived is refused BEFORE the squad is ever created', async () => {
    // Pre-seed an ARCHIVED project under the slug this call will resolve to.
    // P1-1 (kasra-review adversarial round-1 gate on PR #1510): this must be
    // caught immediately after project resolution — before the squad (and
    // its free-tier entitlement slot) is ever created.
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-archived', 'batchfail-prj', 'Batch Fail', 'archived');
    `)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'batchfail', name: 'Batch Fail', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('project_archived')
    expect(outcome.status).toBe(409)

    const squad = await env.DB.prepare('SELECT 1 FROM squads WHERE slug = ?').bind('batchfail-sqd').first()
    expect(squad).toBeNull()
    const receipt = await env.DB.prepare('SELECT 1 FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('batchfail')
      .first()
    expect(receipt).toBeNull()
  })

  it('stage-1 (edge+bot) batch failure leaves no edge/bot/invite rows, but IS receipted as failed', async () => {
    // Injects a failure on the ADMIN-edge INSERT itself (not an archived
    // project — that is now caught earlier, see the test above) so stage 1's
    // batch — edge + bot statements together — genuinely fails and rolls
    // back (tests/helpers/sqlite-d1.ts wraps every batch in BEGIN IMMEDIATE/
    // COMMIT/ROLLBACK). Stage 2 (invites) is never reached. The failure is
    // still receipted — migration 0166's 'failed' disposition exists exactly
    // for this (Athena round-1 gate on PR #1510).
    const injection = { value: true }
    const injectedEnv = envWithInjectedFailure(env, 'INSERT INTO project_squad_access', injection)

    const outcome = await invokeTool(
      orgAdminAuth(),
      injectedEnv,
      'team_bootstrap',
      {
        slug_base: 'batchfail',
        name: 'Batch Fail',
        department: DEPT_ID,
        humans: [{ email: 'victim@example.com', capability: 'member' }],
        bot: { name: 'Batchfail Bot' },
      },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('provisioning_failed')
    expect(outcome.status).toBe(400)
    expect((outcome.detail as Record<string, unknown>).stage).toBe('edge_or_bot')

    // The project + squad WERE created before the write phase (their own
    // independent commits — see the file header) — but nothing from stage 1
    // landed.
    const project = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind('batchfail-prj').first<{ id: string }>()
    const squad = await env.DB.prepare('SELECT id FROM squads WHERE slug = ?').bind('batchfail-sqd').first<{ id: string }>()
    expect(project).toBeTruthy()
    expect(squad).toBeTruthy()

    const edge = await env.DB.prepare('SELECT 1 FROM project_squad_access WHERE project_id = ?')
      .bind(project!.id)
      .first()
    expect(edge).toBeNull()
    const bot = await env.DB.prepare('SELECT 1 FROM agents WHERE slug = ?').bind('batchfail-bot').first()
    expect(bot).toBeNull()
    const invite = await env.DB.prepare('SELECT 1 FROM invites WHERE email = ?').bind('victim@example.com').first()
    expect(invite).toBeNull()

    // The failure itself is receipted — no PII in the reason, a real
    // structural classification instead.
    const receipt = await env.DB.prepare(
      'SELECT disposition, failed_step, failure_reason, invited_count, project_id, squad_id, bot_agent_id FROM team_bootstrap_receipts WHERE slug_base = ?',
    )
      .bind('batchfail')
      .first<{
        disposition: string
        failed_step: string | null
        failure_reason: string | null
        invited_count: number
        project_id: string
        squad_id: string
        bot_agent_id: string | null
      }>()
    expect(receipt?.disposition).toBe('failed')
    expect(receipt?.failed_step).toBe('edge_or_bot')
    expect(receipt?.failure_reason).toBe('write_failed')
    expect(receipt?.failure_reason).not.toMatch(/@/) // no email/PII leaked into the reason
    expect(receipt?.invited_count).toBe(0)
    expect(receipt?.project_id).toBe(project!.id)
    expect(receipt?.squad_id).toBe(squad?.id)
    expect(receipt?.bot_agent_id).toBeNull()
  })

  it('suffix validation: rejects a slug_base that already carries a kind suffix', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'psychonom-prj', name: 'Psychonom', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('invalid_slug_base')
  })

  it('rejects an invalid human capability (only observer|member are legal)', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'psychonom',
        name: 'Psychonom',
        department: DEPT_ID,
        humans: [{ email: 'x@example.com', capability: 'owner' }],
      },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('invalid_human_capability')
  })

  it('bot.enabled === false skips bot creation and mints no credential claim', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'psychonom', name: 'Psychonom', department: DEPT_ID, bot: { enabled: false } },
      CTX,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as Record<string, unknown>
    expect(result.bot).toBeNull()
    expect(result.credential_claim).toBeNull()
    const agentCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?')
      .bind((result.squad as Record<string, unknown>).id)
      .first<{ n: number }>()
    expect(agentCount?.n).toBe(0)
  })

  it('department_not_found is refused before any write', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'ghost', name: 'Ghost', department: 'no-such-department' },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('department_not_found')
    const project = await env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?').bind('ghost-prj').first()
    expect(project).toBeNull()
  })

  // ── partial-failure retry (Athena round-1 gate on PR #1510, 2026-09-22) ──
  //
  // Wraps the REAL D1 harness's prepare() so exactly ONE targeted invite
  // INSERT throws a synthetic unique-violation-shaped error — every other
  // statement (project/squad/edge/bot/every other invite) goes through the
  // genuine SQLite engine untouched. This is not a hand-rolled D1 mock: the
  // whole file calls applyAllMigrations() (see the top-of-file note and
  // scripts/check-test-schema-source.mjs), so every read this test makes is
  // a real query against the real schema — only the ONE write this test
  // needs to fail is intercepted.
  function envWithInjectedInviteFailure(base: Env, failOnEmail: string, active: { value: boolean }): Env {
    const realDb = base.DB
    return {
      ...base,
      DB: {
        ...realDb,
        prepare(sql: string) {
          const real = realDb.prepare(sql)
          if (!sql.includes('INSERT INTO invites')) return real
          return {
            bind(...values: unknown[]) {
              const boundReal = real.bind(...values)
              const email = values[1]
              const shouldFail = active.value && typeof email === 'string' && email.toLowerCase() === failOnEmail
              if (!shouldFail) return boundReal
              return {
                run: async () => {
                  throw new Error('UNIQUE constraint failed: invites.email (injected for test)')
                },
              }
            },
          }
        },
      },
    } as unknown as Env
  }

  it('partial-failure retry: batch fails on invite 3 of 5, orphan project+squad+bot persist, retry adopts and finishes — zero duplicate invites, one bot, one ADMIN edge', async () => {
    const humans = [
      { email: 'a@example.com', capability: 'member' as const },
      { email: 'b@example.com', capability: 'member' as const },
      { email: 'c@example.com', capability: 'member' as const }, // this one is made to fail on attempt 1
      { email: 'd@example.com', capability: 'member' as const },
      { email: 'e@example.com', capability: 'member' as const },
    ]
    const injection = { value: true }
    const injectedEnv = envWithInjectedInviteFailure(env, 'c@example.com', injection)

    const first = await invokeTool(
      orgAdminAuth(),
      injectedEnv,
      'team_bootstrap',
      { slug_base: 'partial', name: 'Partial Team', department: DEPT_ID, humans, bot: { name: 'Partial Bot' } },
      CTX,
    )
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.error).toBe('provisioning_failed')
    expect((first.detail as Record<string, unknown>).stage).toBe('invite_insert')

    // ORPHAN, RESUMABLE state after attempt 1: project + squad + bot + edge
    // + invites a/b are all real, already-committed rows.
    const project = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind('partial-prj').first<{ id: string }>()
    const squad = await env.DB.prepare('SELECT id FROM squads WHERE slug = ?').bind('partial-sqd').first<{ id: string }>()
    expect(project).toBeTruthy()
    expect(squad).toBeTruthy()

    const edgeAfterFirst = await env.DB.prepare(
      'SELECT access_level FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
    ).bind(project!.id, squad!.id).first<{ access_level: string }>()
    expect(edgeAfterFirst?.access_level).toBe('admin')

    const botAfterFirst = await env.DB.prepare('SELECT id FROM agents WHERE squad_id = ? AND slug = ?')
      .bind(squad!.id, 'partial-bot')
      .first<{ id: string }>()
    expect(botAfterFirst).toBeTruthy()

    const invitedEmailsAfterFirst = await env.DB.prepare('SELECT email FROM invites WHERE squad_id = ? ORDER BY email')
      .bind(squad!.id)
      .all<{ email: string }>()
    expect((invitedEmailsAfterFirst.results ?? []).map((r) => r.email)).toEqual(['a@example.com', 'b@example.com'])

    // The failed attempt is receipted: invited_count=2 (a, b landed before c failed).
    const failedReceipt = await env.DB.prepare(
      'SELECT id, disposition, failed_step, failure_reason, invited_count, project_id, squad_id, bot_agent_id FROM team_bootstrap_receipts WHERE slug_base = ?',
    )
      .bind('partial')
      .first<{
        id: string
        disposition: string
        failed_step: string | null
        failure_reason: string | null
        invited_count: number
        project_id: string
        squad_id: string
        bot_agent_id: string | null
      }>()
    expect(failedReceipt?.disposition).toBe('failed')
    expect(failedReceipt?.failed_step).toBe('invite_insert')
    expect(failedReceipt?.failure_reason).toBe('unique_violation')
    expect(failedReceipt?.failure_reason).not.toMatch(/@/)
    expect(failedReceipt?.invited_count).toBe(2)
    expect(failedReceipt?.project_id).toBe(project!.id)
    expect(failedReceipt?.squad_id).toBe(squad!.id)
    expect(failedReceipt?.bot_agent_id).toBe(botAfterFirst!.id)

    // Retry: same slug_base, same 5 humans, injection turned OFF.
    injection.value = false
    const second = await invokeTool(
      orgAdminAuth(),
      injectedEnv, // same wrapper, but injection.value is now false — every insert goes through
      'team_bootstrap',
      { slug_base: 'partial', name: 'Partial Team', department: DEPT_ID, humans, bot: { name: 'Partial Bot' } },
      CTX,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const secondResult = second.result as Record<string, unknown>

    // MUTATION TARGET: breaking the adopt path (e.g. always creating a new
    // project/squad instead of finding-then-creating) turns this red.
    expect((secondResult.project as Record<string, unknown>).id).toBe(project!.id)
    expect((secondResult.squad as Record<string, unknown>).id).toBe(squad!.id)

    const invites = secondResult.invites as Array<Record<string, unknown>>
    expect(invites).toHaveLength(5)
    const byEmail = Object.fromEntries(invites.map((i) => [i.email, i]))
    expect(byEmail['a@example.com'].created).toBe(false)
    expect(byEmail['b@example.com'].created).toBe(false)
    expect(byEmail['c@example.com'].created).toBe(true)
    expect(byEmail['d@example.com'].created).toBe(true)
    expect(byEmail['e@example.com'].created).toBe(true)

    // Zero duplicate invites per email.
    const allInvites = await env.DB.prepare('SELECT email, COUNT(*) AS n FROM invites WHERE squad_id = ? GROUP BY email')
      .bind(squad!.id)
      .all<{ email: string; n: number }>()
    expect(allInvites.results ?? []).toHaveLength(5)
    for (const row of allInvites.results ?? []) expect(row.n).toBe(1)

    // One bot — no second agent minted on retry.
    const botCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ? AND slug = ?')
      .bind(squad!.id, 'partial-bot')
      .first<{ n: number }>()
    expect(botCount?.n).toBe(1)
    expect((secondResult.bot as Record<string, unknown>).created).toBe(false)

    // One ADMIN edge — no duplicate, still admin.
    const edgeCount = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(access_level) AS lvl FROM project_squad_access WHERE project_id = ? AND squad_id = ?')
      .bind(project!.id, squad!.id)
      .first<{ n: number; lvl: string }>()
    expect(edgeCount?.n).toBe(1)
    expect(edgeCount?.lvl).toBe('admin')

    // ONE RECEIPT ROW PER ATTEMPT (P1-3): the failed attempt's row is NEVER
    // rewritten — a second, NEW row records the successful retry, ordered by
    // attempt_no. invited_count on the second row is what THAT attempt
    // itself inserted (3: c, d, e) — never a running total (5).
    const allReceipts = await env.DB.prepare(
      'SELECT id, attempt_no, disposition, failed_step, failure_reason, invited_count FROM team_bootstrap_receipts WHERE slug_base = ? ORDER BY attempt_no',
    )
      .bind('partial')
      .all<{
        id: string
        attempt_no: number
        disposition: string
        failed_step: string | null
        failure_reason: string | null
        invited_count: number
      }>()
    const receiptRows = allReceipts.results ?? []
    expect(receiptRows).toHaveLength(2)
    expect(receiptRows[0].id).toBe(failedReceipt!.id)
    expect(receiptRows[0].attempt_no).toBe(1)
    expect(receiptRows[0].disposition).toBe('failed')

    expect(receiptRows[1].attempt_no).toBe(2)
    expect(receiptRows[1].id).not.toBe(failedReceipt!.id) // a NEW row, not the same one rewritten
    // 'adopted', not 'created' (P2-1 successor fix): both project and squad
    // already existed when this attempt ran — it only finished the
    // remaining invites. 'created' fires ONLY when BOTH are newly made by
    // the SAME attempt.
    expect(receiptRows[1].disposition).toBe('adopted')
    expect(receiptRows[1].failed_step).toBeNull()
    expect(receiptRows[1].failure_reason).toBeNull()
    expect(receiptRows[1].invited_count).toBe(3)
  })

  // ── P0: adoption without ownership (kasra-review adversarial round-1 gate
  // on PR #1510, same class as #1507's P0-4) ─────────────────────────────────
  it('squad squat: a squad admin cannot pre-name a target squad to steal a future bootstrap\'s ADMIN edge + mintable bot', async () => {
    // The attacker renames (or creates) a squad to the EXACT slug a future
    // team_bootstrap('hijack', ...) call will resolve to, and holds a real
    // capability grant on it — squadIsAdoptable must refuse this squad, not
    // silently adopt it just because the (department_id, slug) pair matches.
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-hijack', '${DEPT_ID}', 'hijack-sqd', 'Squatted Squad');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-attacker', 'attacker@pot.test', 'Attacker', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-attacker', 'member-attacker', 'squad', 'squad-hijack', 'admin');
    `)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'hijack', name: 'Hijack Target', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('squad_slug_taken')
    expect(outcome.status).toBe(409)
    const detail = outcome.detail as Record<string, unknown>
    expect(detail.squad_id).toBe('squad-hijack')
    expect(Array.isArray(detail.owners)).toBe(true)
    expect((detail.owners as Array<Record<string, unknown>>).some((o) => o.member_id === 'member-attacker')).toBe(true)

    // ZERO edges — the attacker's squad never got wired onto the project.
    const edges = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = ?')
      .bind('squad-hijack')
      .first<{ n: number }>()
    expect(edges?.n).toBe(0)
    // No bot placed in the squatted squad either.
    const agentCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?')
      .bind('squad-hijack')
      .first<{ n: number }>()
    expect(agentCount?.n).toBe(0)
    // A 'failed' attempt receipt IS now written for this refusal (P1-A
    // successor fix: round-2 silently returned with zero receipt, leaving no
    // retry-surface trail; see migration 0166's `name_resolution` step). The
    // project was never created either — both names are resolved and
    // checked before any create — so project_id on this row is NULL.
    const receipt = await env.DB.prepare(
      'SELECT disposition, failed_step, failure_reason, project_id, squad_id FROM team_bootstrap_receipts WHERE slug_base = ?',
    )
      .bind('hijack')
      .first<{ disposition: string; failed_step: string; failure_reason: string; project_id: string | null; squad_id: string | null }>()
    expect(receipt?.disposition).toBe('failed')
    expect(receipt?.failed_step).toBe('name_resolution')
    expect(receipt?.failure_reason).toBe('squad_slug_taken')
    expect(receipt?.project_id).toBeNull()
    expect(receipt?.squad_id).toBe('squad-hijack')
  })

  it('adopt:true + org:admin is an EXPLICIT, RECEIPTED override — disposition \'adopted\', actor recorded', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-claim', '${DEPT_ID}', 'claimed-sqd', 'Pre-existing Squad');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-prior', 'prior@pot.test', 'Prior Owner', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-prior', 'member-prior', 'squad', 'squad-claim', 'admin');
    `)

    // Without adopt:true, this is the same refusal as the squat test above.
    const refused = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'claimed', name: 'Claimed Team', department: DEPT_ID },
      CTX,
    )
    expect(refused.ok).toBe(false)

    // With adopt:true AND org:admin (orgAdminAuth already is), the override
    // is honored — Athena, round-2 sharpening: "find-or-create is create +
    // explicit adopt" — receipted as its own disposition, never silently
    // folded into 'existing'.
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'claimed', name: 'Claimed Team', department: DEPT_ID, adopt: true },
      CTX,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as Record<string, unknown>
    expect(result.disposition).toBe('adopted')
    expect((result.squad as Record<string, unknown>).id).toBe('squad-claim')
    expect((result.squad as Record<string, unknown>).created).toBe(false)

    // The FIRST (refused) call also wrote a 'failed' name_resolution receipt
    // naming this same squad_id (P1-A successor fix) — order by attempt_no
    // to fetch the SECOND, successful attempt's row, not whichever the
    // unordered query happens to return first.
    const receipt = await env.DB.prepare(
      'SELECT disposition, actor_member_id, squad_id FROM team_bootstrap_receipts WHERE slug_base = ? AND squad_id = ? ORDER BY attempt_no DESC LIMIT 1',
    )
      .bind('claimed', 'squad-claim')
      .first<{ disposition: string; actor_member_id: string; squad_id: string }>()
    expect(receipt?.disposition).toBe('adopted')
    expect(receipt?.actor_member_id).toBe(ADMIN_MEMBER_ID)
    expect(receipt?.squad_id).toBe('squad-claim')
  })

  // ── P1-2: the ADMIN edge is never silently raised ─────────────────────────
  it('edge_kept: a deliberate non-admin edge is preserved, never raised to admin', async () => {
    // Pre-seed the project, squad, AND a deliberate 'read' edge between them
    // — team_bootstrap must adopt both but leave the edge exactly as it was.
    // created_by_member_id = the calling admin — this test is about edge_kept
    // preservation, not adoption, so the pre-seeded rows are provenance-owned
    // by the same caller that will run team_bootstrap on them.
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status, created_by_member_id) VALUES ('proj-readonly', 'readonly-prj', 'Read Only', 'active', '${ADMIN_MEMBER_ID}');
      INSERT INTO squads (id, department_id, slug, name, created_by_member_id) VALUES ('squad-readonly', '${DEPT_ID}', 'readonly-sqd', 'Read Only Squad', '${ADMIN_MEMBER_ID}');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-readonly', 'squad-readonly', 'read');
    `)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'readonly', name: 'Read Only', department: DEPT_ID, bot: { enabled: false } },
      CTX,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as Record<string, unknown>
    expect(result.edge_kept).toBe('read')

    const edge = await env.DB.prepare('SELECT access_level FROM project_squad_access WHERE project_id = ? AND squad_id = ?')
      .bind('proj-readonly', 'squad-readonly')
      .first<{ access_level: string }>()
    expect(edge?.access_level).toBe('read') // MUTATION TARGET: never raised to admin
  })

  // ── P1-1: archived project is a typed refusal (see the dedicated test
  //    above too — this one asserts the trigger-error MAPPING as a backstop) ─
  it('a project archived in the RACE WINDOW between the check and the edge insert maps to a typed archived_project reason', async () => {
    // Deliberately construct the race the upfront status check cannot see:
    // resolve project active, then archive it before stage 1's edge INSERT
    // runs, by hooking the SAME injection wrapper to archive the project on
    // the first statement touching project_squad_access.
    // created_by_member_id = the calling admin — provenance-adoptable, so
    // this test exercises the archived-race path rather than tripping the
    // project_slug_taken refusal instead.
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status, created_by_member_id) VALUES ('proj-race', 'race-prj', 'Race', 'active', '${ADMIN_MEMBER_ID}');
    `)
    const base = env
    let armed = true
    const raceEnv: Env = {
      ...base,
      DB: {
        ...base.DB,
        prepare(sql: string) {
          const real = base.DB.prepare(sql)
          if (armed && sql.includes('INSERT INTO project_squad_access')) {
            armed = false
            harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'proj-race'`)
          }
          return real
        },
      },
    } as unknown as Env

    const outcome = await invokeTool(
      orgAdminAuth(),
      raceEnv,
      'team_bootstrap',
      { slug_base: 'race', name: 'Race', department: DEPT_ID, bot: { enabled: false } },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('provisioning_failed')
    expect((outcome.detail as Record<string, unknown>).stage).toBe('edge_or_bot')
    expect((outcome.detail as Record<string, unknown>).reason).toBe('archived_project')

    const receipt = await env.DB.prepare('SELECT failure_reason FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('race')
      .first<{ failure_reason: string }>()
    expect(receipt?.failure_reason).toBe('archived_project')
  })

  // ── P2-1: within-call email dedupe ─────────────────────────────────────────
  it('dedupes the SAME email appearing twice in one call\'s humans[] — first occurrence wins, reported in duplicate_emails_in_request', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'dedupe',
        name: 'Dedupe Team',
        department: DEPT_ID,
        humans: [
          { email: 'Dup@Example.com', capability: 'member' },
          { email: 'dup@example.com', capability: 'observer' }, // same address, different case + capability
        ],
        bot: { enabled: false },
      },
      CTX,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as Record<string, unknown>
    expect(result.duplicate_emails_in_request).toEqual(['dup@example.com'])
    const invites = result.invites as Array<Record<string, unknown>>
    expect(invites).toHaveLength(1)
    expect(invites[0].capability).toBe('member') // first occurrence's capability wins

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE lower(email) = ?')
      .bind('dup@example.com')
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  // ── P2-2: a replay must report the STORED capability, never the requested one ──
  it('replay with a DIFFERENT capability for a live invite reports the STORED capability, not the request', async () => {
    const first = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'restamp',
        name: 'Restamp Team',
        department: DEPT_ID,
        humans: [{ email: 'x@example.com', capability: 'member' }],
        bot: { enabled: false },
      },
      CTX,
    )
    expect(first.ok).toBe(true)

    const second = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      {
        slug_base: 'restamp',
        name: 'Restamp Team',
        department: DEPT_ID,
        humans: [{ email: 'x@example.com', capability: 'observer' }], // different capability requested
        bot: { enabled: false },
      },
      CTX,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const result = second.result as Record<string, unknown>
    const invites = result.invites as Array<Record<string, unknown>>
    expect(invites[0].created).toBe(false)
    expect(invites[0].capability).toBe('member') // STORED, not the requested 'observer'

    const stored = await env.DB.prepare('SELECT capability FROM invites WHERE lower(email) = ?')
      .bind('x@example.com')
      .first<{ capability: string }>()
    expect(stored?.capability).toBe('member') // untouched by the replay
  })

  // ── P2-3: actor_member_id guard at the boundary ───────────────────────────
  it('refuses a caller with no memberId at all, before any write (actor_required)', async () => {
    const noMemberAuth: AuthContext = {
      userId: 'u-no-member',
      email: null,
      role: 'admin', // legacy-role org-admin passes the tool's hasWorkspaceAdmin floor
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
    }
    const outcome = await invokeTool(
      noMemberAuth,
      env,
      'team_bootstrap',
      { slug_base: 'noactor', name: 'No Actor', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('actor_required')
    expect(outcome.status).toBe(400)
    const project = await env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?').bind('noactor-prj').first()
    expect(project).toBeNull()
  })

  // ── P2-6 / P2-8: length caps ───────────────────────────────────────────────
  it('rejects a slug_base too long for every derived slug to stay valid (44-char ceiling)', async () => {
    const tooLong = 'a'.repeat(45)
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: tooLong, name: 'Too Long', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('invalid_slug_base')

    // exactly 44 chars is fine (44 + 4-char suffix = 48, isValidSlug's own ceiling).
    const fits = 'b'.repeat(44)
    const ok = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: fits, name: 'Fits', department: DEPT_ID, bot: { enabled: false } },
      CTX,
    )
    expect(ok.ok).toBe(true)
  })

  it('rejects a name over the length cap', async () => {
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'longname', name: 'x'.repeat(201), department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('invalid_name')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SUCCESSOR TO PR #1510 — kasra-review adversarial round-2 gate on
// 29728793a300970c4f351e7c5817e63daa01cfb3, 2026-09-22, P0 (two limbs):
// round-2 built an ownership ground ONLY for the squad find-or-create,
// leaving the PROJECT find-or-create with none. These tests reproduce the
// review's OWN reproduction — a principal whose ENTIRE standing is 'lead' on
// its own squad, no admin anywhere, acting under a time-boxed human-approved
// elevation — through invokeTool end-to-end (check_in, elevation request,
// elevation decision, the planting call, then the admin's team_bootstrap),
// never by hand-constructing an AuthContext the tool itself would refuse.
// ═══════════════════════════════════════════════════════════════════════════
describe('team_bootstrap successor (mupot#1498 P0/P1/P2/P3, PR #1510 round-2 gate) — provenance, resolve-before-create, home fence', () => {
  const LEAD_SQUAD_ID = 'squad-lead-own-tb'
  const LEAD_AGENT_ID = 'agent-lead-tb'
  const LEAD_MEMBER_ID = 'member-lead-tb'
  const LEAD_TOKEN_ID = 'tok-lead-tb'
  const APPROVER_MEMBER_ID = 'member-approver-tb'
  const APPROVER_IDENTITY_ID = 'identity-approver-tb'

  let harness: SqliteD1Harness
  let env: Env

  function seedLeadFixture(sqlite: SqliteD1Harness['sqlite']): void {
    sqlite.exec(`
      -- Lift the plan quota — free tier's maxSquads:1 would otherwise make
      -- the lead's OWN pre-existing squad below count as the whole budget,
      -- and every "cannot" in this file has to fail for the right reason.
      INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;

      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('${LEAD_SQUAD_ID}', '${DEPT_ID}', 'lead-own-tb', 'Lead Own Squad');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('${LEAD_AGENT_ID}', '${LEAD_SQUAD_ID}', 'lead-agent-tb', 'Lead Agent', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES
        ('${LEAD_MEMBER_ID}', 'Lead Member', 'active', '${TENANT}'),
        ('${APPROVER_MEMBER_ID}', 'Approver', 'active', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${LEAD_AGENT_ID}', '${LEAD_MEMBER_ID}', '2026-09-01T00:00:00Z');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
        VALUES ('${LEAD_TOKEN_ID}', '${LEAD_MEMBER_ID}', 'hash-lead-tb-1', 'primary', 'workspace', '${TENANT}', '${LEAD_AGENT_ID}', datetime('now'));

      -- THE ENTIRE STANDING AUTHORITY OF THE LEAD: 'lead' on its OWN squad.
      -- No org row. No department row. No admin anywhere.
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-lead-own-tb', '${LEAD_MEMBER_ID}', 'squad', '${LEAD_SQUAD_ID}', 'lead');

      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-approver-tb', '${APPROVER_MEMBER_ID}', 'org', NULL, 'admin');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('${APPROVER_IDENTITY_ID}', '${TENANT}', 'google', '${APPROVER_MEMBER_ID}', 'approver-tb@x.test', '${APPROVER_MEMBER_ID}', datetime('now'));
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

  async function checkIn(): Promise<string> {
    const res = await invokeTool(leadAuth(), env, 'check_in', {}, CTX)
    if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
    return (res.result as { agent_session: { id: string } }).agent_session.id
  }

  /** Returns the elevation_grants.id — the "receipt" a create under this
   *  elevation should end up stamped with (Athena ruling, mupot seq 5238). */
  async function approve(
    sessionId: string,
    actions: string[],
    scopeType: 'org' | 'department' | 'squad',
    scopeId: string,
    nowMs: number,
  ): Promise<string> {
    const approverSession = await createWebSession(
      env,
      `raw-approver-tb-${scopeType}-${scopeId}-${nowMs}`,
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
        durationMinutes: 60,
        reason: 'team-bootstrap successor test — standing up my own squad/project',
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
        decidedByCapabilities: [
          { member_id: APPROVER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
        ],
        decidedByWebSessionHash: approverSession.id_hash,
        recentReauthOk: true,
      },
      nowMs,
    )
    if (!decision.ok) throw new Error(`approve: decision failed: ${JSON.stringify(decision)}`)
    return decision.grants[0].id
  }

  beforeEach(() => {
    harness = makeHarness()
    seedLeadFixture(harness.sqlite)
    env = makeEnv(harness)
  })

  it('P0(a): a project planted by a squad lead under an org-scoped elevation is NOT silently adopted by the admin\'s later team_bootstrap — refused project_slug_taken, naming the planter', async () => {
    const sessionId = await checkIn()
    const nowMs = Date.now()
    const grantId = await approve(sessionId, ['action:workspace_project'], 'org', '', nowMs)

    const planted = await invokeTool(
      leadAuth(),
      env,
      'project_create',
      { slug: 'leadproj-prj', name: 'Lead Planted Project' },
      CTX,
    )
    expect(planted.ok).toBe(true)
    if (!planted.ok) return
    const plantedProject = planted.result as {
      project: { id: string; name: string; created_by_member_id: string | null; created_via_receipt: string | null }
    }
    expect(plantedProject.project.created_by_member_id).toBe(LEAD_MEMBER_ID)
    // Athena ruling (mupot seq 5238): stamped with the elevation_grants.id
    // that authorized this create, not just the actor.
    expect(plantedProject.project.created_via_receipt).toBe(grantId)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'leadproj', name: 'Admin Team', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('project_slug_taken')
    expect(outcome.status).toBe(409)
    const detail = outcome.detail as Record<string, unknown>
    expect(detail.project_id).toBe(plantedProject.project.id)
    expect(detail.created_by_member_id).toBe(LEAD_MEMBER_ID)
    expect(detail.created_via_receipt).toBe(grantId)
    expect(detail.summary).toBe(`created by member ${LEAD_MEMBER_ID} under elevation receipt ${grantId}`)

    // The planter's own fields survive untouched — never adopted, never
    // silently claimed by the admin's call.
    const projectRow = await env.DB.prepare('SELECT name, created_by_member_id FROM projects WHERE id = ?')
      .bind(plantedProject.project.id)
      .first<{ name: string; created_by_member_id: string }>()
    expect(projectRow?.name).toBe('Lead Planted Project')
    expect(projectRow?.created_by_member_id).toBe(LEAD_MEMBER_ID)

    // P1-A: resolve BOTH names before creating EITHER — the squad limb was
    // never even attempted once the project limb refused, so no orphan squad.
    const squad = await env.DB.prepare("SELECT 1 FROM squads WHERE slug = 'leadproj-sqd'").first()
    expect(squad).toBeNull()
    // No edge, no receipt claiming this project as team_bootstrap's own.
    const edge = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_squad_access WHERE project_id = ?')
      .bind(plantedProject.project.id)
      .first<{ n: number }>()
    expect(edge?.n).toBe(0)
  })

  it('P0(b): a squad planted by a squad lead under a department-scoped elevation is EMPTY (zero agents, zero capabilities) yet still refused — provenance replaced emptiness as the adoption ground', async () => {
    const sessionId = await checkIn()
    const nowMs = Date.now()
    const grantId = await approve(sessionId, ['action:project_lifecycle'], 'department', DEPT_ID, nowMs)

    const planted = await invokeTool(
      leadAuth(),
      env,
      'create_squad',
      { department: DEPT_ID, slug: 'leadsqd-sqd', name: 'Lead Planted Squad' },
      CTX,
    )
    expect(planted.ok).toBe(true)
    if (!planted.ok) return
    const plantedSquad = planted.result as {
      squad: { id: string; created_by_member_id: string | null; created_via_receipt: string | null }
    }
    expect(plantedSquad.squad.created_by_member_id).toBe(LEAD_MEMBER_ID)
    expect(plantedSquad.squad.created_via_receipt).toBe(grantId)

    // Confirm it really is EMPTY — the exact ground round-2 wrongly trusted.
    const agentCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?')
      .bind(plantedSquad.squad.id)
      .first<{ n: number }>()
    expect(agentCount?.n).toBe(0)
    const capCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM capabilities WHERE scope_type = 'squad' AND scope_id = ?",
    )
      .bind(plantedSquad.squad.id)
      .first<{ n: number }>()
    expect(capCount?.n).toBe(0)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'leadsqd', name: 'Admin Team', department: DEPT_ID },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('squad_slug_taken')
    const detail = outcome.detail as Record<string, unknown>
    expect(detail.squad_id).toBe(plantedSquad.squad.id)
    expect(detail.created_by_member_id).toBe(LEAD_MEMBER_ID)
    expect(detail.created_via_receipt).toBe(grantId)
    expect(detail.summary).toBe(`created by member ${LEAD_MEMBER_ID} under elevation receipt ${grantId}`)

    // P1-A: the project limb was never attempted either — no orphan project
    // reserving `leadsqd-prj` forever.
    const project = await env.DB.prepare("SELECT 1 FROM projects WHERE slug = 'leadsqd-prj'").first()
    expect(project).toBeNull()

    // No edge, no bot placed in the planted squad.
    const edgeCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = ?')
      .bind(plantedSquad.squad.id)
      .first<{ n: number }>()
    expect(edgeCount?.n).toBe(0)
  })

  // ── P2-4: home fence — never adoptable, even with adopt:true ──────────────
  it('never adopts a kind=home squad, even with adopt:true by org:admin (latent-only in production — the canonical home slug cannot end in -sqd — but fenced explicitly here)', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind, created_by_member_id)
        VALUES ('squad-home-plant-tb', '${DEPT_ID}', 'homefence-sqd', 'Planted Home', 'home', '${ADMIN_MEMBER_ID}');
    `)
    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
      'team_bootstrap',
      { slug_base: 'homefence', name: 'Home Fence Test', department: DEPT_ID, adopt: true },
      CTX,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('cannot_adopt_home_squad')
    expect(outcome.status).toBe(403)

    const edgeCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = ?')
      .bind('squad-home-plant-tb')
      .first<{ n: number }>()
    expect(edgeCount?.n).toBe(0)
    const receipt = await env.DB.prepare(
      'SELECT disposition, failed_step FROM team_bootstrap_receipts WHERE slug_base = ?',
    )
      .bind('homefence')
      .first<{ disposition: string; failed_step: string }>()
    expect(receipt?.disposition).toBe('failed')
    expect(receipt?.failed_step).toBe('name_resolution')
  })
})

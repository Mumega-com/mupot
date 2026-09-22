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
import { teamBootstrap } from '../src/org/team-bootstrap'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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
    expect(rows[1]).toMatchObject({ attempt_no: 2, disposition: 'created', invited_count: 1 })
  })

  it('rank ceiling: cannot invite a human above the caller\'s own rank on the (new) squad', async () => {
    // Calls the core function directly with a ZERO-standing actor — this is
    // the defense-in-depth check documented in src/org/team-bootstrap.ts's
    // file header (the MCP tool's own org-admin gate is a SEPARATE line of
    // defense, exercised by the 'agent-bound token refused' + 'requires org
    // admin' cases below).
    const noStandingAuth: AuthContext = {
      userId: 'member-nobody',
      memberId: 'member-nobody',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    }
    harness.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-nobody', 'nobody@pot.test', 'Nobody', 'active', '${TENANT}')`)

    const result = await teamBootstrap(env, noStandingAuth, {
      slug_base: 'ceiling-test',
      name: 'Ceiling Test',
      department: DEPT_ID,
      humans: [{ email: 'someone@example.com', capability: 'observer' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_invite_above_own_rank')

    // MUTATION TARGET (P1-4, kasra-review adversarial round-1 gate on PR
    // #1510): the ceiling now runs on DEPARTMENT scope BEFORE project/squad
    // are ever created — a mutation that moves it back to AFTER the creates
    // (its old position) turns these two assertions red, because the
    // project/squad would then exist despite the refusal.
    const project = await env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?').bind('ceiling-test-prj').first()
    expect(project).toBeNull()
    const squad = await env.DB.prepare('SELECT 1 FROM squads WHERE slug = ?').bind('ceiling-test-sqd').first()
    expect(squad).toBeNull()

    const receipt = await env.DB.prepare('SELECT 1 FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('ceiling-test')
      .first()
    expect(receipt).toBeNull()
    const invite = await env.DB.prepare('SELECT 1 FROM invites WHERE email = ?')
      .bind('someone@example.com')
      .first()
    expect(invite).toBeNull()
  })

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
    expect(receiptRows[1].disposition).toBe('created')
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
    // No receipt for this refused attempt.
    const receipt = await env.DB.prepare('SELECT 1 FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('hijack')
      .first()
    expect(receipt).toBeNull()
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

    const receipt = await env.DB.prepare(
      'SELECT disposition, actor_member_id, squad_id FROM team_bootstrap_receipts WHERE slug_base = ? AND squad_id = ?',
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
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-readonly', 'readonly-prj', 'Read Only', 'active');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-readonly', '${DEPT_ID}', 'readonly-sqd', 'Read Only Squad');
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
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-race', 'race-prj', 'Race', 'active');
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

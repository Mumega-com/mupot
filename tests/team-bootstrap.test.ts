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
    expect((result.squad as Record<string, unknown>).slug).toBe('psychonom-sqd')
    expect((result.squad as Record<string, unknown>).department_id).toBe(DEPT_ID)

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
    expect((secondResult.squad as Record<string, unknown>).id).toBe((firstResult.squad as Record<string, unknown>).id)

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

    // Receipt is the SAME row (UNIQUE(tenant, slug_base)), invited_count accumulated.
    const receiptCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('psychonom')
      .first<{ n: number }>()
    expect(receiptCount?.n).toBe(1)
    const receipt = await env.DB.prepare('SELECT invited_count FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('psychonom')
      .first<{ invited_count: number }>()
    expect(receipt?.invited_count).toBe(2)
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

    // No partial writes: the ceiling check runs AFTER project/squad resolution
    // (which DO commit independently — see the file header) but BEFORE the
    // batch, so no edge/invite/receipt exists for this attempt.
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

  it('batch failure leaves NO partial rows — edge, bot, invites, and receipt all roll back together', async () => {
    // Pre-seed an ARCHIVED project under the slug this call will resolve to.
    // findProjectBySlug adopts it as "existing" (no createProject call), but
    // the ADMIN-edge INSERT inside the one D1 batch then hits
    // validate_project_squad_access_insert (migration 0055) and the whole
    // transaction — edge, bot statements, invite inserts, and the receipt —
    // rolls back together (tests/helpers/sqlite-d1.ts wraps every batch in
    // BEGIN IMMEDIATE/COMMIT/ROLLBACK).
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-archived', 'batchfail-prj', 'Batch Fail', 'archived');
    `)

    const outcome = await invokeTool(
      orgAdminAuth(),
      env,
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

    // The squad WAS created before the batch (its own independent commit —
    // see the file header on why project/squad resolution is not IN the
    // batch) — but nothing from the batch itself landed.
    const squad = await env.DB.prepare('SELECT id FROM squads WHERE slug = ?').bind('batchfail-sqd').first<{ id: string }>()
    expect(squad).toBeTruthy()

    const edge = await env.DB.prepare('SELECT 1 FROM project_squad_access WHERE project_id = ?')
      .bind('proj-archived')
      .first()
    expect(edge).toBeNull()
    const bot = await env.DB.prepare('SELECT 1 FROM agents WHERE slug = ?').bind('batchfail-bot').first()
    expect(bot).toBeNull()
    const invite = await env.DB.prepare('SELECT 1 FROM invites WHERE email = ?').bind('victim@example.com').first()
    expect(invite).toBeNull()
    const receipt = await env.DB.prepare('SELECT 1 FROM team_bootstrap_receipts WHERE slug_base = ?')
      .bind('batchfail')
      .first()
    expect(receipt).toBeNull()
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
})

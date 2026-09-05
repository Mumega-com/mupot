// mupot#1324 adversarial follow-up (BLOCK-2) — the headline defence-in-depth
// control had ZERO test coverage: deleting both `bound_agent_id` rejections in
// src/dashboard/enroll.ts (resolveEnrollMemberId + authorizeEnrollMint) left
// 23/23 tests green, and deleting the route-level 403 in
// src/dashboard/index.ts's POST /enroll/mint handler left 23/23 green too.
//
// The reviewer's own finding explains why: loadAuthFromCookie (src/auth/index.ts)
// NEVER sets AuthContext.boundAgentId — it is only ever populated from
// member_tokens.bound_agent_id on an MCP/bearer session, and /enroll exists on
// exactly one cookie-auth mount. So a real HTTP request through dashboardApp can
// never legitimately reach this route WITH boundAgentId set. That makes the
// guard inert defence-in-depth today, not dead weight to delete — the day
// /enroll gains a second (bearer-reachable) mount, this is the line that stops
// an agent-bound session from minting itself a fresh operator-grade key.
//
// Two of the three surviving mutants (enroll.ts:56 resolveEnrollMemberId,
// enroll.ts:~168 authorizeEnrollMint) are pure functions — killed directly,
// no HTTP or mock needed. The third (index.ts's route-level `if
// (auth.boundAgentId)`) can only be reached by forcing what loadAuthFromCookie
// itself never produces, so this file mocks `requireAuth` for this test file
// only (vitest isolates mocks per file — every other test still exercises the
// REAL cookie-only requireAuth) to inject a boundAgentId session and prove the
// route-level check still fires independently of the enroll.ts helpers.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env, AuthContext } from '../src/types'
import { resolveEnrollMemberId, authorizeEnrollMint } from '../src/dashboard/enroll'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const SQUAD_A = 'squad-a'
const AGENT_A = 'agent-river'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_A}', 'dept-a', 'squad-a', 'River Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_A}', '${SQUAD_A}', 'cursor-river', 'Cursor River', 'lead', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-admin', 'admin@pot.test', 'Squad Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-admin-a', 'member-admin', 'squad', '${SQUAD_A}', 'admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) },
    BUS: { send: async () => {} },
    BLOBS: {},
    AI: {},
    AGENT: {},
    SQUAD: {},
  } as unknown as Env
}

// ── direct unit coverage: enroll.ts's own two guards ─────────────────────────

describe('resolveEnrollMemberId — bound-agent guard (enroll.ts:56)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('returns null for a bound-agent session even though role/email would otherwise resolve a member', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const boundAuth: AuthContext = {
      userId: 'u-agent',
      email: 'admin@pot.test', // would resolve member-admin if this guard did not fire first
      role: 'member',
      tenant: TENANT,
      boundAgentId: AGENT_A,
    }
    const memberId = await resolveEnrollMemberId(env, boundAuth)
    expect(memberId).toBeNull()
  })

  it('control: the SAME auth without boundAgentId DOES resolve the member', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const humanAuth: AuthContext = {
      userId: 'u-admin',
      email: 'admin@pot.test',
      role: 'member',
      tenant: TENANT,
    }
    const memberId = await resolveEnrollMemberId(env, humanAuth)
    expect(memberId).toBe('member-admin')
  })
})

describe('authorizeEnrollMint — bound-agent guard (enroll.ts authorizeEnrollMint)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('refuses operator_principal_required for a bound-agent session even though it would otherwise hold squad-admin', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const boundAuth: AuthContext = {
      userId: 'u-agent',
      email: 'admin@pot.test',
      role: 'member',
      tenant: TENANT,
      boundAgentId: AGENT_A,
      // If the boundAgentId check did not short-circuit first, this capability
      // set would satisfy canOnSquad(..., 'admin') and the mint would proceed.
      capabilities: [{ member_id: 'member-admin', scope_type: 'squad', scope_id: SQUAD_A, capability: 'admin' }],
    }
    const result = await authorizeEnrollMint(env, boundAuth, SQUAD_A)
    expect(result).toEqual({ ok: false, reason: 'operator_principal_required' })
  })

  it('control: the SAME grants without boundAgentId are admitted', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const humanAuth: AuthContext = {
      userId: 'u-admin',
      email: 'admin@pot.test',
      role: 'member',
      tenant: TENANT,
      capabilities: [{ member_id: 'member-admin', scope_type: 'squad', scope_id: SQUAD_A, capability: 'admin' }],
    }
    const result = await authorizeEnrollMint(env, humanAuth, SQUAD_A)
    expect(result).toEqual({ ok: true })
  })
})

// ── route-level coverage: index.ts's independent `if (auth.boundAgentId)` ───
//
// requireAuth is mocked for THIS FILE ONLY (vitest isolates mocks per test
// file — tests/enroll-seat-key.test.ts and every other suite still exercise
// the real cookie-only requireAuth). The mock injects a boundAgentId session
// when the test sends `x-test-bound-agent-id`, and falls through to the real
// implementation for every other request — so this does not silently make
// every OTHER dashboard test pass through a fake auth layer.
vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>()
  return {
    ...actual,
    requireAuth: async (c: { req: { header: (k: string) => string | undefined }; set: (k: string, v: unknown) => void; env: Env }, next: () => Promise<void>) => {
      const forcedAgentId = c.req.header('x-test-bound-agent-id')
      if (forcedAgentId) {
        c.set('auth', {
          userId: 'u-test-bound',
          email: null,
          role: 'member',
          tenant: c.env.TENANT_SLUG,
          boundAgentId: forcedAgentId,
        } satisfies AuthContext)
        await next()
        return
      }
      await actual.requireAuth(c, next)
    },
  }
})

describe('POST /enroll/mint — route-level bound-agent 403 (index.ts, independent of enroll.ts helpers)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('refuses 403 operator_principal_required and mints nothing when the SESSION ITSELF is agent-bound', async () => {
    harness = makeHarness()
    const { dashboardApp } = await import('../src/dashboard/index')
    const env = envFor(harness)
    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }

    const res = await dashboardApp.fetch(
      new Request(`${ORIGIN}/enroll/mint`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          Origin: ORIGIN,
          'x-test-bound-agent-id': AGENT_A,
        },
        body: new URLSearchParams({ agent_id: AGENT_A, seat: 'agent-self-mint' }),
      }),
      env,
    )

    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toContain('An operator principal is required.')
    expect(body).not.toMatch(/mupot_[0-9a-f]{64}/)

    const after = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})

// ── the re-gate's two findings ───────────────────────────────────────────────
//
// BLOCK-A. The first pass at the bootstrap-owner fix put `isOrgAdmin(auth)` AHEAD of the
// status-gated grant resolution, and isOrgAdmin reads auth.capabilities, which is filled by
// resolveCapabilities — no members.status filter (#1335). So it closed the suspended
// SQUAD-admin class and opened the suspended ORG-admin one, which is strictly worse.
//
// BLOCK-B. The null-memberId branch added to the GET picker had no test at all. Weakening it
// to `!memberId` left every suite green while leaking the whole active roster to a principal
// with zero grants. The fixture MUST carry an agent_member_bindings row: listConsentableAgents
// inner-joins it, so without one the listing is empty under both the fix and the mutant and
// the test proves nothing.
describe('enroll admission: revoked standing and the null-member listing guard', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness?.close())

  function seedOrgAdmin(status: 'active' | 'suspended'): Env {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES
        ('member-org', 'org@pot.test', 'Org Admin', '${status}', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-org', 'member-org', 'org', NULL, 'admin');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${TENANT}', '${AGENT_A}', 'member-org', '2026-09-05T00:00:00.000Z');
    `)
    return envFor(harness)
  }

  const orgAuth = (): AuthContext => ({
    userId: 'user-org',
    email: 'org@pot.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'member-org',
    capabilities: [{ scope_type: 'org', scope_id: null, capability: 'admin' }],
  } as unknown as AuthContext)

  it('an ACTIVE org admin is admitted', async () => {
    const env = seedOrgAdmin('active')
    await expect(authorizeEnrollMint(env, orgAuth(), SQUAD_A)).resolves.toEqual({ ok: true })
  })

  it('a SUSPENDED org admin is refused — the org grant does not outrank revoked standing', async () => {
    const env = seedOrgAdmin('suspended')
    const res = await authorizeEnrollMint(env, orgAuth(), SQUAD_A)
    expect(res).toEqual({ ok: false, reason: 'squad_admin_required' })
  })

  it('an ACTIVE org admin holding NO capability rows is still admitted (legacy owner role)', async () => {
    // Guards the fix against being written as "grants.length > 0", which would refuse the
    // very principal isOrgAdmin exists to protect. Absence of grants is not revocation.
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES
        ('member-owner', 'owner@pot.test', 'Legacy Owner', 'active', '${TENANT}');
    `)
    const env = envFor(harness)
    const auth = {
      userId: 'user-owner',
      email: 'owner@pot.test',
      role: 'owner',
      tenant: TENANT,
      memberId: 'member-owner',
      capabilities: [],
    } as unknown as AuthContext
    await expect(authorizeEnrollMint(env, auth, SQUAD_A)).resolves.toEqual({ ok: true })
  })

  it('the bootstrap owner, with NO members row at all, is still admitted', async () => {
    // A missing row is not a revoked one. This is the whole point of the fix.
    harness = makeHarness()
    const env = envFor(harness)
    const auth = {
      userId: 'user-boot',
      email: 'boot@pot.test',
      role: 'owner',
      tenant: TENANT,
      memberId: null,
      capabilities: [],
    } as unknown as AuthContext
    await expect(authorizeEnrollMint(env, auth, SQUAD_A)).resolves.toEqual({ ok: true })
  })
})

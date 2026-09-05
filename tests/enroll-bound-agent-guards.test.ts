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

// mupot#1454 round 2, F1 (same class as #1453) — dashboardApp's
// `POST /members/:id/tokens` (src/dashboard/index.ts) mints via
// mintMemberToken for an ARBITRARY member id. Before this fix it had:
//   - NO target-rank ceiling (unlike its twin, mintScopedKey in ./keys.ts,
//     mupot#1453) — a member whose real standing already outranks the
//     minter could still receive a fresh credential authenticating AS them.
//   - NO status filter on the member lookup — a SUSPENDED member could
//     still be minted a live token.
//   - NO tenant filter — a cross-tenant member row could be minted against.
// This route is rendered as a form on every row of /members (membersPageBody),
// so it is reachable by any org admin, not a hidden/internal-only surface.
//
// Fix mirrors keys.ts's mintScopedKey exactly: the member lookup gains
// `status = 'active' AND (tenant = ?2 OR tenant IS NULL)`, and the mint is
// gated on `exceedsTargetRankCeiling` (src/auth/capability.ts) — the SAME
// predicate mintScopedKey's DB-free `exceedsTargetRankCeilingGivenRanks`
// variant wraps, so the two routes cannot drift from each other again.
//
// Full committed migration chain (tests/helpers/migrations.ts) — no
// hand-built schema.
import { afterEach, describe, expect, it } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'f1-ceiling-tenant'
const ORIGIN = 'https://pot.test'

function envFor(harness: SqliteD1Harness, sessions: Record<string, string>): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: (() => {
      const store = new Map<string, string>(Object.entries(sessions))
      return {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value) },
        delete: async (key: string) => { store.delete(key) },
      }
    })(),
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) },
    BUS: { send: async () => {} },
    BLOBS: {},
    AI: {},
    AGENT: {},
    SQUAD: {},
  } as unknown as Env
}

function adminSession(email: string): string {
  // Legacy-role plane admin — canOnOrg admits on role alone, keeping the
  // fixture focused on the TARGET's standing rather than the actor's.
  return JSON.stringify({ userId: `u-${email}`, email, role: 'admin', createdAt: '2026-01-01T00:00:00Z' })
}

function mintPost(sessionId: string, memberId: string, values: Record<string, string> = {}): Request {
  const hdrs = new Headers({ Origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' })
  hdrs.set('Cookie', `mupot_session=${sessionId}`)
  return new Request(`${ORIGIN}/members/${memberId}/tokens`, {
    method: 'POST',
    headers: hdrs,
    body: new URLSearchParams({ label: 'test-key', channel: 'workspace', ...values }),
  })
}

function tokenCountFor(harness: SqliteD1Harness, memberId: string): number {
  return (
    harness.sqlite.prepare(`SELECT count(*) AS n FROM member_tokens WHERE member_id = ?`).get(memberId) as {
      n: number
    }
  ).n
}

describe('POST /members/:id/tokens — target-rank ceiling + tenant/status filter (mupot#1454 F1)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('admin refused minting for a member who globally holds org->owner — zero token rows', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
        ('admin-1', '${TENANT}', 'admin@f1.test', 'Admin', 'active', datetime('now')),
        ('target-owner', '${TENANT}', 'owner@f1.test', 'Target Owner', 'active', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner', 'target-owner', 'org', NULL, 'owner');
    `)
    const env = envFor(harness, { 'sess:s-admin': adminSession('admin@f1.test') })

    const res = await dashboardApp.fetch(mintPost('s-admin', 'target-owner'), env)

    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toMatch(/outrank/i)
    expect(tokenCountFor(harness, 'target-owner')).toBe(0)
  })

  it('refuses minting for a SUSPENDED member', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
        ('admin-2', '${TENANT}', 'admin2@f1.test', 'Admin', 'active', datetime('now')),
        ('target-suspended', '${TENANT}', 'suspended@f1.test', 'Suspended', 'suspended', datetime('now'));
    `)
    const env = envFor(harness, { 'sess:s-admin': adminSession('admin2@f1.test') })

    const res = await dashboardApp.fetch(mintPost('s-admin', 'target-suspended'), env)

    expect(res.status).toBe(404) // "Person not found" — same clean error keys.ts uses
    expect(tokenCountFor(harness, 'target-suspended')).toBe(0)
  })

  it('refuses minting for a CROSS-TENANT member', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
        ('admin-3', '${TENANT}', 'admin3@f1.test', 'Admin', 'active', datetime('now')),
        ('target-other-tenant', 'other-tenant', 'other@f1.test', 'Other Tenant Member', 'active', datetime('now'));
    `)
    const env = envFor(harness, { 'sess:s-admin': adminSession('admin3@f1.test') })

    const res = await dashboardApp.fetch(mintPost('s-admin', 'target-other-tenant'), env)

    expect(res.status).toBe(404)
    expect(tokenCountFor(harness, 'target-other-tenant')).toBe(0)
  })

  it('admin mints for a member at member rank — allowed', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-f1', 'dept-f1', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-f1', 'dept-f1', 'squad-f1', 'Squad');
      INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
        ('admin-4', '${TENANT}', 'admin4@f1.test', 'Admin', 'active', datetime('now')),
        ('target-member', '${TENANT}', 'member@f1.test', 'Target Member', 'active', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-member', 'target-member', 'squad', 'squad-f1', 'member');
    `)
    const env = envFor(harness, { 'sess:s-admin': adminSession('admin4@f1.test') })

    const res = await dashboardApp.fetch(mintPost('s-admin', 'target-member'), env)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/mupot_[0-9a-f]{64}/)
    expect(tokenCountFor(harness, 'target-member')).toBe(1)
  })

  // mupot#1454 F2/P2 companion: this route now shares the SAME predicate as
  // mintScopedKey, including the self-exemption — an admin whose GLOBAL rank
  // (via an unrelated squad grant) exceeds their org-scope-local standing
  // must still be able to mint a token for THEMSELVES.
  it('admin mints for THEMSELVES — allowed even when their global rank (via an unrelated squad grant) exceeds their org-scope rank', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-self', 'dept-self', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-self', 'dept-self', 'squad-self', 'Squad');
      INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
        ('self-admin', '${TENANT}', 'self@f1.test', 'Self Admin', 'active', datetime('now'));
      -- Unrelated squad-scope OWNER grant (rank 5) — globally outranks the
      -- org-scope-local admin standing (rank 4) this session authenticates at.
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-self-owner', 'self-admin', 'squad', 'squad-self', 'owner');
    `)
    const env = envFor(harness, { 'sess:s-self': adminSession('self@f1.test') })

    const res = await dashboardApp.fetch(mintPost('s-self', 'self-admin'), env)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/mupot_[0-9a-f]{64}/)
    expect(tokenCountFor(harness, 'self-admin')).toBe(1)
  })
})

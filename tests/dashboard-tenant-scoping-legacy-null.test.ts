// #1330 gate-followup (kasra-code, 2026-09-05) — three unscoped/unguarded
// sites in the same "F-B" tenant-scoping family as the pinned GET /members
// had ZERO test coverage: unscoping any one of them individually survives
// the entire suite. This file pins each with a real-DB (sqlite-d1) fixture
// mixing a same-tenant row, a cross-tenant row, and a legacy tenant-IS-NULL
// row, so each test both proves cross-tenant exclusion AND legacy-row
// inclusion in one pass.
//
//   - src/dashboard/keys.ts:76   loadKeysView() members query
//   - src/dashboard/keys.ts:173  mintScopedKey() member-existence check
//   - src/dashboard/index.ts:2994 loadMembers() (used by GET /admin/members)

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { loadKeysView, mintScopedKey } from '../src/dashboard/keys'
import type { AuthContext, Env } from '../src/types'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function insertMixedTenantMembers(harness: SqliteD1Harness): void {
  const now = '2026-09-05T00:00:00.000Z'
  harness.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
      ('member-home', 'tenant-a', 'home@example.test', 'Home Member', 'active', '${now}'),
      ('member-other-tenant', 'tenant-b', 'other@example.test', 'Other Tenant Member', 'active', '${now}'),
      ('member-legacy-null', NULL, 'legacy@example.test', 'Legacy Member', 'active', '${now}');
  `)
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
}

describe('loadKeysView tenant scoping (#1330 F-B, keys.ts:76)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('lists the home-tenant member and the legacy NULL-tenant member, excludes the other tenant', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    insertMixedTenantMembers(harness)

    const view = await loadKeysView(envFor(harness))
    const ids = view.members.map((m) => m.id).sort()

    expect(ids).toContain('member-home')
    expect(ids).toContain('member-legacy-null')
    expect(ids).not.toContain('member-other-tenant')
  })
})

describe('mintScopedKey member-existence tenant scoping (#1330 F-B, keys.ts:173)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('rejects minting for a cross-tenant member as member_not_found', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    insertMixedTenantMembers(harness)

    const result = await mintScopedKey(envFor(harness), {
      memberId: 'member-other-tenant',
      presetId: 'observer',
      minterRank: 5,
    })

    expect(result).toEqual({ ok: false, error: 'member_not_found' })
  })

  it('allows minting for a legacy tenant-IS-NULL member (matched, not rejected)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    insertMixedTenantMembers(harness)
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-legacy-admin', 'member-legacy-null', 'org', NULL, 'admin');
    `)

    const result = await mintScopedKey(envFor(harness), {
      memberId: 'member-legacy-null',
      presetId: 'admin',
      minterRank: 5,
    })

    expect(result.ok).toBe(true)
  })
})

// ── GET /admin/members (loadMembers, dashboard/index.ts:2994) ─────────────────

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>()
  return {
    ...actual,
    requireAuth: async (
      c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
      next: () => Promise<void>,
    ) => {
      if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
      c.set('auth', authState.current)
      await next()
    },
  }
})

const { dashboardApp } = await import('../src/dashboard/index')

function ownerAuth(): AuthContext {
  return {
    userId: 'owner-user', memberId: 'owner-member', email: 'owner@example.test',
    role: 'owner', tenant: 'tenant-a', capabilities: [],
  } as unknown as AuthContext
}

function makeDashboardHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  insertMixedTenantMembers(harness)
  return harness
}

function dashboardEnvFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

describe('GET /admin/members tenant scoping (#1330 F-B, dashboard/index.ts:2994 loadMembers)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders the home-tenant + legacy-NULL members, never the other tenant', async () => {
    harness = makeDashboardHarness()
    authState.current = ownerAuth()
    const response = await dashboardApp.fetch(
      new Request('https://pot.test/admin/members'),
      dashboardEnvFor(harness),
    )
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Home Member')
    expect(body).toContain('Legacy Member')
    expect(body).not.toContain('Other Tenant Member')
  })
})

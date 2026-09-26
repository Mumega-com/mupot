// Topbar "Invite member" — mupot#1444.
//
// Was a <button> with no handler at all — a dead control that did nothing on
// click. Fixed to a real link to the actual producer, /admin/members's own
// #invite-form (there is exactly ONE invite form; this never adds a second).
// It must also only ever be shown to a viewer who can actually reach that
// form — the SAME isOrgAdmin() threshold /admin/members' own GET handler
// requires (src/dashboard/index.ts) — so a viewer who cannot invite never
// sees a control that would just 403. The template renders it hidden by
// default (role-agnostic shell, same precedent as the pre-existing
// nav-addons reveal) and a post-render middleware strips the `hidden`
// attribute only for an org admin.
//
// requireAuth is mocked (same technique as tests/admin-members-invite-link.
// test.ts) so this test drives the AuthContext directly instead of
// reconstructing real session cookies — the auth GATE itself is covered by
// tests/dashboard-signed-out-landing.test.ts and the pre-existing capability-
// floor tests; this file is about what the SHELL renders once past it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { AuthContext, Env } from '../src/types'

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

const TENANT = 'tenant-a'

function adminAuth(): AuthContext {
  // Legacy-plane org admin — the SAME plane isOrgAdmin's `auth.role ===
  // 'admin'` branch honors, and 'admin' (not 'owner') so the first-run
  // onboarding redirect (GET / → /setup for an un-onboarded owner) never
  // fires and this hits the real observatory route.
  return {
    userId: 'admin-user', memberId: 'admin-member', email: 'admin@example.test',
    role: 'admin', tenant: TENANT, capabilities: [],
  } as unknown as AuthContext
}

function memberAuth(): AuthContext {
  // A real signed-in member who passes the capability floor (a squad-scope
  // grant — holdsCapabilityFloor('observer') is satisfied by ANY grant at
  // ANY rank/scope) but holds NO org-scope admin/owner grant, so isOrgAdmin
  // is false — exactly "signed in, but without invite authority."
  return {
    userId: 'member-user', memberId: 'member-member', email: 'member@example.test',
    role: 'member', tenant: TENANT,
    capabilities: [{ member_id: 'member-member', scope_type: 'squad', scope_id: 'squad-x', capability: 'member' }],
  } as unknown as AuthContext
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  const store = new Map<string, string>()
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
    },
  } as unknown as Env
}

/** Pull the exact <a id="topbar-invite" ...> tag out of the rendered shell. */
function topbarInviteTag(body: string): string | undefined {
  return body.match(/<a[^>]*\bid="topbar-invite"[^>]*>/)?.[0]
}

describe('topbar "Invite member" (mupot#1444)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('org admin: topbar-invite is a real, VISIBLE link to /admin/members#invite-form', async () => {
    harness = makeHarness()
    authState.current = adminAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/'), envFor(harness))
    expect(res.status).toBe(200)
    const body = await res.text()

    const tag = topbarInviteTag(body)
    expect(tag).toBeDefined()
    expect(tag).toContain('href="/admin/members#invite-form"')
    // Revealed — not left `hidden` for the viewer who is allowed to invite.
    expect(tag).not.toContain('hidden')
  })

  it('signed-in member without invite authority: topbar-invite stays hidden (not a usable control)', async () => {
    harness = makeHarness()
    authState.current = memberAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/'), envFor(harness))
    expect(res.status).toBe(200)
    const body = await res.text()

    const tag = topbarInviteTag(body)
    // Either omitted entirely or present-but-hidden — either way, unusable.
    if (tag) {
      expect(tag).toContain('hidden')
    } else {
      expect(tag).toBeUndefined()
    }
  })
})

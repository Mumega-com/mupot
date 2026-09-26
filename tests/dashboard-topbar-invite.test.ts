// Topbar "Invite member" — mupot#1444, plus round-2 adversarial-gate fixes.
//
// Round 1: was a <button> with no handler at all — a dead control that did
// nothing on click. Fixed to a real link to the actual producer,
// /admin/members's own #invite-form (there is exactly ONE invite form; this
// never adds a second). Shown only to a viewer who can actually reach that
// form — the SAME isOrgAdmin() threshold /admin/members' own GET handler
// requires.
//
// Round 1's MECHANISM was itself defective (adversarial gate P1): the
// template rendered `<a class="topbar-invite" ... hidden>` and a post-render
// middleware stripped the `hidden` attribute for an admin. But the `hidden`
// attribute's UA default is a plain `display: none`, and this PR's OWN
// `.topbar-invite { display: inline-flex }` rule — an author rule — outranks
// that UA default regardless of specificity. A non-admin's browser rendered
// a live, clickable, 403-leading link the whole time; `hidden` was present
// and completely inert.
//
// Round 2 fix, two parts:
//   1. (P1) The template no longer emits the CTA's class/id/href for anyone —
//      it emits an inert HTML-comment placeholder that shares no selector
//      with `.topbar-invite`. The reveal middleware resolves that placeholder
//      into the real anchor (admin) or removes it entirely (everyone else).
//      There is no `hidden` attribute anywhere in this flow for CSS to
//      defeat — a non-admin's response contains ZERO occurrences of
//      "topbar-invite" at all, not a hidden one.
//   2. (P2.1) A global `[hidden] { display: none !important }` rule was added
//      to shell()'s CSS, closing the identical exposure that nav-addons
//      still has via `.nav-link { display: flex }` (nav-addons itself keeps
//      the hidden-attribute-toggle mechanism; this global rule is what now
//      makes that safe).
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

describe('topbar "Invite member" (mupot#1444)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('org admin: topbar-invite is present as a real link to /admin/members#invite-form, no hidden attribute', async () => {
    harness = makeHarness()
    authState.current = adminAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/'), envFor(harness))
    expect(res.status).toBe(200)
    const body = await res.text()

    const tag = body.match(/<a[^>]*\bid="topbar-invite"[^>]*>/)?.[0]
    expect(tag).toBeDefined()
    expect(tag).toContain('class="topbar-invite"')
    expect(tag).toContain('href="/admin/members#invite-form"')
    expect(tag).not.toContain('hidden')
    // The placeholder must never survive into a real response either way.
    expect(body).not.toContain('<!--mupot-invite-cta-->')
  })

  it('signed-in member without invite authority: NO trace of topbar-invite anywhere in the response — not present, not hidden', async () => {
    harness = makeHarness()
    authState.current = memberAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/'), envFor(harness))
    expect(res.status).toBe(200)
    const body = await res.text()

    // The exact defect class round 2 closes: the ELEMENT must be a true
    // absence, not a `hidden`-flagged presence a stylesheet could un-hide.
    // (The static `.topbar-invite { ... }` CSS RULE is fine to keep in the
    // stylesheet for every viewer — it styles the element IF it's ever
    // inserted; it is not itself the defect, so this checks for the actual
    // <a ...> tag, not a blind substring match that would also catch the CSS.)
    expect(body).not.toMatch(/<a[^>]*\bclass="topbar-invite"/)
    expect(body).not.toMatch(/<a[^>]*\bid="topbar-invite"/)
    expect(body).not.toContain('<!--mupot-invite-cta-->')
  })

  it('shell CSS carries the global [hidden] { display: none !important } rule (P2.1)', async () => {
    harness = makeHarness()
    authState.current = adminAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/'), envFor(harness))
    const body = await res.text()
    expect(body).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })
})

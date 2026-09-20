// GET /admin/members — mupot#1436 A5: after a successful invite create, the
// page must render the copyable absolute link `${origin}/invite/${id}`.
//
// The link is built client-side (location.origin + '/invite/' + id) after the
// POST /api/members/invites JSON response, so this test pins the SERVER-
// RENDERED markup + wiring the browser script depends on: the hidden
// invite-link-wrap/invite-link elements exist, and the invite-form submit
// handler both reveals them and writes `location.origin + '/invite/' + id`
// into invite-link.value on a successful create.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { AuthContext, Env } from '../src/types'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

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

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

describe('GET /admin/members invite-link UI (mupot#1436 A5)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders the hidden copyable invite-link input beside the invite form', async () => {
    harness = makeHarness()
    authState.current = ownerAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/admin/members'), envFor(harness))
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('id="invite-link-wrap"')
    expect(body).toContain('id="invite-link"')
    // Hidden until a successful create — no invite id known yet.
    const wrapMatch = body.match(/<div id="invite-link-wrap"[^>]*>/)
    expect(wrapMatch?.[0]).toContain('hidden')
  })

  it('the invite-form submit handler builds the link from the created invite id and reveals it', async () => {
    harness = makeHarness()
    authState.current = ownerAuth()

    const res = await dashboardApp.fetch(new Request('https://pot.test/admin/members'), envFor(harness))
    const body = await res.text()

    expect(body).toContain("location.origin + '/invite/' + encodeURIComponent(inviteId)")
    expect(body).toContain('inviteLinkWrap.removeAttribute(\'hidden\')')
  })
})

// tests/home-provisioning-call-site-safety.test.ts — mupot#1504, adversarial
// round 1, P2-a.
//
// provisionHomeForMember (src/members/service.ts) already wraps its own body
// (including the dynamic `import('../org/service')`) so it cannot reject —
// see its doc comment. This file tests something DIFFERENT and narrower: that
// each of the THREE call sites (src/dashboard/invite.ts, src/members/index.ts,
// src/im/index.ts) survives a rejection from `provisionHomeForMember` on its
// OWN terms, via its own `.catch(...)`, independent of whether the function's
// internal guarantee holds. Mocking `provisionHomeForMember` itself (rather
// than something deeper) is deliberate: it isolates "does the CALL SITE
// survive a rejection" from "can the FUNCTION reject in practice", which
// tests/home-provisioning-web-accept.test.ts already covers with the real
// implementation.
//
// The dashboard case is the one the coordinator's brief named explicitly:
// the provisioning call is positioned AFTER the pending-invite KV marker +
// cookie (moved there in this same round — see src/dashboard/invite.ts's own
// comment) specifically so that even an UNCAUGHT rejection could only ever
// cost the member their home, never their one path back to linking Google.
// This file proves the `.catch` closes that gap entirely: the marker/cookie
// are set and the response is a 302 even when provisioning rejects.
//
// vi.mock is file-scoped in Vitest (each test file gets its own module
// registry), so this mock does not leak into
// tests/home-provisioning-web-accept.test.ts, which exercises the REAL
// provisionHomeForMember.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/members/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/members/service')>()
  return {
    ...actual,
    provisionHomeForMember: vi.fn().mockRejectedValue(new Error('simulated provisionHomeForMember rejection (P2-a)')),
  }
})

import { inviteApp, PENDING_INVITE_COOKIE, PENDING_INVITE_KV_PREFIX } from '../src/dashboard/invite'
import { membersApp } from '../src/members'
import { imApp } from '../src/im'
import { createProjectInvite } from '../src/members/project-invites'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const IM_SECRET = 'test-im-secret'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'proj-a', 'Project Atlas', 'active');
    INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-a', 'squad-web');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-squad', 'member-admin', 'squad', 'squad-web', 'admin');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-web', 'squaduser@example.com', 'squad-web', 'member', 'member-admin');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-api', 'apiuser@example.com', 'squad-web', 'member', 'member-admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): { env: Env; kv: { store: Map<string, string> } } {
  const store = new Map<string, string>()
  const env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    IM_WEBHOOK_SECRET: IM_SECRET,
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
    },
  } as unknown as Env
  return { env, kv: { store } }
}

function postForm(path: string, values: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

function inviterAuth(): AuthContext {
  return {
    userId: 'member-admin', email: 'admin@pot.test', role: 'member', tenant: TENANT,
    memberId: 'member-admin',
    capabilities: [{ member_id: 'member-admin', scope_type: 'squad', scope_id: 'squad-web', capability: 'admin' }],
  }
}

describe('mupot#1504 adversarial round 1, P2-a — call sites survive a provisionHomeForMember rejection', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.clearAllMocks()
  })

  it('web accept (dashboard/invite.ts): still 302s to /auth/login with the KV marker + cookie set', async () => {
    harness = makeHarness()
    const { env, kv } = envFor(harness)

    const response = await inviteApp.fetch(postForm('/inv-web', { display_name: 'Squad User' }), env)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/login')

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${PENDING_INVITE_COOKIE}=`)
    const cookieMatch = setCookie.match(new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`))
    expect(cookieMatch).not.toBeNull()
    const pendingId = cookieMatch![1]
    expect(kv.store.has(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)).toBe(true)

    // The member itself was still minted — acceptInvite's own commit is
    // unaffected by a downstream provisioning rejection.
    const member = harness.sqlite.prepare(
      `SELECT id FROM members WHERE id != 'member-admin' LIMIT 1`,
    ).get() as { id: string } | undefined
    expect(member).toBeDefined()
  })

  it('JSON API accept (members/index.ts POST /invites/:id/accept): still 201s with the raw token', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)

    const response = await membersApp.fetch(new Request(`${ORIGIN}/invites/inv-api/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'API User' }),
    }), env)

    expect(response.status).toBe(201)
    const body = await response.json() as { member_id: string; token: { raw: string } | null }
    expect(typeof body.member_id).toBe('string')
    expect(typeof body.token?.raw).toBe('string')
  })

  it("IM join (im/index.ts handleImMessage 'join' case): still confirms the join", async () => {
    harness = makeHarness()
    const { env } = envFor(harness)

    const created = await createProjectInvite(env, inviterAuth(), {
      email: 'telegram-user@example.com',
      project_id: 'proj-a',
      squad_id: 'squad-web',
      capability: 'member',
      expires_in_seconds: 3600,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('setup: invite creation failed')

    const webhookBody = {
      update_id: 700,
      message: { chat: { id: 555111, type: 'private' }, from: { id: 555111 }, text: `/start ${created.value.pairing_code}` },
    }
    const response = await imApp.fetch(new Request(`${ORIGIN}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': IM_SECRET },
      body: JSON.stringify(webhookBody),
    }), env)

    expect(response.status).toBe(200)
    const body = await response.json() as { reply: string }
    expect(body.reply).toMatch(/joined project proj-a/i)
  })
})

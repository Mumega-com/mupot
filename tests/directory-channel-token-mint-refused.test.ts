// tests/directory-channel-token-mint-refused.test.ts — mupot#1551 round 3
// (P2, cheap closure): channel='directory' is reserved for
// mintDirectoryToken's own MCP OAuth connector mint
// (src/mcp/oauth-authorize.ts) — no legitimate caller of either ordinary
// token-mint surface (the JSON API POST /members/:id/tokens,
// src/members/index.ts; the dashboard's HTML-form twin,
// src/dashboard/index.ts) mints one. Refusing it here removes the spoof on
// decideIdentitylessAttach's directory-channel provisioning exemption
// (src/members/exclusive-control.ts): without this, an org admin could mint
// a caller-chosen channel='directory' token onto any member row they already
// control and have it silently read as containment-worthy "real OAuth
// connector session."
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import { dashboardApp } from '../src/dashboard'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'directory-refuse-tenant'
const ORIGIN = 'https://pot.test'

function adminSession(): string {
  return JSON.stringify({ userId: 'u-admin', email: 'admin@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })
}

function envFor(harness: SqliteD1Harness): Env {
  const sessions = new Map<string, string>([['sess:admin-sid', adminSession()]])
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

describe('channel=directory is refused at both token-mint surfaces', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-target', 'target@x.test', 'Target', 'active', '${TENANT}');
    `)
    env = envFor(harness)
  })

  afterEach(() => harness.close())

  it('JSON API POST /members/:id/tokens refuses channel=directory', async () => {
    const res = await membersApp.request(
      '/members/member-target/tokens',
      {
        method: 'POST',
        headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'spoof', channel: 'directory' }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_channel')
    const count = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'member-target' AND channel = 'directory'`)
      .get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('JSON API POST /members/:id/tokens still mints an ordinary workspace token (control case — the refusal is scoped to directory only)', async () => {
    const res = await membersApp.request(
      '/members/member-target/tokens',
      {
        method: 'POST',
        headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'ordinary', channel: 'workspace' }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('dashboard HTML POST /members/:id/tokens refuses channel=directory', async () => {
    const form = new URLSearchParams({ label: 'spoof', channel: 'directory' })
    const res = await dashboardApp.request(
      `${ORIGIN}/members/member-target/tokens`,
      {
        method: 'POST',
        headers: {
          cookie: 'mupot_session=admin-sid',
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        },
        body: form.toString(),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Invalid channel')
    const count = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'member-target' AND channel = 'directory'`)
      .get() as { n: number }
    expect(count.n).toBe(0)
  })
})

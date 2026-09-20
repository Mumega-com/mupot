// GET/POST /invite/:id — mupot#1436 A1: the public web invite-landing page.
//
// Covers: not-found, already-accepted (both methods), the Telegram/project
// invite refusal (pairing_hash set), and a full successful web accept — which
// must mint member + capability + workspace token (same as the JSON API),
// then set the pending-invite KV entry + HttpOnly cookie and redirect to
// /auth/login WITHOUT ever putting the raw token in the response body.
//
// Schema via createSqliteD1 + applyAllMigrations — no hand-written CREATE TABLE.

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  inviteApp,
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_KV_PREFIX,
} from '../src/dashboard/invite'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-legacy', 'newcomer@example.com', 'dept-a', 'member', 'member-admin');
    INSERT INTO invites (id, email, capability, invited_by, accepted_at)
      VALUES ('inv-used', 'used@example.com', 'member', 'member-admin', datetime('now'));
  `)
  // A Telegram/project invite — must go through the trigger's atomic column
  // group (0152), so insert every one of project_id/squad_id/pairing_hash/
  // pairing_expires_at together.
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Growth');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-b', 'squad-a', 'Growth Squad');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project Atlas');
    INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-a', 'squad-a');
    INSERT INTO invites (id, email, project_id, squad_id, pairing_hash, pairing_expires_at, capability, invited_by)
      VALUES ('inv-telegram', 'tguser@example.com', 'proj-a', 'squad-a',
        '${'a'.repeat(64)}', datetime('now', '+1 day'), 'member', 'member-admin');
  `)
  return harness
}

interface KvRecorder {
  store: Map<string, string>
  ttls: Map<string, number>
}

function envFor(harness: SqliteD1Harness): { env: Env; kv: KvRecorder } {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  const kv: KvRecorder = { store, ttls }
  const env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, value)
        if (opts?.expirationTtl) ttls.set(key, opts.expirationTtl)
      },
      delete: async (key: string) => { store.delete(key) },
    },
  } as unknown as Env
  return { env, kv }
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { headers })
}

function postForm(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  const hdrs = new Headers(headers)
  hdrs.set('content-type', 'application/x-www-form-urlencoded')
  if (!hdrs.has('Origin')) hdrs.set('Origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: hdrs,
    body: new URLSearchParams(values),
  })
}

function memberCount(harness: SqliteD1Harness): number {
  return (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }).n
}

describe('GET /invite/:id', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('404s for an unknown invite id', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(get('/does-not-exist'), env)
    expect(res.status).toBe(404)
    expect(await res.text()).toMatch(/not found/i)
  })

  it('409s for an already-accepted invite, pointing at sign-in', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(get('/inv-used'), env)
    expect(res.status).toBe(409)
    const body = await res.text()
    expect(body).toMatch(/already been used/i)
    expect(body).toContain('/auth/login')
  })

  it('renders an informational page (no form) for a Telegram/project invite', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(get('/inv-telegram'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/redeemed in Telegram/i)
    expect(body).not.toContain('<form')
    expect(body).toContain('Project Atlas')
    expect(body).toContain('Growth Squad')
  })

  it('renders the accept form with org/department/capability/inviter for a legacy invite', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(get('/inv-legacy'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Test Pot')
    expect(body).toContain('Engineering')
    expect(body).toContain('member')
    expect(body).toContain('Ada Admin')
    expect(body).toContain('<form')
    expect(body).toContain('name="display_name"')
    expect(body).toContain(`action="/invite/inv-legacy"`)
  })
})

describe('POST /invite/:id', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('404s for an unknown invite id', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(postForm('/does-not-exist', { display_name: 'X' }), env)
    expect(res.status).toBe(404)
  })

  it('409s redeeming an already-accepted invite a second time', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const before = memberCount(harness)
    const res = await inviteApp.fetch(postForm('/inv-used', { display_name: 'Second Try' }), env)
    expect(res.status).toBe(409)
    expect(memberCount(harness)).toBe(before)
  })

  it('refuses to accept a Telegram/project invite from the web form', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const before = memberCount(harness)
    const res = await inviteApp.fetch(postForm('/inv-telegram', { display_name: 'TG User' }), env)
    expect(res.status).toBe(409)
    expect(await res.text()).toMatch(/redeemed in Telegram/i)
    expect(memberCount(harness)).toBe(before)
  })

  it('requires a non-blank display name', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const res = await inviteApp.fetch(postForm('/inv-legacy', { display_name: '   ' }), env)
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/enter your name/i)
  })

  it('CSRF: rejects a cross-origin POST before minting anything', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    const before = memberCount(harness)
    const res = await inviteApp.fetch(
      postForm('/inv-legacy', { display_name: 'Evil' }, { Origin: 'https://evil.example' }),
      env,
    )
    expect(res.status).toBe(403)
    expect(memberCount(harness)).toBe(before)
  })

  it('on success: mints member+capability+token, sets pending-invite KV+cookie, redirects to /auth/login, never leaks the raw token', async () => {
    harness = makeHarness()
    const { env, kv } = envFor(harness)
    const before = memberCount(harness)

    const res = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)

    // Redirect, not a token-bearing JSON body.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
    const bodyText = await res.text()
    expect(bodyText).not.toMatch(/mupot_[0-9a-f]{64}/)

    // The member + capability + workspace token landed via the SAME write path
    // as the JSON API (acceptInvite).
    expect(memberCount(harness)).toBe(before + 1)
    const member = harness.sqlite
      .prepare(`SELECT id, email, display_name FROM members WHERE email = ?`)
      .get('newcomer@example.com') as { id: string; email: string; display_name: string } | undefined
    expect(member?.display_name).toBe('Newcomer Nancy')
    expect(member).toBeDefined()

    const cap = harness.sqlite
      .prepare(`SELECT capability, scope_type, scope_id FROM capabilities WHERE member_id = ?`)
      .get(member!.id) as { capability: string; scope_type: string; scope_id: string } | undefined
    expect(cap).toEqual({ capability: 'member', scope_type: 'department', scope_id: 'dept-a' })

    const tokenRow = harness.sqlite
      .prepare(`SELECT id FROM member_tokens WHERE member_id = ?`)
      .get(member!.id)
    expect(tokenRow).toBeDefined()

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at FROM invites WHERE id = 'inv-legacy'`)
      .get() as { accepted_at: string | null }
    expect(invite.accepted_at).not.toBeNull()

    // Cookie: HttpOnly + Secure + the pending marker.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${PENDING_INVITE_COOKIE}=`)
    expect(setCookie.toLowerCase()).toContain('httponly')
    expect(setCookie.toLowerCase()).toContain('secure')
    const cookieMatch = setCookie.match(new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`))
    expect(cookieMatch).not.toBeNull()
    const pendingId = cookieMatch![1]

    // KV: the SAME id, carrying invite/member/email — never the raw token.
    const kvValue = kv.store.get(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)
    expect(kvValue).toBeDefined()
    const parsed = JSON.parse(kvValue!) as { invite_id: string; member_id: string; email: string }
    expect(parsed).toEqual({ invite_id: 'inv-legacy', member_id: member!.id, email: 'newcomer@example.com' })
    expect(kvValue).not.toMatch(/"raw"/)
  })
})

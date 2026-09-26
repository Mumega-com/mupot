// mupot#1457 (live shape of #1162) — invite accept must GRANT ONTO an
// existing verified member instead of dead-ending on member_already_exists.
//
// A person who signs in with Google BEFORE opening their invite already has
// a members row (findOrCreateHumanMember, src/members/human-identity.ts,
// email from the IdP). members.email is GLOBALLY UNIQUE (0002, not
// tenant-scoped) — the old acceptInvite() always attempted an INSERT and
// only discovered the collision via the UNIQUE-violation catch, returning
// member_already_exists (409) with no way forward. Order of operations must
// not matter: login-first and invite-first must both land the person in the
// invited squad.
//
// Schema via createSqliteD1 + applyAllMigrations — no hand-written CREATE TABLE.

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { assertNoRawToken } from './helpers/assert-no-raw-token'
import { acceptInvite, membersApp } from '../src/members'
import { inviteApp, PENDING_INVITE_COOKIE, PENDING_INVITE_KV_PREFIX } from '../src/dashboard/invite'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const OTHER_TENANT = 'pot-b'
const ORIGIN = 'https://pot.test'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
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
  return { env, kv: { store, ttls } }
}

function seedSquadInvite(harness: SqliteD1Harness, id: string, email: string): void {
  harness.sqlite
    .prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES (?, ?, 'squad-web', 'member', 'member-admin')`)
    .run(id, email)
}

function postForm(path: string, values: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

function postJson(path: string, body: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('acceptInvite — grants onto an existing member (#1457)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('login-first (JSON): 200, capability on the EXISTING member, invites.member_id stamped, NO token row, linked_existing:true', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-loginfirst', 'loginfirst@example.com', 'Login First', 'active', '${TENANT}');
    `)
    seedSquadInvite(harness, 'inv-loginfirst', 'loginfirst@example.com')

    const res = await membersApp.fetch(postJson('/invites/inv-loginfirst/accept', { display_name: 'Ignored' }), env)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      member_id: string
      token: unknown
      linked_existing: boolean
      next: string
      capability: { scope_type: string; scope_id: string; capability: string }
    }
    expect(body.member_id).toBe('member-loginfirst')
    expect(body.token).toBeNull()
    expect(body.linked_existing).toBe(true)
    expect(body.next).toBe('sign_in')
    expect(body.capability).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'member' })

    // No second member row was minted for this email.
    const memberCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = 'loginfirst@example.com'`)
      .get() as { n: number }
    expect(memberCount.n).toBe(1)

    const cap = harness.sqlite
      .prepare(`SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = 'member-loginfirst'`)
      .get()
    expect(cap).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'member' })

    const invite = harness.sqlite
      .prepare(`SELECT member_id, accepted_at FROM invites WHERE id = 'inv-loginfirst'`)
      .get() as { member_id: string | null; accepted_at: string | null }
    expect(invite.member_id).toBe('member-loginfirst')
    expect(invite.accepted_at).not.toBeNull()

    // The one hard security invariant of this fix: NO member_tokens row, ever,
    // on this branch — regardless of the JSON route's default mintToken:true.
    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'member-loginfirst'`)
      .get() as { n: number }
    expect(tokenCount.n).toBe(0)
  })

  it('login-first (HTML /invite/:id POST): 200 "sign in" page, pending-invite cookie set, no token in HTML', async () => {
    harness = makeHarness()
    const { env, kv } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-html', 'htmlfirst@example.com', 'HTML First', 'active', '${TENANT}');
    `)
    seedSquadInvite(harness, 'inv-htmlfirst', 'htmlfirst@example.com')

    const res = await inviteApp.fetch(postForm('/inv-htmlfirst', { display_name: 'Whatever' }), env)
    expect(res.status).toBe(200)
    await assertNoRawToken(res, kv.store)
    const html = await res.text()
    expect(html).toMatch(/sign in/i)
    expect(html).toContain('/auth/login')

    // Pending-invite marker + cookie are still planted (same contract as the
    // fresh-member path) so /auth/callback can link the Google identity.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${PENDING_INVITE_COOKIE}=`)
    const cookieMatch = setCookie.match(new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`))
    expect(cookieMatch).not.toBeNull()
    const pendingId = cookieMatch![1]
    const kvValue = kv.store.get(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)
    expect(kvValue).toBeDefined()
    const parsed = JSON.parse(kvValue!) as { invite_id: string; member_id: string }
    expect(parsed.invite_id).toBe('inv-htmlfirst')
    expect(parsed.member_id).toBe('member-html')

    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'member-html'`)
      .get() as { n: number }
    expect(tokenCount.n).toBe(0)
  })

  it('fresh email (regression): unchanged 201 + token via the JSON route', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    seedSquadInvite(harness, 'inv-fresh', 'brandnew@example.com')

    const res = await membersApp.fetch(postJson('/invites/inv-fresh/accept', { display_name: 'Brand New' }), env)
    expect(res.status).toBe(201)
    const body = await res.json() as { member_id: string; token: { raw: string } | null }
    expect(body.token?.raw).toMatch(/^mupot_[0-9a-f]{64}$/)

    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?`)
      .get(body.member_id) as { n: number }
    expect(tokenCount.n).toBe(1)
  })

  it('existing member SUSPENDED → 409 member_not_active, invite rolled back to unaccepted', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-suspended', 'suspended@example.com', 'Suspended', 'suspended', '${TENANT}');
    `)
    seedSquadInvite(harness, 'inv-suspended', 'suspended@example.com')

    const result = await acceptInvite(env, 'inv-suspended', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'member_not_active' })

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-suspended'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-suspended'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)
  })

  it('existing member belongs to ANOTHER tenant → 409 member_belongs_to_other_tenant, rolled back', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-foreign', 'foreign@example.com', 'Foreign', 'active', '${OTHER_TENANT}');
    `)
    seedSquadInvite(harness, 'inv-foreign', 'foreign@example.com')

    const result = await acceptInvite(env, 'inv-foreign', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'member_belongs_to_other_tenant' })

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-foreign'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()
  })

  it('a NULL tenant (pre-tenant-column legacy row) is treated as THIS tenant, not foreign', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-legacy', 'legacy@example.com', 'Legacy', 'active', NULL);
    `)
    seedSquadInvite(harness, 'inv-legacy-tenant', 'legacy@example.com')

    const result = await acceptInvite(env, 'inv-legacy-tenant', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.member_id).toBe('member-legacy')
    expect(result.value.linked_existing).toBe(true)
  })

  it('email case variance: invite "Shadi@X.com", member "shadi@x.com" → resolves onto the existing member', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-case', 'shadi@x.com', 'Shadi', 'active', '${TENANT}');
    `)
    harness.sqlite
      .prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
        VALUES ('inv-case', 'Shadi@X.com', 'squad-web', 'member', 'member-admin')`)
      .run()

    const result = await acceptInvite(env, 'inv-case', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.member_id).toBe('member-case')
    expect(result.value.linked_existing).toBe(true)
  })

  it('an identical existing grant is treated as satisfied — no duplicate capability row', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-already-granted', 'alreadygranted@example.com', 'Already Granted', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-existing', 'member-already-granted', 'squad', 'squad-web', 'member');
    `)
    seedSquadInvite(harness, 'inv-already-granted', 'alreadygranted@example.com')

    const result = await acceptInvite(env, 'inv-already-granted', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.capability).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'member' })

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-already-granted'`)
      .get() as { n: number }
    expect(capCount.n).toBe(1)
  })

  it('a DIFFERENT existing grant on the same scope is left untouched (no widening, no crash)', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-lead', 'alreadylead@example.com', 'Already Lead', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-lead', 'member-lead', 'squad', 'squad-web', 'lead');
    `)
    // Invite offers 'member' — LOWER than the lead grant already held.
    seedSquadInvite(harness, 'inv-already-lead', 'alreadylead@example.com')

    const result = await acceptInvite(env, 'inv-already-lead', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Reports the grant that actually governs the scope now (unchanged 'lead'),
    // not the invite's own (unapplied) 'member'.
    expect(result.value.capability).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'lead' })

    const caps = harness.sqlite
      .prepare(`SELECT capability FROM capabilities WHERE member_id = 'member-lead' AND scope_type = 'squad' AND scope_id = 'squad-web'`)
      .all() as { capability: string }[]
    expect(caps).toEqual([{ capability: 'lead' }])
  })

  it('last-resort UNIQUE-violation race guard still fires for two brand-new concurrent accepts of the SAME email', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    seedSquadInvite(harness, 'inv-race-a', 'racer@example.com')
    seedSquadInvite(harness, 'inv-race-b', 'racer@example.com')

    // Neither invite id has been accepted yet and NEITHER email exists yet —
    // both callers' own existingMember SELECT (run before either commits)
    // sees "no member", so both attempt the fresh-INSERT path. Only one can
    // win members.email's UNIQUE constraint; the other must still fall
    // through to the last-resort catch, not crash or double-mint.
    const [a, b] = await Promise.all([
      acceptInvite(env, 'inv-race-a', 'Racer A'),
      acceptInvite(env, 'inv-race-b', 'Racer B'),
    ])
    const results = [a, b]
    const wins = results.filter((r) => r.ok)
    const losses = results.filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(losses[0]).toEqual({ ok: false, error: 'member_already_exists' })

    const memberCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = 'racer@example.com'`)
      .get() as { n: number }
    expect(memberCount.n).toBe(1)

    // The losing invite was rolled back (retryable), the winner's was stamped.
    const loserInviteId = a.ok ? 'inv-race-b' : 'inv-race-a'
    const winnerInviteId = a.ok ? 'inv-race-a' : 'inv-race-b'
    const loserRow = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = ?`)
      .get(loserInviteId) as { accepted_at: string | null; member_id: string | null }
    expect(loserRow.accepted_at).toBeNull()
    expect(loserRow.member_id).toBeNull()
    const winnerRow = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = ?`)
      .get(winnerInviteId) as { accepted_at: string | null; member_id: string | null }
    expect(winnerRow.accepted_at).not.toBeNull()
    expect(winnerRow.member_id).not.toBeNull()
  })
})

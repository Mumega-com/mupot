// mupot#1457 (live shape of #1162) — invite accept must GRANT ONTO an
// existing VERIFIED member instead of dead-ending on member_already_exists.
//
// Round 1 resolved "existing member" by email alone (+ tenant/status), which
// is exactly what let an attacker SQUAT a target email: acceptInvite's own
// fresh-member path mints a member straight from an invite's server-trusted
// email with NO identity proof, so accepting ANY invite for someone else's
// email creates a row for that email with nobody having actually proven they
// own it. A LATER, higher-capability invite for that same email would then
// land its grant on the squatter's row (round-1 P0, kasra-review 2026-09-26).
// Round 2 requires a LIVE human_login_identities row (a real, verified OAuth
// login) matching the invite's email before the existing-member branch is
// even entered — see acceptInvite's own doc comment in src/members/index.ts.
//
// Round 2 also closes a P1 (existing-member grant bypassing every check
// POST /members/:id/capabilities applies: home-squad refusal, target-rank
// ceiling vs the INVITER, agent-bound handling) and folds in cheap P2s
// (org-scope duplicate via `scope_id IS ?`, ORDER BY created_at ASC on the
// resolving SELECT, exact tenant match, "accept that grants nothing" is
// reported rather than silent).
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
    -- #1457 round 2 (P1): every invite below is invited_by='member-admin' —
    -- the rank-ceiling check now needs a REAL standing to grant 'member'
    -- (rank 2) onto anyone without itself being refused. org 'admin' (rank
    -- 4) is comfortably above every capability these fixtures invite at.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-member-admin-org', 'member-admin', 'org', NULL, 'admin');
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

let identitySeq = 0
/** A LIVE human_login_identities row for `memberId` whose verified_email
 *  matches `email` — the round-2 P0 precondition for the existing-member
 *  branch to even be reachable. */
function seedVerifiedIdentity(harness: SqliteD1Harness, memberId: string, email: string, tenant = TENANT): void {
  identitySeq += 1
  harness.sqlite
    .prepare(`INSERT INTO human_login_identities
        (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES (?, ?, 'google', ?, ?, ?)`)
    .run(`ident-${identitySeq}`, tenant, `sub-${identitySeq}`, email, memberId)
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

/**
 * Wraps a real SQLite-backed D1 env so that the ONE moment acceptInvite
 * builds+binds its capability INSERT…SELECT…WHERE for `memberId` (identified
 * by the SQL text — 'INSERT INTO capabilities' + 'human_login_identities'),
 * `memberId`'s status flips to 'suspended' directly against the underlying
 * sqlite handle FIRST. This simulates a genuine concurrent suspend landing
 * between acceptInvite's own initial eligibility SELECT (already run and
 * passed by this point) and the write — the write's own re-check
 * (VERIFIED_LOGIN_IDENTITY_EXISTS_SQL + `status = 'active'`) must then match
 * zero rows. Same "thin wrapper around the real D1 harness's prepare()"
 * technique tests/team-bootstrap.test.ts uses for its own partial-failure
 * injection — everything else passes through to the genuine
 * createSqliteD1+applyAllMigrations harness untouched.
 */
function envWithStatusFlipBeforeGrantInsert(harness: SqliteD1Harness, memberId: string): Env {
  const { env } = envFor(harness)
  const realDb = env.DB
  const wrappedDb = {
    ...realDb,
    prepare(sql: string) {
      const real = realDb.prepare(sql)
      if (sql.includes('INSERT INTO capabilities') && sql.includes('human_login_identities')) {
        return {
          bind: (...args: unknown[]) => {
            harness.sqlite.prepare(`UPDATE members SET status = 'suspended' WHERE id = ?`).run(memberId)
            return real.bind(...args)
          },
        } as unknown as ReturnType<typeof realDb.prepare>
      }
      return real
    },
  } as unknown as Env['DB']
  return { ...env, DB: wrappedDb }
}

describe('acceptInvite — grants onto an existing VERIFIED member (#1457)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('login-first (JSON), VERIFIED: 200, capability on the EXISTING member, invites.member_id stamped, NO token row, linked_existing:true, granted:true', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-loginfirst', 'loginfirst@example.com', 'Login First', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-loginfirst', 'loginfirst@example.com')
    seedSquadInvite(harness, 'inv-loginfirst', 'loginfirst@example.com')

    const res = await membersApp.fetch(postJson('/invites/inv-loginfirst/accept', { display_name: 'Ignored' }), env)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      member_id: string
      token: unknown
      linked_existing: boolean
      granted: boolean
      next: string
      capability: { scope_type: string; scope_id: string; capability: string }
    }
    expect(body.member_id).toBe('member-loginfirst')
    expect(body.token).toBeNull()
    expect(body.linked_existing).toBe(true)
    expect(body.granted).toBe(true)
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

  it('login-first (HTML /invite/:id POST), VERIFIED: 200 "sign in" page, pending-invite cookie set, no token in HTML', async () => {
    harness = makeHarness()
    const { env, kv } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-html', 'htmlfirst@example.com', 'HTML First', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-html', 'htmlfirst@example.com')
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

  it('UNVERIFIED existing member (no live login identity) → member_already_exists, same as pre-#1457, NOT granted onto', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-unverified', 'unverified@example.com', 'Unverified', 'active', '${TENANT}');
    `)
    // Deliberately NO human_login_identities row for this member.
    seedSquadInvite(harness, 'inv-unverified', 'unverified@example.com')

    const result = await acceptInvite(env, 'inv-unverified', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'member_already_exists' })

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-unverified'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-unverified'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()
  })

  it('P0: an unverified squatter cannot inherit a LATER, higher-capability invite for the same email', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)

    // (1) a squad-admin (admin on squad-web only, NOT org-scoped) invites
    // ceo@corp.com at 'observer' on their own squad.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-squad-admin', 'member-admin', 'squad', 'squad-web', 'admin');
    `)
    harness.sqlite.prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squat', 'ceo@corp.com', 'squad-web', 'observer', 'member-admin')`).run()

    // (2) the squatter accepts it THEMSELVES over the public JSON route —
    // acceptInvite's fresh-member path mints straight from the invite's
    // server-trusted email, no identity proof required. They get a real bearer.
    const squatRes = await membersApp.fetch(postJson('/invites/inv-squat/accept', { display_name: 'Squatter' }), env)
    expect(squatRes.status).toBe(201)
    const squatBody = await squatRes.json() as { member_id: string; token: { raw: string } | null }
    expect(squatBody.token?.raw).toMatch(/^mupot_/)
    const squatterMemberId = squatBody.member_id

    // (3) the org owner, with no idea the email was just squatted, later
    // invites the SAME email at org 'admin'.
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-owner', 'owner@pot.test', 'Org Owner', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-org-owner', 'member-owner', 'org', NULL, 'owner');
    `)
    harness.sqlite.prepare(`INSERT INTO invites (id, email, capability, invited_by)
      VALUES ('inv-org-admin', 'ceo@corp.com', 'admin', 'member-owner')`).run()

    // (4) the REAL CEO opens the invite — this MUST 409, never land the
    // org-admin grant on the squatter's row (base/pre-fix behaviour: 200,
    // grant landed on the squatter).
    const ceoRes = await membersApp.fetch(postJson('/invites/inv-org-admin/accept', { display_name: 'Real CEO' }), env)
    expect(ceoRes.status).toBe(409)
    const ceoBody = await ceoRes.json() as { error: string }
    expect(ceoBody.error).toBe('member_already_exists')

    // No org-scope capability landed on the squatter's row — the exact
    // takeover this fix closes.
    const orgCap = harness.sqlite
      .prepare(`SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'org'`)
      .get(squatterMemberId)
    expect(orgCap).toBeUndefined()

    // The org-admin invite itself was rolled back — retryable once an
    // operator deals with the squatted row (e.g. suspends it).
    const inviteRow = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-org-admin'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(inviteRow.accepted_at).toBeNull()
    expect(inviteRow.member_id).toBeNull()
  })

  it('existing VERIFIED member SUSPENDED → 409 member_not_active, invite rolled back to unaccepted', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-suspended', 'suspended@example.com', 'Suspended', 'suspended', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-suspended', 'suspended@example.com')
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

  it('existing VERIFIED member belongs to ANOTHER tenant → 409 member_belongs_to_other_tenant, rolled back', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-foreign', 'foreign@example.com', 'Foreign', 'active', '${OTHER_TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-foreign', 'foreign@example.com', OTHER_TENANT)
    seedSquadInvite(harness, 'inv-foreign', 'foreign@example.com')

    const result = await acceptInvite(env, 'inv-foreign', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'member_belongs_to_other_tenant' })

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-foreign'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()
  })

  // #1457 round 2 (P2): tightened from round 1's "NULL tenant = this
  // tenant" leniency to an EXACT match, same convention resolve-human-
  // member.ts's own lookup uses — an unstamped row is exactly the shape a
  // squatter row (never through any tenant-stamping path) would have.
  it('a NULL tenant on an existing VERIFIED member is now treated as FOREIGN, not this tenant', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-legacy', 'legacy@example.com', 'Legacy', 'active', NULL);
    `)
    seedVerifiedIdentity(harness, 'member-legacy', 'legacy@example.com')
    seedSquadInvite(harness, 'inv-legacy-tenant', 'legacy@example.com')

    const result = await acceptInvite(env, 'inv-legacy-tenant', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'member_belongs_to_other_tenant' })
  })

  it('email case variance: invite "Shadi@X.com", member "shadi@x.com", VERIFIED → resolves onto the existing member', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-case', 'shadi@x.com', 'Shadi', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-case', 'shadi@x.com')
    harness.sqlite
      .prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
        VALUES ('inv-case', 'Shadi@X.com', 'squad-web', 'member', 'member-admin')`)
      .run()

    const result = await acceptInvite(env, 'inv-case', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.member_id).toBe('member-case')
    expect(result.value.linked_existing).toBe(true)
    expect(result.value.granted).toBe(true)
  })

  it('an identical existing grant is treated as satisfied — no duplicate row, granted:false', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-already-granted', 'alreadygranted@example.com', 'Already Granted', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-existing', 'member-already-granted', 'squad', 'squad-web', 'member');
    `)
    seedVerifiedIdentity(harness, 'member-already-granted', 'alreadygranted@example.com')
    seedSquadInvite(harness, 'inv-already-granted', 'alreadygranted@example.com')

    const result = await acceptInvite(env, 'inv-already-granted', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.capability).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'member' })
    expect(result.value.granted).toBe(false)

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-already-granted'`)
      .get() as { n: number }
    expect(capCount.n).toBe(1)
  })

  it('a DIFFERENT existing grant on the same scope is left untouched (no widening, no crash), granted:false', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-lead', 'alreadylead@example.com', 'Already Lead', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-lead', 'member-lead', 'squad', 'squad-web', 'lead');
    `)
    seedVerifiedIdentity(harness, 'member-lead', 'alreadylead@example.com')
    // Invite offers 'member' — LOWER than the lead grant already held.
    seedSquadInvite(harness, 'inv-already-lead', 'alreadylead@example.com')

    const result = await acceptInvite(env, 'inv-already-lead', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Reports the grant that actually governs the scope now (unchanged 'lead'),
    // not the invite's own (unapplied) 'member'.
    expect(result.value.capability).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'lead' })
    expect(result.value.granted).toBe(false)

    const caps = harness.sqlite
      .prepare(`SELECT capability FROM capabilities WHERE member_id = 'member-lead' AND scope_type = 'squad' AND scope_id = 'squad-web'`)
      .all() as { capability: string }[]
    expect(caps).toEqual([{ capability: 'lead' }])
  })

  it('P1: a grant that would raise a VERIFIED target above the INVITER\'s own rank is refused', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-squad-admin', 'squadadmin@pot.test', 'Squad Admin', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-squad-admin-inviter', 'member-squad-admin', 'squad', 'squad-web', 'admin');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-target', 'target@example.com', 'Target', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-target', 'target@example.com')
    // The inviter (squad-admin, global rank 4) invites at 'owner' (rank 5) —
    // above their own standing.
    harness.sqlite.prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-outrank', 'target@example.com', 'squad-web', 'owner', 'member-squad-admin')`).run()

    const result = await acceptInvite(env, 'inv-outrank', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'existing_member_grant_refused' })

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-target' AND scope_type = 'squad' AND scope_id = 'squad-web'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-outrank'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()
  })

  it('P1: a grant at/below the inviter\'s own rank is NOT refused by the rank ceiling', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-squad-admin-2', 'squadadmin2@pot.test', 'Squad Admin 2', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-squad-admin-inviter-2', 'member-squad-admin-2', 'squad', 'squad-web', 'admin');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-target-2', 'target2@example.com', 'Target 2', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-target-2', 'target2@example.com')
    // 'admin' (rank 4) == the inviter's own rank (4) — not ABOVE, so the
    // ceiling (a strict `>`) does not refuse it.
    harness.sqlite.prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-at-rank', 'target2@example.com', 'squad-web', 'admin', 'member-squad-admin-2')`).run()

    const result = await acceptInvite(env, 'inv-at-rank', 'Whatever')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.granted).toBe(true)
  })

  it('P1: an invite scoped to a kind=home squad is refused even for a verified existing member', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind)
        VALUES ('squad-home-x', 'dept-a', 'squad-home-x', 'Home X', 'home');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-home-target', 'hometarget@example.com', 'Home Target', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-home-target', 'hometarget@example.com')
    harness.sqlite.prepare(`INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-home', 'hometarget@example.com', 'squad-home-x', 'member', 'member-admin')`).run()

    const result = await acceptInvite(env, 'inv-home', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'existing_member_grant_refused' })

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-home-target'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)
  })

  it('P1: an agent-bound existing member is refused, even VERIFIED', async () => {
    harness = makeHarness()
    const { env } = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-x', 'squad-web', 'agent-x', 'Agent X');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-agent-bound', 'agentbound@example.com', 'Agent Bound', 'active', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-x', 'member-agent-bound', datetime('now'));
    `)
    seedVerifiedIdentity(harness, 'member-agent-bound', 'agentbound@example.com')
    seedSquadInvite(harness, 'inv-agent-bound', 'agentbound@example.com')

    const result = await acceptInvite(env, 'inv-agent-bound', 'Whatever')
    expect(result).toEqual({ ok: false, error: 'existing_member_grant_refused' })

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-agent-bound'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)
  })

  it('P0 race close: a status change between the eligibility SELECT and the grant INSERT lands ZERO capability rows', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-race-status', 'racestatus@example.com', 'Race Status', 'active', '${TENANT}');
    `)
    seedVerifiedIdentity(harness, 'member-race-status', 'racestatus@example.com')
    seedSquadInvite(harness, 'inv-race-status', 'racestatus@example.com')
    const env = envWithStatusFlipBeforeGrantInsert(harness, 'member-race-status')

    // The initial eligibility SELECT sees an active member and passes every
    // JS-level check; the member is suspended (by the wrapper) at the exact
    // moment the grant INSERT is built — the INSERT's OWN re-check (not the
    // earlier JS checks) must be what stops the write.
    await expect(acceptInvite(env, 'inv-race-status', 'Whatever')).rejects.toThrow()

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'member-race-status'`)
      .get() as { n: number }
    expect(capCount.n).toBe(0)

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-race-status'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).toBeNull()
    expect(invite.member_id).toBeNull()
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

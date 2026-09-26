// tests/exclusive-control-attach.test.ts — mupot#1551, Athena's DESIGN RULING
// (Option B, 2026-09-26): "verified identity is not exclusive control."
//
// Covers the shared tri-state predicate (src/members/exclusive-control.ts)
// directly, plus both call sites it must own end-to-end through the real
// routes: ordinary Google login (src/auth callback, provider mocked the way
// tests/invite-login-link.test.ts does) and enterprise SSO auto-enrollment
// (src/auth/sso.ts). Real migration chain (createSqliteD1 + applyAllMigrations)
// everywhere; only the Google token/userinfo endpoints are stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { autoEnrollSsoMember } from '../src/auth/sso'
import { acceptInvite } from '../src/members'
import {
  decideIdentitylessAttach,
  PROVISIONING_EXEMPT_TOKEN_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_LABEL,
} from '../src/members/exclusive-control'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-b'
const ORIGIN = 'https://pot.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

function envFor(harness: SqliteD1Harness, kv: ReturnType<typeof memoryKv>): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-client-secret',
    SESSIONS: kv,
  } as unknown as Env
}

function stubGoogle(email: string, sub: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
      }
      if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
        return new Response(JSON.stringify({ sub, email, email_verified: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function startLogin(env: Env): Promise<string> {
  const res = await authApp.request(`${ORIGIN}/login`, {}, env)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state')
  if (!state) throw new Error('login redirect missing state')
  return state
}

function callbackReq(state: string) {
  return new Request(`${ORIGIN}/callback?code=abc&state=${encodeURIComponent(state)}`)
}

async function googleLogin(env: Env, email: string, sub: string) {
  stubGoogle(email, sub)
  const state = await startLogin(env)
  return authApp.fetch(callbackReq(state), env)
}

function identityCountForEmail(harness: SqliteD1Harness): number {
  return (
    harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM human_login_identities`).get() as { n: number }
  ).n
}

function memberCount(harness: SqliteD1Harness, email: string): number {
  return (
    harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = lower(?)`)
      .get(email) as { n: number }
  ).n
}

function seedMember(
  harness: SqliteD1Harness,
  id: string,
  email: string | null,
  opts: { status?: string; telegramChatId?: string | null } = {},
) {
  harness.sqlite
    .prepare(
      `INSERT INTO members (id, tenant, email, display_name, telegram_chat_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, TENANT, email, id, opts.telegramChatId ?? null, opts.status ?? 'active')
}

function seedBearer(
  harness: SqliteD1Harness,
  memberId: string,
  opts: {
    label?: string
    channel?: string
    agentId?: string | null
    revokedAt?: string | null
    expiresAt?: string | null
    tokenHash?: string
  } = {},
) {
  if (opts.agentId) {
    // 0071's member_tokens_agent_binding_insert trigger requires the
    // (tenant, agent_id, member_id) binding to already exist before an
    // agent-scoped token can be inserted; agents needs a real squad row.
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-x', 'dept-x', 'Dept X');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-x', 'dept-x', 'squad-x', 'Squad X');
    `)
    harness.sqlite
      .prepare(
        `INSERT INTO agents (id, squad_id, slug, name, role, status, created_at)
         VALUES (?, 'squad-x', ?, ?, 'lead', 'active', datetime('now'))`,
      )
      .run(opts.agentId, opts.agentId, opts.agentId)
    harness.sqlite
      .prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(TENANT, opts.agentId, memberId)
  }
  harness.sqlite
    .prepare(
      `INSERT INTO member_tokens
         (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      memberId,
      opts.tokenHash ?? crypto.randomUUID(),
      opts.label ?? 'workspace',
      opts.channel ?? 'workspace',
      opts.agentId ?? null,
      TENANT,
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
    )
}

/**
 * A "clean legacy identity-less" row, minted through the REAL `acceptInvite()`
 * (mintToken:false — the no-mint boundary Option A/#1557 makes the JSON
 * route's own default; a hand-rolled `INSERT INTO members` fixture would
 * drift from that function's actual columns/defaults and would not prove
 * anything about the real product path). Org-level invite: no department_id,
 * no squad_id, so `acceptInvite` grants org/member.
 */
async function acceptCleanInvite(
  harness: SqliteD1Harness,
  env: Env,
  inviteId: string,
  email: string,
): Promise<string> {
  harness.sqlite
    .prepare(`INSERT INTO invites (id, email, capability, invited_by) VALUES (?, ?, 'member', ?)`)
    .run(inviteId, email, 'seed-admin')
  const accepted = await acceptInvite(env, inviteId, 'Compat Pin User', { mintToken: false })
  if (!accepted.ok) throw new Error(`acceptInvite failed: ${accepted.error}`)
  if (accepted.value.token !== null) {
    throw new Error('acceptInvite({mintToken:false}) unexpectedly minted a token')
  }
  return accepted.value.member_id
}

describe('decideIdentitylessAttach — unit (mutation-proved)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('not_found: no member with that email', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'nobody@example.com',
    })
    expect(result).toEqual({ kind: 'not_found' })
  })

  it('ambiguous: two case-variant rows, never an arbitrary pick', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-1', 'Dup@Example.com')
    seedMember(harness, 'mem-2', 'dup@example.com')
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'dup@example.com',
    })
    expect(result).toEqual({ kind: 'ambiguous' })
  })

  it('tenant-scoped: a same-email row in a DIFFERENT tenant is invisible', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite
      .prepare(
        `INSERT INTO members (id, tenant, email, display_name, status, created_at)
         VALUES ('mem-other-tenant', 'other-tenant', 'shared@example.com', 'x', 'active', datetime('now'))`,
      )
      .run()
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'shared@example.com',
    })
    expect(result).toEqual({ kind: 'not_found' })
  })

  it('eligible: a clean identity-less, token-less, telegram-less row from a REAL acceptInvite() (compatibility pin — C deferred)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
    const memberId = await acceptCleanInvite(harness, env, 'inv-clean-unit', 'clean@example.com')
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'clean@example.com',
    })
    expect(result).toEqual({ kind: 'eligible', memberId, status: 'active' })
  })

  it('denied: telegram-bound row', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-tg', 'tg@example.com', { telegramChatId: '555' })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'tg@example.com',
    })
    expect(result).toEqual({ kind: 'denied_competing_control', reason: 'telegram_bound' })
  })

  it('denied: any live human_login_identities row for the member', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-ident', 'ident@example.com')
    const linked = await linkLoginIdentity({ DB: harness.db } as unknown as Env, {
      tenant: TENANT,
      provider: 'saml',
      providerSubject: 'sub-other',
      verifiedEmail: 'other-verified@example.com',
      memberId: 'mem-ident',
    })
    expect(linked.ok).toBe(true)
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'ident@example.com',
    })
    expect(result).toEqual({ kind: 'denied_competing_control', reason: 'live_login_identity' })
  })

  it('denied: legacy public-accept live bearer (label=workspace, channel=workspace, agent_id NULL)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-squat', 'squat@example.com')
    seedBearer(harness, 'mem-squat')
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'squat@example.com',
    })
    expect(result).toEqual({ kind: 'denied_competing_control', reason: 'live_member_bearer' })
  })

  it('NOT denied: a REVOKED bearer does not block (liveness, not existence)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-revoked', 'revoked@example.com')
    seedBearer(harness, 'mem-revoked', { revokedAt: new Date().toISOString() })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'revoked@example.com',
    })
    expect(result).toEqual({ kind: 'eligible', memberId: 'mem-revoked', status: 'active' })
  })

  it('NOT denied: an EXPIRED bearer does not block (shared liveness predicate, not revoked_at alone)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-expired', 'expired@example.com')
    seedBearer(harness, 'mem-expired', { expiresAt: '2020-01-01 00:00:00' })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'expired@example.com',
    })
    expect(result).toEqual({ kind: 'eligible', memberId: 'mem-expired', status: 'active' })
  })

  it('NOT denied: an agent-BOUND token (agent_id set) is not a human bearer', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-agent-tok', 'agenttok@example.com')
    seedBearer(harness, 'mem-agent-tok', { agentId: 'some-agent-id', label: 'seed-seat' })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'agenttok@example.com',
    })
    expect(result).toEqual({ kind: 'eligible', memberId: 'mem-agent-tok', status: 'active' })
  })

  it('NOT denied: the pot-provisioned admin/dashboard seed token is the explicit exemption', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-provisioned', 'provisioned@example.com')
    seedBearer(harness, 'mem-provisioned', {
      label: PROVISIONING_EXEMPT_TOKEN_LABEL,
      channel: PROVISIONING_EXEMPT_TOKEN_CHANNEL,
    })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'provisioned@example.com',
    })
    expect(result).toEqual({ kind: 'eligible', memberId: 'mem-provisioned', status: 'active' })
  })

  it('a SECOND, non-exempt live bearer next to the admin/dashboard seed still blocks', async () => {
    // The exemption is per-ROW (label+channel), never "this member is exempt".
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-mixed', 'mixed@example.com')
    seedBearer(harness, 'mem-mixed', {
      label: PROVISIONING_EXEMPT_TOKEN_LABEL,
      channel: PROVISIONING_EXEMPT_TOKEN_CHANNEL,
    })
    seedBearer(harness, 'mem-mixed', { label: 'workspace', channel: 'workspace' })
    const env = { DB: harness.db } as unknown as Env
    const result = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'mixed@example.com',
    })
    expect(result).toEqual({ kind: 'denied_competing_control', reason: 'live_member_bearer' })
  })

  it('does not widen the exemption to only "channel=dashboard" or only "label=admin"', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-partial-a', 'partiala@example.com')
    seedBearer(harness, 'mem-partial-a', { label: PROVISIONING_EXEMPT_TOKEN_LABEL, channel: 'workspace' })
    seedMember(harness, 'mem-partial-b', 'partialb@example.com')
    seedBearer(harness, 'mem-partial-b', { label: 'workspace', channel: PROVISIONING_EXEMPT_TOKEN_CHANNEL })
    const env = { DB: harness.db } as unknown as Env
    await expect(
      decideIdentitylessAttach(env, { tenant: TENANT, normalizedEmail: 'partiala@example.com' }),
    ).resolves.toEqual({ kind: 'denied_competing_control', reason: 'live_member_bearer' })
    await expect(
      decideIdentitylessAttach(env, { tenant: TENANT, normalizedEmail: 'partialb@example.com' }),
    ).resolves.toEqual({ kind: 'denied_competing_control', reason: 'live_member_bearer' })
  })
})

describe('linkLoginIdentity — requireExclusiveControl atomic guard (mupot#1551 point 4)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('a competing bearer landing AFTER the decision but BEFORE the write makes the link fail atomically', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-race', 'race@example.com')
    const env = { DB: harness.db } as unknown as Env

    const decision = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'race@example.com',
    })
    expect(decision).toEqual({ kind: 'eligible', memberId: 'mem-race', status: 'active' })

    // Race: a bearer lands for this member between the read above and the
    // write below (e.g. a concurrent invite-accept on the same row).
    seedBearer(harness, 'mem-race')

    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-race',
      verifiedEmail: 'race@example.com',
      memberId: 'mem-race',
      requireExclusiveControl: true,
    })
    expect(linked).toEqual({ ok: false, error: 'competing_control' })
    expect(identityCountForEmail(harness)).toBe(0)
  })

  it('a competing identity landing in the race window also fails the write (atomic recheck, not just the read)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-race-ident', 'raceident@example.com')
    const env = { DB: harness.db } as unknown as Env
    const decision = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'raceident@example.com',
    })
    expect(decision.kind).toBe('eligible')

    // Race: a DIFFERENT login claims this same row between the read above and
    // the write below (e.g. two concurrent first-logins for the same email).
    const rival = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'saml',
      providerSubject: 'sub-rival',
      verifiedEmail: 'raceident@example.com',
      memberId: 'mem-race-ident',
    })
    expect(rival.ok).toBe(true)

    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-loser',
      verifiedEmail: 'raceident@example.com',
      memberId: 'mem-race-ident',
      requireExclusiveControl: true,
    })
    expect(linked).toEqual({ ok: false, error: 'competing_control' })
    expect(identityCountForEmail(harness)).toBe(1)
  })

  it('a competing Telegram bind landing in the race window also fails the write', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-race-tg', 'racetg@example.com')
    const env = { DB: harness.db } as unknown as Env
    const decision = await decideIdentitylessAttach(env, {
      tenant: TENANT,
      normalizedEmail: 'racetg@example.com',
    })
    expect(decision.kind).toBe('eligible')

    harness.sqlite
      .prepare(`UPDATE members SET telegram_chat_id = '999' WHERE id = 'mem-race-tg'`)
      .run()

    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-race-tg',
      verifiedEmail: 'racetg@example.com',
      memberId: 'mem-race-tg',
      requireExclusiveControl: true,
    })
    expect(linked).toEqual({ ok: false, error: 'competing_control' })
    expect(identityCountForEmail(harness)).toBe(0)
  })

  it('without the race, a clean eligible row still links normally under the guard', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-clean-link', 'cleanlink@example.com')
    const env = { DB: harness.db } as unknown as Env
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-clean',
      verifiedEmail: 'cleanlink@example.com',
      memberId: 'mem-clean-link',
      requireExclusiveControl: true,
    })
    expect(linked.ok).toBe(true)
    expect(identityCountForEmail(harness)).toBe(1)
  })

  it('idempotent: a repeat login under the SAME join key still short-circuits before the guard', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-idem', 'idem@example.com')
    const env = { DB: harness.db } as unknown as Env
    const first = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-idem',
      verifiedEmail: 'idem@example.com',
      memberId: 'mem-idem',
      requireExclusiveControl: true,
    })
    expect(first.ok).toBe(true)
    // A bearer now appears — irrelevant, the join key already has a live row.
    seedBearer(harness, 'mem-idem')
    const second = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-idem',
      verifiedEmail: 'idem@example.com',
      memberId: 'mem-idem',
      requireExclusiveControl: true,
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.created).toBe(false)
    expect(identityCountForEmail(harness)).toBe(1)
  })
})

describe('GET /auth/callback (Google login) — exclusive-control attach end to end', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.unstubAllGlobals()
  })

  it('clean legacy identity-less row from a REAL acceptInvite() still attaches (compatibility pin — C deferred, do not remove without a migration)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness, memoryKv())
    const memberId = await acceptCleanInvite(harness, env, 'inv-clean-e2e', 'clean@example.com')

    const res = await googleLogin(env, 'clean@example.com', 'google-sub-clean')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(1)
    const row = harness.sqlite
      .prepare(`SELECT member_id, provider, provider_subject FROM human_login_identities`)
      .get() as { member_id: string; provider: string; provider_subject: string }
    expect(row).toEqual({ member_id: memberId, provider: 'google', provider_subject: 'google-sub-clean' })
  })

  it('API accept (real acceptInvite, mintToken:false, next:sign_in) → ordinary Google login → linked to THAT exact member, with the invite-granted capability intact', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness, memoryKv())

    // Real invite acceptance through the actual member-creation code path —
    // the JSON accept door's own no-mint boundary (Option A/#1557: this route
    // now returns token:null and next:'sign_in', never a bearer for an
    // unverified email). The org/member capability grant is acceptInvite's
    // own write, not a test fixture.
    const memberId = await acceptCleanInvite(harness, env, 'inv-api-then-login', 'apilogin@example.com')
    const grant = harness.sqlite
      .prepare(`SELECT scope_type, capability FROM capabilities WHERE member_id = ?`)
      .get(memberId) as { scope_type: string; capability: string } | undefined
    expect(grant).toEqual({ scope_type: 'org', capability: 'member' })
    // No bearer, no identity, no Telegram bind yet — this member is
    // genuinely identity-less at this point, exactly the row Cause 2
    // describes, except this time it was never squatted.
    expect(identityCountForEmail(harness)).toBe(0)

    // The real human now completes an ordinary IdP login with the SAME
    // (verified) email the invite was addressed to.
    const res = await googleLogin(env, 'apilogin@example.com', 'google-sub-apilogin')
    expect(res.status).toBe(302)

    expect(identityCountForEmail(harness)).toBe(1)
    const row = harness.sqlite
      .prepare(
        `SELECT member_id, provider, provider_subject FROM human_login_identities`,
      )
      .get() as { member_id: string; provider: string; provider_subject: string }
    // Linked to THAT exact member the invite minted — not a lookalike, not a
    // duplicate.
    expect(row.member_id).toBe(memberId)
    expect(row).toEqual({ member_id: memberId, provider: 'google', provider_subject: 'google-sub-apilogin' })
    // The capability the invite granted survives untouched — the login
    // attached an identity, it did not re-provision the member.
    const grantAfter = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ?`)
      .get(memberId) as { n: number }
    expect(grantAfter.n).toBe(1)
  })

  it('pot-provisioned admin/dashboard member still attaches', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-admin-seed', 'admin@example.com')
    seedBearer(harness, 'mem-admin-seed', {
      label: PROVISIONING_EXEMPT_TOKEN_LABEL,
      channel: PROVISIONING_EXEMPT_TOKEN_CHANNEL,
    })
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'admin@example.com', 'google-sub-admin')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(1)
  })

  it('legacy public-accept live bearer BLOCKS attach — the mupot#1551 cause-1 shape', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-squat', 'squat@example.com')
    seedBearer(harness, 'mem-squat') // label=workspace, channel=workspace, agent_id NULL, live
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'squat@example.com', 'google-sub-real-owner')
    // Best-effort: login itself still succeeds (KV+cookie session), it just
    // never registers the D1 identity link — see registerWebSession's own
    // contract.
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(0)
  })

  it('a REVOKED legacy bearer does not block attach', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-revoked', 'revoked@example.com')
    seedBearer(harness, 'mem-revoked', { revokedAt: new Date().toISOString() })
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'revoked@example.com', 'google-sub-revoked')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(1)
  })

  it('an EXPIRED legacy bearer does not block attach', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-expired', 'expired@example.com')
    seedBearer(harness, 'mem-expired', { expiresAt: '2020-01-01 00:00:00' })
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'expired@example.com', 'google-sub-expired')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(1)
  })

  it('Telegram-bound row BLOCKS attach', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-tg', 'tg@example.com', { telegramChatId: '12345' })
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'tg@example.com', 'google-sub-tg')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(0)
  })

  it('two case-variant email rows refuse as ambiguous — never an arbitrary attach', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-dup-1', 'Dup@Example.com')
    seedMember(harness, 'mem-dup-2', 'dup@example.com')
    const env = envFor(harness, memoryKv())

    const res = await googleLogin(env, 'dup@example.com', 'google-sub-dup')
    expect(res.status).toBe(302)
    expect(identityCountForEmail(harness)).toBe(0)
  })
})

describe('autoEnrollSsoMember — exclusive-control fallback (mupot#1551)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  function ssoEnv(harness: SqliteD1Harness): Env {
    return {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env
  }

  it('SSO cannot recover a denied (bearer-squatted) candidate via the old raw-email fallback, and does not duplicate', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-squat-sso', 'squatsso@example.com')
    seedBearer(harness, 'mem-squat-sso')
    const env = ssoEnv(harness)

    const result = await autoEnrollSsoMember(env, { email: 'squatsso@example.com', provider: 'google' })
    expect(result).toMatchObject({ ok: false, error: 'member_row_competing_control', isNew: false })
    expect(memberCount(harness, 'squatsso@example.com')).toBe(1)
  })

  it('SSO cannot recover a Telegram-bound candidate either', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'mem-tg-sso', 'tgsso@example.com', { telegramChatId: '777' })
    const env = ssoEnv(harness)

    const result = await autoEnrollSsoMember(env, { email: 'tgsso@example.com', provider: 'google' })
    expect(result).toMatchObject({ ok: false, error: 'member_row_competing_control', isNew: false })
    expect(memberCount(harness, 'tgsso@example.com')).toBe(1)
  })

  it('SSO fails closed on an ambiguous case-variant pair instead of an arbitrary pick', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    // Both suspended so the resolver's own activeOnly filter misses on both,
    // forcing this into the fallback (resolvedId === null) — the exact
    // scenario the old raw `LIMIT 1` fallback would have silently picked one
    // of.
    seedMember(harness, 'mem-dup-sso-1', 'Dupsso@Example.com', { status: 'suspended' })
    seedMember(harness, 'mem-dup-sso-2', 'dupsso@example.com', { status: 'suspended' })
    const env = ssoEnv(harness)

    const result = await autoEnrollSsoMember(env, { email: 'dupsso@example.com', provider: 'google' })
    expect(result).toMatchObject({ ok: false, error: 'member_email_ambiguous', isNew: false })
  })

  it('SSO still enrolls onto a genuinely clean, resolver-missed row (not_found -> new member, unchanged)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = ssoEnv(harness)
    harness.sqlite
      .prepare(
        `INSERT INTO org_settings (key, value, updated_at)
         VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
      )
      .run(JSON.stringify({ enabled: false, allowed_domains: [], default_role: 'member' }))

    const result = await autoEnrollSsoMember(env, { email: 'brandnew@example.com', provider: 'google' })
    expect(result).toMatchObject({ ok: true, isNew: true, role: 'member' })
    expect(memberCount(harness, 'brandnew@example.com')).toBe(1)
  })
})

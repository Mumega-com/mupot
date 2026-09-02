// tests/web-sessions.test.ts — the D1-backed, listable/revocable/expiring
// session registry (Delivery Sequence step 1, docs/superpowers/specs/
// 2026-09-01-human-approved-session-bound-agent-elevation-design.md).
//
// RED/GREEN framing: before this module existed, mupot's ONLY session record
// was a KV blob with a flat 7-day TTL (src/auth/index.ts) — unlistable,
// remotely unrevocable, with no idle timeout and no recent-reauth marker. Every
// test below is RED against that old shape (there was no D1 row to query, no
// idle/absolute distinction, no revoke primitive) and GREEN against this one.
// Uses the REAL migration chain (createSqliteD1 + applyAllMigrations) — never
// a hand-written schema — per tests/helpers/migrations.ts's own rule.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  ABSOLUTE_TTL_MS,
  IDLE_TIMEOUT_MS,
  LAST_SEEN_COALESCE_MS,
  RECENT_REAUTH_WINDOW_MS,
  createWebSession,
  evaluateWebSession,
  hasRecentReauth,
  hashWebSessionId,
  listWebSessions,
  loadLiveReauthIdentity,
  loadWebSession,
  markRecentReauth,
  revokeAllWebSessions,
  revokeWebSession,
  revokeWebSessionByHash,
  revokeWebSessionsForLoginIdentity,
  touchWebSession,
} from '../src/auth/web-sessions'

const TENANT = 'mumega'

describe('web-session registry (D1, real migration chain)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  async function seedMemberAndIdentity(memberId: string, email: string, provider = 'google', subject = memberId) {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, ?3, ?3, 'active', ?4)`,
    )
      .bind(memberId, TENANT, email, now)
      .run()
    const identityId = `id-${memberId}`
    await env.DB.prepare(
      `INSERT INTO human_login_identities
         (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(identityId, TENANT, provider, subject, email, memberId, now)
      .run()
    return identityId
  }

  it('creates a row whose id_hash is the SHA-256 of the raw session id — the raw value is never persisted', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-session-value-abc'
    const record = await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId })

    expect(record.id_hash).toBe(await hashWebSessionId(raw))
    expect(record.id_hash).not.toBe(raw)

    const row = await env.DB.prepare('SELECT * FROM web_sessions WHERE id_hash = ?1').bind(record.id_hash).first()
    expect(row).toBeTruthy()
    // The raw value never appears anywhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(raw)
  })

  it('sets independent idle (24h) and absolute (7d) ceilings at creation', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const record = await createWebSession(
      env,
      'raw-1',
      { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId },
      nowMs,
    )
    expect(Date.parse(record.idle_expires_at)).toBe(nowMs + IDLE_TIMEOUT_MS)
    expect(Date.parse(record.absolute_expires_at)).toBe(nowMs + ABSOLUTE_TTL_MS)
  })

  it('loadWebSession: not_found for an unknown raw id', async () => {
    const result = await loadWebSession(env, TENANT, 'never-minted')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('loadWebSession: fails closed on a DIFFERENT tenant (no cross-tenant read)', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-cross-tenant'
    await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId })
    const result = await loadWebSession(env, 'other-tenant', raw)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('loadWebSession: ok for a freshly-created, unexpired, unrevoked session', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-live'
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, nowMs)
    const result = await loadWebSession(env, TENANT, raw, nowMs + 1000)
    expect(result.ok).toBe(true)
  })

  it('evaluateWebSession: revoked wins even if neither expiry has passed yet', () => {
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const session = {
      id_hash: 'h', tenant: TENANT, member_id: 'm1', login_identity_id: 'i1',
      created_at: new Date(nowMs).toISOString(),
      last_seen_at: new Date(nowMs).toISOString(),
      idle_expires_at: new Date(nowMs + IDLE_TIMEOUT_MS).toISOString(),
      absolute_expires_at: new Date(nowMs + ABSOLUTE_TTL_MS).toISOString(),
      recent_reauth_at: null,
      revoked_at: new Date(nowMs).toISOString(),
      revoke_reason: 'human_revoke',
    }
    expect(evaluateWebSession(session, nowMs + 1)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('idle expiry (24h) fails closed even though absolute (7d) has not passed', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-idle'
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, t0)
    // Exactly at the idle boundary — still well inside the 7-day absolute window.
    const result = await loadWebSession(env, TENANT, raw, t0 + IDLE_TIMEOUT_MS)
    expect(result).toEqual({ ok: false, reason: 'expired_idle' })
  })

  it('absolute expiry (7d) fails closed even if the session has been continuously touched', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-absolute'
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, t0)

    // Touch every 20 hours (< 24h idle window) up to just past the 7-day mark —
    // idle_expires_at keeps getting bumped forward, but absolute_expires_at is
    // FIXED at creation and this loop never rescues the session past it.
    let idHash = await hashWebSessionId(raw)
    let t = t0
    while (t < t0 + ABSOLUTE_TTL_MS) {
      t += 20 * 60 * 60 * 1000
      await touchWebSession(env, idHash, t)
    }
    const result = await loadWebSession(env, TENANT, raw, t)
    expect(result).toEqual({ ok: false, reason: 'expired_absolute' })
  })

  it('touchWebSession coalesces: no write (and no idle bump) inside the 5-minute window', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-coalesce'
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, t0)
    const idHash = created.id_hash

    await touchWebSession(env, idHash, t0 + LAST_SEEN_COALESCE_MS - 1000) // just under 5 min
    const row = await env.DB.prepare('SELECT last_seen_at, idle_expires_at FROM web_sessions WHERE id_hash = ?1')
      .bind(idHash)
      .first<{ last_seen_at: string; idle_expires_at: string }>()
    expect(row?.last_seen_at).toBe(created.last_seen_at)
    expect(row?.idle_expires_at).toBe(created.idle_expires_at)
  })

  it('touchWebSession bumps last_seen_at + idle_expires_at once the coalesce window has passed', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-bump'
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, t0)
    const t1 = t0 + LAST_SEEN_COALESCE_MS + 1000
    await touchWebSession(env, created.id_hash, t1)
    const row = await env.DB.prepare('SELECT last_seen_at, idle_expires_at FROM web_sessions WHERE id_hash = ?1')
      .bind(created.id_hash)
      .first<{ last_seen_at: string; idle_expires_at: string }>()
    expect(row?.last_seen_at).toBe(new Date(t1).toISOString())
    expect(Date.parse(row!.idle_expires_at)).toBe(t1 + IDLE_TIMEOUT_MS)
  })

  it('touchWebSession never resurrects a revoked session', async () => {
    const identityId = await seedMemberAndIdentity('m1', 'a@x.test')
    const raw = 'raw-revoked-touch'
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createWebSession(env, raw, { tenant: TENANT, memberId: 'm1', loginIdentityId: identityId }, t0)
    await revokeWebSession(env, TENANT, 'm1', created.id_hash, 'test', t0)
    await touchWebSession(env, created.id_hash, t0 + LAST_SEEN_COALESCE_MS + 1000)
    const row = await env.DB.prepare('SELECT last_seen_at FROM web_sessions WHERE id_hash = ?1')
      .bind(created.id_hash)
      .first<{ last_seen_at: string }>()
    // WHERE ... AND revoked_at IS NULL in the UPDATE means a revoked row's
    // last_seen_at is untouched by a later touch call.
    expect(row?.last_seen_at).toBe(created.last_seen_at)
  })

  it('listWebSessions: newest first, scoped to (tenant, member) — never leaks another member/tenant', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const id2 = await seedMemberAndIdentity('m2', 'b@x.test')
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    await createWebSession(env, 'raw-1', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 }, t0)
    await createWebSession(env, 'raw-2', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 }, t0 + 1000)
    await createWebSession(env, 'raw-other-member', { tenant: TENANT, memberId: 'm2', loginIdentityId: id2 }, t0)

    const rows = await listWebSessions(env, TENANT, 'm1')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.member_id === 'm1')).toBe(true)
    expect(Date.parse(rows[0].created_at)).toBeGreaterThanOrEqual(Date.parse(rows[1].created_at))
  })

  it('revokeWebSession: ownership-scoped — a DIFFERENT member cannot revoke this session', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    await seedMemberAndIdentity('m2', 'b@x.test')
    const created = await createWebSession(env, 'raw-owned', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })

    const wrongOwner = await revokeWebSession(env, TENANT, 'm2', created.id_hash, 'human_revoke')
    expect(wrongOwner.revoked).toBe(false)

    const stillLive = await loadWebSession(env, TENANT, 'raw-owned')
    expect(stillLive.ok).toBe(true)

    const rightOwner = await revokeWebSession(env, TENANT, 'm1', created.id_hash, 'human_revoke')
    expect(rightOwner.revoked).toBe(true)

    const dead = await loadWebSession(env, TENANT, 'raw-owned')
    expect(dead).toEqual({ ok: false, reason: 'revoked' })
  })

  it('revokeWebSession: idempotent — revoking an already-revoked row is a no-op, never an error', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const created = await createWebSession(env, 'raw-idem', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    const first = await revokeWebSession(env, TENANT, 'm1', created.id_hash, 'human_revoke')
    expect(first.revoked).toBe(true)
    const second = await revokeWebSession(env, TENANT, 'm1', created.id_hash, 'human_revoke')
    expect(second.revoked).toBe(false)
  })

  it('revokeAllWebSessions: kills every sibling but the caller\'s own — "sign out other devices"', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const s1 = await createWebSession(env, 'raw-current', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    const s2 = await createWebSession(env, 'raw-sibling-1', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    const s3 = await createWebSession(env, 'raw-sibling-2', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })

    const { revokedCount } = await revokeAllWebSessions(env, TENANT, 'm1', 'human_revoke_all', s1.id_hash)
    expect(revokedCount).toBe(2)

    expect((await loadWebSession(env, TENANT, 'raw-current')).ok).toBe(true)
    expect((await loadWebSession(env, TENANT, 'raw-sibling-1')).ok).toBe(false)
    expect((await loadWebSession(env, TENANT, 'raw-sibling-2')).ok).toBe(false)
    void s2
    void s3
  })

  it('revokeAllWebSessions: full sign-out (no exception) kills the caller\'s own session too', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    await createWebSession(env, 'raw-current', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    const { revokedCount } = await revokeAllWebSessions(env, TENANT, 'm1', 'human_revoke_all')
    expect(revokedCount).toBe(1)
    expect((await loadWebSession(env, TENANT, 'raw-current')).ok).toBe(false)
  })

  it('revokeAllWebSessions never touches a different member\'s sessions', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const id2 = await seedMemberAndIdentity('m2', 'b@x.test')
    await createWebSession(env, 'raw-m1', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    await createWebSession(env, 'raw-m2', { tenant: TENANT, memberId: 'm2', loginIdentityId: id2 })

    await revokeAllWebSessions(env, TENANT, 'm1', 'human_revoke_all')
    expect((await loadWebSession(env, TENANT, 'raw-m1')).ok).toBe(false)
    expect((await loadWebSession(env, TENANT, 'raw-m2')).ok).toBe(true)
  })

  it('revokeWebSessionByHash: no ownership check — used only by logout for the session named by its own cookie', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const created = await createWebSession(env, 'raw-logout', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    const { revoked } = await revokeWebSessionByHash(env, TENANT, created.id_hash, 'logout')
    expect(revoked).toBe(true)
    expect((await loadWebSession(env, TENANT, 'raw-logout')).ok).toBe(false)
  })

  it('recent-reauth: unset by default, true only within the 5-minute window after markRecentReauth', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const created = await createWebSession(env, 'raw-reauth', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    expect(hasRecentReauth(created)).toBe(false)

    const markedAt = Date.parse('2026-09-01T00:00:00.000Z')
    await markRecentReauth(env, created.id_hash, markedAt)
    const row = await env.DB.prepare('SELECT recent_reauth_at FROM web_sessions WHERE id_hash = ?1')
      .bind(created.id_hash)
      .first<{ recent_reauth_at: string }>()
    expect(hasRecentReauth({ recent_reauth_at: row!.recent_reauth_at }, markedAt + RECENT_REAUTH_WINDOW_MS)).toBe(true)
    expect(hasRecentReauth({ recent_reauth_at: row!.recent_reauth_at }, markedAt + RECENT_REAUTH_WINDOW_MS + 1)).toBe(false)
  })

  it('loadLiveReauthIdentity requires BOTH the session and the identity to be live', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test', 'google', 'sub-m1')
    const created = await createWebSession(env, 'raw-reauth-ident', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })

    const live = await loadLiveReauthIdentity(env, TENANT, created.id_hash)
    expect(live).toEqual({ provider: 'google', provider_subject: 'sub-m1' })

    await env.DB.prepare('UPDATE human_login_identities SET revoked_at = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), id1)
      .run()
    // Session row is still live — that is the hole the reauth join had.
    expect((await loadWebSession(env, TENANT, 'raw-reauth-ident')).ok).toBe(true)
    expect(await loadLiveReauthIdentity(env, TENANT, created.id_hash)).toBeNull()
  })

  it('revokeWebSessionsForLoginIdentity kills only sessions bound to that identity', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test', 'google', 'sub-a')
    const now = new Date().toISOString()
    const id2 = 'id-m1-other'
    await env.DB.prepare(
      `INSERT INTO human_login_identities
         (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
       VALUES (?1, ?2, 'google', 'sub-b', 'a@x.test', 'm1', ?3)`,
    )
      .bind(id2, TENANT, now)
      .run()
    await createWebSession(env, 'raw-a', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    await createWebSession(env, 'raw-b', { tenant: TENANT, memberId: 'm1', loginIdentityId: id2 })

    const { revokedCount } = await revokeWebSessionsForLoginIdentity(env, TENANT, 'm1', id1, 'identity_revoked')
    expect(revokedCount).toBe(1)
    expect((await loadWebSession(env, TENANT, 'raw-a')).ok).toBe(false)
    expect((await loadWebSession(env, TENANT, 'raw-b')).ok).toBe(true)
  })

  it('markRecentReauth never resurrects a revoked session', async () => {
    const id1 = await seedMemberAndIdentity('m1', 'a@x.test')
    const created = await createWebSession(env, 'raw-reauth-revoked', { tenant: TENANT, memberId: 'm1', loginIdentityId: id1 })
    await revokeWebSession(env, TENANT, 'm1', created.id_hash, 'human_revoke')
    await markRecentReauth(env, created.id_hash)
    const row = await env.DB.prepare('SELECT recent_reauth_at FROM web_sessions WHERE id_hash = ?1')
      .bind(created.id_hash)
      .first<{ recent_reauth_at: string | null }>()
    expect(row?.recent_reauth_at).toBeNull()
  })
})

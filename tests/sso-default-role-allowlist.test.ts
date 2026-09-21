// mupot#1454 — SSO auto-enrollment default_role validated at BOTH the config
// write and enroll-time read, closing the gap the RBAC map's P0-B found:
//
//   POST /api/auth/sso/config passed req.json() straight into setSsoConfig,
//   which spreads it onto the stored blob with NO runtime check — the
//   SsoConfig TS type said default_role was 'member'|'admin', but a type is
//   compile-time only and req.json() can carry anything, including 'owner'.
//   POST /api/auth/sso/enroll then read `config.default_role || 'member'`
//   and INSERTed it straight into `capabilities`, which permits 'owner'
//   (migrations/0002_members.sql). An org admin could set
//   default_role:'owner', enroll an email they control, and log in at
//   rank 5 — no ceiling, no re-check, on a route the file's own header
//   already named as risky for `default_role:'admin'`.
//
// Fix: default_role is now validated against an explicit allowlist
// (['observer','member'], src/auth/sso.ts's SSO_ALLOWED_DEFAULT_ROLES) at
// BOTH write time (a zod schema in sso-routes.ts, unknown keys rejected too)
// and enroll time (a defensive re-check in autoEnrollSsoMember — a config
// stored before this fix must not mint an elevated capability).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ssoApp } from '../src/auth/sso-routes'
import { autoEnrollSsoMember } from '../src/auth/sso'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'sso-role-tenant'

function ownerSession(): string {
  return JSON.stringify({
    userId: 'u-owner',
    email: 'owner@sso-role-tenant.test',
    role: 'owner',
    createdAt: '2026-09-01T00:00:00.000Z',
  })
}

function jsonReq(body: unknown, cookie: string) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  }
}

describe('SSO default_role allowlist (mupot#1454)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const cookie = 'mupot_session=owner-s'

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
      SESSIONS: {
        get: async (key: string) => (key === 'sess:owner-s' ? ownerSession() : null),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
  })

  afterEach(() => harness.close())

  // ── (a) config write ────────────────────────────────────────────────────

  it("POST /config with default_role:'owner' -> 400 invalid_default_role, config unchanged", async () => {
    const before = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'sso_config'`).first()
    expect(before).toBeNull()

    const res = await ssoApp.request('/config', jsonReq({ default_role: 'owner' }, cookie), env)
    expect(res.status).toBe(400)
    const body = await res.json<{ ok: boolean; error: string }>()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('invalid_default_role')

    const after = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'sso_config'`).first()
    expect(after).toBeNull() // never written
  })

  it("POST /config with default_role:'admin' -> 400 invalid_default_role", async () => {
    const res = await ssoApp.request('/config', jsonReq({ default_role: 'admin' }, cookie), env)
    expect(res.status).toBe(400)
    const body = await res.json<{ ok: boolean; error: string }>()
    expect(body.error).toBe('invalid_default_role')
  })

  it("POST /config with default_role:'observer' -> 200, persisted", async () => {
    const res = await ssoApp.request('/config', jsonReq({ default_role: 'observer', enabled: true }, cookie), env)
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; config: { default_role: string } }>()
    expect(body.ok).toBe(true)
    expect(body.config.default_role).toBe('observer')

    const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'sso_config'`).first<{ value: string }>()
    expect(JSON.parse(row!.value).default_role).toBe('observer')
  })

  it('POST /config rejects unknown keys (schema is strict)', async () => {
    const res = await ssoApp.request('/config', jsonReq({ default_role: 'member', backdoor: true }, cookie), env)
    expect(res.status).toBe(400)
    const body = await res.json<{ ok: boolean; error: string }>()
    expect(body.ok).toBe(false)
    expect(body.error).not.toBe('invalid_default_role') // the bad field, not default_role
    const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'sso_config'`).first()
    expect(row).toBeNull()
  })

  // ── (b) enroll-time re-validation / clamp ──────────────────────────────

  it('a config stored BEFORE this fix with default_role:"admin" is clamped to member at enroll — capability row is member, not admin', async () => {
    // Simulate pre-fix data: written directly (bypassing the now-guarded
    // route), the same way a value from before this fix would already be
    // sitting in org_settings.
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, datetime('now'))`,
    ).bind(JSON.stringify({ enabled: false, allowed_domains: [], default_role: 'admin', enforce_sso: false, idp_provider: 'google' })).run()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await autoEnrollSsoMember(env, { email: 'newhire@sso-role-tenant.test', provider: 'google' })

    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(true)
    expect(result.role).toBe('member') // clamped, never the stored 'admin'

    const grant = await harness.db.prepare(
      `SELECT capability FROM capabilities WHERE member_id = ?1 AND scope_type = 'org' AND scope_id IS NULL`,
    ).bind(result.memberId).first<{ capability: string }>()
    expect(grant?.capability).toBe('member')

    // Audited (no PII/secrets — just proving something was logged).
    // NB: assert BEFORE mockRestore() — mockRestore() also clears call history.
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("a config with the allowlisted default_role:'observer' enrolls at observer, unclamped", async () => {
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, datetime('now'))`,
    ).bind(JSON.stringify({ enabled: false, allowed_domains: [], default_role: 'observer', enforce_sso: false, idp_provider: 'google' })).run()

    const result = await autoEnrollSsoMember(env, { email: 'viewer@sso-role-tenant.test', provider: 'google' })

    expect(result.ok).toBe(true)
    expect(result.role).toBe('observer')
    const grant = await harness.db.prepare(
      `SELECT capability FROM capabilities WHERE member_id = ?1 AND scope_type = 'org' AND scope_id IS NULL`,
    ).bind(result.memberId).first<{ capability: string }>()
    expect(grant?.capability).toBe('observer')
  })

  it('the member.auto_enrolled bus event carries the CLAMPED role, never the stored bad value', async () => {
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, datetime('now'))`,
    ).bind(JSON.stringify({ enabled: false, allowed_domains: [], default_role: 'owner', enforce_sso: false, idp_provider: 'google' })).run()

    const send = (env.BUS as unknown as { send: ReturnType<typeof vi.fn> }).send
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await autoEnrollSsoMember(env, { email: 'x@sso-role-tenant.test', provider: 'google' })
    errorSpy.mockRestore()

    expect(result.ok).toBe(true)
    expect(result.role).toBe('member') // clamped from the stored 'owner'
    expect(send).toHaveBeenCalledTimes(1)
    const published = send.mock.calls[0][0] as { type: string; payload: { role: string } }
    expect(published.type).toBe('member.auto_enrolled')
    expect(published.payload.role).toBe('member') // the emitted event, not the stored 'owner'
  })

  // ── (c) mupot#1454 round 2, F3: GET must not echo unknown keys back ───────
  //
  // POST /config's new `.strict()` schema (F1/F2 above) means a config
  // written before this fix — or carrying any legacy/junk key — would fail
  // an otherwise-honest GET -> edit -> POST round trip on a field the admin
  // never touched. getSsoConfig now whitelists the known SsoConfig shape on
  // read, so GET always returns a clean, strict-schema-compatible object.
  it('a stored config with an extra/unknown key is stripped by GET, and POSTing the returned body succeeds', async () => {
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, datetime('now'))`,
    ).bind(JSON.stringify({
      enabled: true,
      allowed_domains: ['sso-role-tenant.test'],
      default_role: 'member',
      enforce_sso: false,
      idp_provider: 'google',
      legacy_junk_field: 'some pre-fix value nobody reads anymore',
    })).run()

    const getRes = await ssoApp.request('/config', { headers: { cookie } }, env)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json<{ ok: boolean; config: Record<string, unknown> }>()
    expect(getBody.ok).toBe(true)
    expect(getBody.config).not.toHaveProperty('legacy_junk_field')
    expect(getBody.config).toEqual({
      enabled: true,
      allowed_domains: ['sso-role-tenant.test'],
      default_role: 'member',
      enforce_sso: false,
      idp_provider: 'google',
    })

    // The honest round trip: POST exactly what GET returned. Must succeed —
    // the admin never touched (and never even saw) the junk field.
    const postRes = await ssoApp.request('/config', jsonReq(getBody.config, cookie), env)
    expect(postRes.status).toBe(200)
    const postBody = await postRes.json<{ ok: boolean; config: Record<string, unknown> }>()
    expect(postBody.ok).toBe(true)
    expect(postBody.config).not.toHaveProperty('legacy_junk_field')
  })
})

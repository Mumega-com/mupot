// mupot#1457 — login-first redeemer. A person who signed in BEFORE opening
// their invite already owns a members row (members.email is globally UNIQUE),
// so the fresh-mint INSERT hit member_already_exists with no path forward.
//
// The grant may land on the existing row ONLY when the redeemer proves control
// (authenticated session -> member holds a live login identity whose
// IdP-verified email == invite email). Email match alone must never attach.
//
// Schema via createSqliteD1 + applyAllMigrations — real engine, no hand schema.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { AuthContext, Env } from '../src/types'

const session = vi.hoisted(() => ({ auth: null as AuthContext | null }))
vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>()
  return { ...actual, peekSessionAuth: async () => session.auth }
})

import { inviteApp } from '../src/dashboard/invite'
import { acceptInvite } from '../src/members'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function makeHarness(): SqliteD1Harness {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin', 'member-admin', 'department', 'dept-a', 'admin');
    -- login-first person: row + live identity verified for ceo@corp.test
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-ceo', 'ceo@corp.test', 'Cee', 'active', '${TENANT}');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES ('hli-ceo', '${TENANT}', 'google', 'sub-ceo', 'ceo@corp.test', 'member-ceo');
    -- attacker: own member + own identity, different email
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-evil', 'evil@x.test', 'Eve', 'active', '${TENANT}');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES ('hli-evil', '${TENANT}', 'google', 'sub-evil', 'evil@x.test', 'member-evil');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-ceo', 'ceo@corp.test', 'dept-a', 'member', 'member-admin');
  `)
  return h
}

function envFor(h: SqliteD1Harness): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: ORIGIN, BRAND: 'Test Pot',
    SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  } as unknown as Env
}

function authFor(memberId: string, email: string): AuthContext {
  return { userId: `u-${memberId}`, email, role: 'member', tenant: TENANT, memberId, webSessionMemberId: memberId }
}

async function post(h: SqliteD1Harness, id: string) {
  return inviteApp.request(
    `${ORIGIN}/${id}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ display_name: 'Cee' }).toString(),
    },
    envFor(h),
  )
}

// department-scope grants only: provisionHomeForMember legitimately adds the
// member's own home-squad grant on a successful web accept.
function grants(h: SqliteD1Harness, memberId: string) {
  return h.sqlite.prepare(`SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ? AND scope_type = 'department'`).all(memberId) as
    { scope_type: string; scope_id: string | null; capability: string }[]
}
const memberCount = (h: SqliteD1Harness) =>
  (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }).n
const inviteRow = (h: SqliteD1Harness, id: string) =>
  h.sqlite.prepare(`SELECT accepted_at, member_id FROM invites WHERE id = ?`).get(id) as
    { accepted_at: string | null; member_id: string | null }

describe('#1457 login-first invite accept (real route)', () => {
  let h: SqliteD1Harness | undefined
  afterEach(() => { h?.close(); h = undefined; session.auth = null })

  it('REPRO: an anonymous visitor on an email that already has a member is still refused (no grant, invite not spent)', async () => {
    h = makeHarness()
    session.auth = null
    const res = await post(h, 'inv-ceo')
    expect(res.status).toBe(409)
    expect(grants(h, 'member-ceo')).toEqual([])
    expect(inviteRow(h, 'inv-ceo').accepted_at).toBeNull()
    expect(memberCount(h)).toBe(3)
  })

  it('happy path: the signed-in owner of the identity gets the grant on their EXISTING row', async () => {
    h = makeHarness()
    session.auth = authFor('member-ceo', 'ceo@corp.test')
    const res = await post(h, 'inv-ceo')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mupot_pending_invite')
    expect(grants(h, 'member-ceo')).toEqual([{ scope_type: 'department', scope_id: 'dept-a', capability: 'member' }])
    expect(inviteRow(h, 'inv-ceo').member_id).toBe('member-ceo')
    expect(memberCount(h)).toBe(3) // no new row minted
    const tokens = h.sqlite.prepare(`SELECT COUNT(*) AS n FROM member_tokens`).get() as { n: number }
    expect(tokens.n).toBe(0)
  })

  it('SECURITY: a signed-in DIFFERENT identity cannot take the invite for someone else\'s email', async () => {
    h = makeHarness()
    session.auth = authFor('member-evil', 'evil@x.test')
    const res = await post(h, 'inv-ceo')
    expect(res.status).toBe(409)
    expect(grants(h, 'member-evil')).toEqual([])
    expect(grants(h, 'member-ceo')).toEqual([])
    expect(inviteRow(h, 'inv-ceo').accepted_at).toBeNull()
  })

  it('SECURITY: a session claiming the right email but whose member has NO verified identity for it is refused', async () => {
    h = makeHarness()
    // row matched by members.email only — no identity row (the squat shape)
    h.sqlite.exec(`DELETE FROM human_login_identities WHERE id = 'hli-ceo'`)
    session.auth = authFor('member-ceo', 'ceo@corp.test')
    const res = await post(h, 'inv-ceo')
    expect(res.status).toBe(409)
    expect(grants(h, 'member-ceo')).toEqual([])
  })

  it('SECURITY: a revoked identity, suspended member, or other-tenant row does not prove control', async () => {
    for (const mutate of [
      `UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = 'hli-ceo'`,
      `UPDATE members SET status = 'suspended' WHERE id = 'member-ceo'`,
      `UPDATE members SET tenant = 'other-pot' WHERE id = 'member-ceo'`,
      `UPDATE human_login_identities SET verified_email = 'someone-else@corp.test' WHERE id = 'hli-ceo'`,
    ]) {
      h = makeHarness()
      h.sqlite.exec(mutate)
      session.auth = authFor('member-ceo', 'ceo@corp.test')
      const res = await post(h, 'inv-ceo')
      expect(res.status, mutate).toBe(409)
      expect(grants(h, 'member-ceo'), mutate).toEqual([])
      h.close(); h = undefined
    }
  })

  it('refuses when the inviter lost standing since the invite was minted (re-check still applies)', async () => {
    h = makeHarness()
    h.sqlite.exec(`DELETE FROM capabilities WHERE id = 'cap-admin'`)
    session.auth = authFor('member-ceo', 'ceo@corp.test')
    const res = await post(h, 'inv-ceo')
    expect(res.status).toBe(409)
    expect(grants(h, 'member-ceo')).toEqual([])
    expect(inviteRow(h, 'inv-ceo').accepted_at).toBeNull()
  })

  it('idempotent re-accept: the second submit is invite_already_accepted and adds no second grant', async () => {
    h = makeHarness()
    session.auth = authFor('member-ceo', 'ceo@corp.test')
    expect((await post(h, 'inv-ceo')).status).toBe(302)
    expect((await post(h, 'inv-ceo')).status).toBe(409)
    expect(grants(h, 'member-ceo')).toHaveLength(1)
  })

  it('a different invite onto a scope the member already holds never widens or narrows it', async () => {
    h = makeHarness()
    h.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-ceo', 'member-ceo', 'department', 'dept-a', 'observer');
    `)
    const env = envFor(h)
    const r = await acceptInvite(env, 'inv-ceo', 'Cee', { verifiedMemberId: 'member-ceo' })
    expect(r.ok).toBe(true)
    expect(grants(h, 'member-ceo')).toEqual([{ scope_type: 'department', scope_id: 'dept-a', capability: 'observer' }])
  })

  it('fresh email regression: a new person still gets a fresh member (unchanged public path)', async () => {
    h = makeHarness()
    h.sqlite.exec(`INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-new', 'new@corp.test', 'dept-a', 'member', 'member-admin')`)
    const r = await acceptInvite(envFor(h), 'inv-new', 'New')
    expect(r.ok && r.value.linked_existing).toBe(false)
    expect(memberCount(h)).toBe(4)
  })

  it('an agent-bound member row is not eligible even with a proven identity', async () => {
    h = makeHarness()
    h.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status)
        VALUES ('ag-1', 'squad-a', 'bot', 'Bot', 'operator', 'test', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag-1', 'member-ceo', datetime('now'));
    `)
    const r = await acceptInvite(envFor(h), 'inv-ceo', 'Cee', { verifiedMemberId: 'member-ceo' })
    expect(r).toEqual({ ok: false, error: 'member_already_exists' })
    expect(grants(h, 'member-ceo')).toEqual([])
  })
})

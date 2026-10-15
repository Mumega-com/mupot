// tests/owner-own-home-grant.test.ts — 2026-10-15: hadi@mumega.com (org role owner) was refused "Coining a seat key ... requires the admin
// capability on squad 'Home - Hadi'" although his member row HAS an exact squad-scope admin grant on that home squad. Cause: the auth
// bridge leaves auth.capabilities UNDEFINED for a legacy owner/admin login, and the legacy-role plane (correctly) has zero standing on a
// home squad, so canOnSquadAuth never saw his own exact grant. The repair reads ONLY the web-session member's own rows, ONLY for a home
// squad, through canOnSquad (so only an EXACT squad-scope grant counts). The privacy invariant (no standing from org/department/role
// planes) is untouched and pinned below.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { canOnSquadAuth } from '../src/auth/capability'
import { authorizeEnrollMint } from '../src/dashboard/enroll'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-ownerhome'

let harness: SqliteD1Harness
let env: Env
let hadiHome: string
let otherHome: string

const ownerWebAuth = (memberId: string | undefined): AuthContext => ({
  userId: 'owner-1', memberId: undefined, email: 'hadi@mumega.com', role: 'owner', tenant: TENANT, channel: 'dashboard',
  boundAgentId: null, capabilities: undefined, ...(memberId ? { webSessionMemberId: memberId } : {}),
}) as unknown as AuthContext

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  for (const [id, name] of [['mem-hadi', 'Hadi'], ['mem-other', 'Other']]) {
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`).bind(id, TENANT, name).run()
  }
  const a = await createHomeForMember(env, 'mem-hadi')
  const b = await createHomeForMember(env, 'mem-other')
  if (!a.ok || !b.ok) throw new Error('setup failed')
  hadiHome = a.squad.id
  otherHome = b.squad.id
  // org-level capability rows exist for the member too: they must still NOT reach a home squad
  harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-org', 'mem-hadi', 'org', NULL, 'owner')`)
})
afterEach(() => harness.close())

const grantAdmin = (member: string, squad: string): void => {
  harness.sqlite.exec(`INSERT OR REPLACE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-${member}-${squad}', '${member}', 'squad', '${squad}', 'admin')`)
}

describe('a legacy owner login sees the member\'s OWN exact grant on their home squad', () => {
  it('with the exact squad-scope admin row (a home squad is created WITH one for its member): canOnSquadAuth and authorizeEnrollMint pass (the reported case)', async () => {
    expect((harness.sqlite.prepare(`SELECT capability FROM capabilities WHERE member_id = 'mem-hadi' AND scope_type = 'squad' AND scope_id = ?`).get(hadiHome) as { capability: string }).capability).toBe('admin')
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-hadi'), hadiHome, 'admin')).toBe(true)
    expect(await authorizeEnrollMint(env, ownerWebAuth('mem-hadi'), hadiHome)).toEqual({ ok: true })
  })

  it('WITHOUT the exact row the owner still has zero standing on a home squad (org owner row + legacy role do not reach it): the privacy invariant', async () => {
    harness.sqlite.exec(`DELETE FROM capabilities WHERE member_id = 'mem-hadi' AND scope_type = 'squad'`) // createHomeForMember seeds the member's own admin row: remove it
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-hadi'), hadiHome, 'admin')).toBe(false)
    expect(await authorizeEnrollMint(env, ownerWebAuth('mem-hadi'), hadiHome)).toEqual({ ok: false, reason: 'squad_admin_required' })
  })

  it('the grant is per member and per squad: another member\'s home, and a squad the member holds no row on, stay closed', async () => {
    grantAdmin('mem-hadi', hadiHome)
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-hadi'), otherHome, 'admin')).toBe(false)
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-other'), hadiHome, 'admin')).toBe(false) // a session of ANOTHER member cannot borrow it
  })

  it('no web-session member (or a bound agent) gets nothing from this limb; the rank still matters (a member-rank row does not satisfy admin)', async () => {
    grantAdmin('mem-hadi', hadiHome)
    expect(await canOnSquadAuth(env, ownerWebAuth(undefined), hadiHome, 'admin')).toBe(false)
    expect(await canOnSquadAuth(env, { ...ownerWebAuth('mem-hadi'), boundAgentId: 'agent-x' } as AuthContext, hadiHome, 'admin')).toBe(false)
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'c-mem-hadi-${hadiHome}'`)
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-hadi'), hadiHome, 'admin')).toBe(false)
    expect(await canOnSquadAuth(env, ownerWebAuth('mem-hadi'), hadiHome, 'member')).toBe(true)
  })
})

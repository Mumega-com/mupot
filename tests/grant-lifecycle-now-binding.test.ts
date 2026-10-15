// tests/grant-lifecycle-now-binding.test.ts — migration 0228.
//
// (1) The liveness predicate fails CLOSED on a misbound `now`.
// (2) acceptInvite's rank checks honour an EXPIRING inviter grant (live = ok, lapsed = refused),
//     on both the fresh-member and the existing-member INSERT — each takes `now` positionally.
// (3) Elevation-conferred memberships carry the horizon, so project messaging does not outlive it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { CAPABILITY_LIVE_PREDICATE, nowCapabilitySql } from '../src/auth/capability'
import { acceptInvite } from '../src/members'
import { validateMessageProjectAccess } from '../src/agents/messages'
import { setAgentSquadAccess } from '../src/members/agent-access'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const FUTURE = '2099-01-01 00:00:00'
const PAST = '2020-01-01 00:00:00'

describe('CAPABILITY_LIVE_PREDICATE fails closed on a non-date now', () => {
  let h: SqliteD1Harness
  beforeEach(() => { h = createSqliteD1() })
  afterEach(() => h.sqlite.close())

  const live = (expiresAt: string | null, now: string | number | null): boolean => {
    const sql = `SELECT ${CAPABILITY_LIVE_PREDICATE('t', '?2')} AS ok FROM (SELECT ?1 AS expires_at) t`
    return (h.sqlite.prepare(sql).get(expiresAt, now) as { ok: number | null }).ok === 1
  }

  it('a real now: future live, past dead, NULL live', () => {
    const now = nowCapabilitySql()
    expect(live(FUTURE, now)).toBe(true)
    expect(live(PAST, now)).toBe(false)
    expect(live(null, now)).toBe(true)
  })

  it('an INTEGER now (julianday(4) is a valid ancient date) kills an expiring grant, it does not revive it', () => {
    expect(live(PAST, 4)).toBe(false)
    expect(live(FUTURE, 4)).toBe(false)
  })

  it('NULL and garbage now are dead too; a NULL expiry never consults now', () => {
    expect(live(FUTURE, null)).toBe(false)
    expect(live(FUTURE, 'not-a-date')).toBe(false)
    expect(live(null, 4)).toBe(true)
  })
})

describe('acceptInvite rank checks with an EXPIRING inviter grant', () => {
  let h: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-admin', 'admin@pot.test', 'Ada', 'active', '${TENANT}');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-ceo', 'ceo@corp.test', 'Cee', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
        VALUES ('hli-ceo', '${TENANT}', 'google', 'sub-ceo', 'ceo@corp.test', 'member-ceo');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at)
        VALUES ('cap-admin', 'member-admin', 'department', 'dept-a', 'admin', '${FUTURE}');
      INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES
        ('inv-fresh', 'new@corp.test', 'dept-a', 'member', 'member-admin'),
        ('inv-ceo', 'ceo@corp.test', 'dept-a', 'member', 'member-admin');
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot' } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  const deptGrants = (memberEmail: string): number =>
    (h.sqlite
      .prepare(`SELECT COUNT(*) n FROM capabilities c JOIN members m ON m.id = c.member_id
                 WHERE m.email = ? AND c.scope_type = 'department'`)
      .get(memberEmail) as { n: number }).n

  it('FRESH member: a live expiring inviter grant authorises the invite', async () => {
    expect((await acceptInvite(env, 'inv-fresh', 'New')).ok).toBe(true)
    expect(deptGrants('new@corp.test')).toBe(1)
  })

  it('FRESH member: a lapsed inviter grant refuses it, writing nothing', async () => {
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '${PAST}' WHERE id = 'cap-admin'`)
    expect((await acceptInvite(env, 'inv-fresh', 'New')).ok).toBe(false)
    expect(deptGrants('new@corp.test')).toBe(0)
  })

  it('EXISTING member: a live expiring inviter grant authorises the invite', async () => {
    const r = await acceptInvite(env, 'inv-ceo', 'Cee', { verifiedMemberId: 'member-ceo' })
    expect(r.ok).toBe(true)
    expect(deptGrants('ceo@corp.test')).toBe(1)
    const row = h.sqlite
      .prepare("SELECT granted_by, granted_via FROM capabilities WHERE member_id = 'member-ceo' AND scope_type = 'department'")
      .get()
    expect(row).toEqual({ granted_by: 'member-admin', granted_via: 'invite' })
  })

  it('EXISTING member: a lapsed inviter grant refuses it, invite unspent', async () => {
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '${PAST}' WHERE id = 'cap-admin'`)
    const r = await acceptInvite(env, 'inv-ceo', 'Cee', { verifiedMemberId: 'member-ceo' })
    expect(r.ok).toBe(false)
    expect(deptGrants('ceo@corp.test')).toBe(0)
  })
})

describe('elevation-conferred memberships carry the horizon (project messaging)', () => {
  let h: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'd', 'a', 'A'), ('sq-b', 'd', 'b', 'B');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('m-1', 'M1', 'active', '${TENANT}'), ('m-2', 'M2', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
        ('a-1', 'sq-b', 'a1', 'A1', 'member', 't', 'active'), ('a-2', 'sq-b', 'a2', 'A2', 'member', 't', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${TENANT}', 'a-1', 'm-1', datetime('now')), ('${TENANT}', 'a-2', 'm-2', datetime('now'));
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-1', 'a-1', 'sq-b', 'member'), ('ms-2', 'a-2', 'sq-b', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('c-1', 'm-1', 'squad', 'sq-b', 'member'), ('c-2', 'm-2', 'squad', 'sq-b', 'member');
      INSERT INTO projects (id, name, slug, status, created_at, updated_at)
        VALUES ('p-1', 'P', 'p', 'active', datetime('now'), datetime('now'));
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('p-1', 'sq-a', 'write');
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  const grant = async (agentId: string, memberId: string, expiresAt: string | null): Promise<void> => {
    const out = await setAgentSquadAccess(env, {
      agentId, memberId, squadId: 'sq-a', capability: 'member', expiresAt,
      provenance: { grantedBy: null, grantedVia: 'elevation' },
    })
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true })
  }

  it('writes the horizon onto the membership row, not only the capability', async () => {
    await grant('a-1', 'm-1', FUTURE)
    expect(h.sqlite.prepare("SELECT expires_at FROM memberships WHERE agent_id = 'a-1' AND squad_id = 'sq-a'").get())
      .toEqual({ expires_at: FUTURE })
  })

  it('the GUARDED (identity-creating) membership path writes the horizon too', async () => {
    const { prepareAgentSquadAccess } = await import('../src/members/agent-access')
    const prepared = await prepareAgentSquadAccess(
      env,
      { agentId: 'a-1', memberId: 'm-1', squadId: 'sq-a', capability: 'member', expiresAt: FUTURE },
      { agentId: 'a-1', memberId: 'm-1', homeSquadId: 'sq-b', disposition: 'creating' },
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    await env.DB.batch(prepared.value.statements)
    expect(h.sqlite.prepare("SELECT expires_at FROM memberships WHERE agent_id = 'a-1' AND squad_id = 'sq-a'").get())
      .toEqual({ expires_at: FUTURE })
  })

  it('live elevation membership: project messaging is allowed', async () => {
    await grant('a-1', 'm-1', FUTURE)
    await grant('a-2', 'm-2', FUTURE)
    expect(await validateMessageProjectAccess(env, 'p-1', 'a-1', 'a-2')).toBeNull()
  })

  it('LAPSED elevation membership: project messaging is denied before any sweeper', async () => {
    await grant('a-1', 'm-1', FUTURE)
    await grant('a-2', 'm-2', FUTURE)
    h.sqlite.exec(`UPDATE memberships SET expires_at = '${PAST}' WHERE agent_id = 'a-1' AND squad_id = 'sq-a'`)
    expect(await validateMessageProjectAccess(env, 'p-1', 'a-1', 'a-2')).toBe('project_access_denied')
    h.sqlite.exec(`UPDATE memberships SET expires_at = '${PAST}' WHERE agent_id = 'a-2' AND squad_id = 'sq-a'`)
    h.sqlite.exec(`UPDATE memberships SET expires_at = NULL WHERE agent_id = 'a-1' AND squad_id = 'sq-a'`)
    expect(await validateMessageProjectAccess(env, 'p-1', 'a-1', 'a-2')).toBe('project_access_denied')
  })

  it('a permanent membership is unaffected (NULL horizon stays live)', async () => {
    await grant('a-1', 'm-1', null)
    await grant('a-2', 'm-2', null)
    expect(await validateMessageProjectAccess(env, 'p-1', 'a-1', 'a-2')).toBeNull()
  })
})

describe('frozen or stale clocks fail closed', () => {
  it('a now earlier than the clock floor kills an expiring grant (a test clock frozen in 1900 cannot revive it)', () => {
    const h = createSqliteD1()
    const probe = (now: string): number | null =>
      (h.sqlite.prepare(`SELECT ${CAPABILITY_LIVE_PREDICATE('t', '?2')} AS ok FROM (SELECT ?1 AS expires_at) t`).get(FUTURE, now) as { ok: number | null }).ok
    expect(probe('1900-01-01 00:00:00')).toBe(0)
    expect(probe('2025-12-31 23:59:59')).toBe(0)
    expect(probe(nowCapabilitySql())).toBe(1)
    h.sqlite.close()
  })
})

describe('a LAPSED row never swallows a re-grant (seed)', () => {
  it('squad-seed replaces a lapsed seed row but never overwrites a live one', async () => {
    const { seedSquadMembers, deterministicMemberId } = await import('../src/members/squad-seed')
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-seed', 'd', 's', 'S');
    `)
    const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
    expect((await seedSquadMembers(env, 'sq-seed')).ok).toBe(true)
    const before = h.sqlite.prepare("SELECT COUNT(*) n FROM capabilities WHERE granted_via = 'squad_seed'").get() as { n: number }
    expect(before.n).toBeGreaterThan(0)
    // a LIVE expiring row is left alone on re-seed
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '2099-01-01 00:00:00', capability = 'observer' WHERE granted_via = 'squad_seed'`)
    await seedSquadMembers(env, 'sq-seed')
    expect(h.sqlite.prepare("SELECT DISTINCT capability, expires_at FROM capabilities WHERE granted_via = 'squad_seed' AND capability = 'observer'").all())
      .toEqual([{ capability: 'observer', expires_at: '2099-01-01 00:00:00' }])
    // a LAPSED one is replaced by the seed definition and is permanent again
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '2020-01-01 00:00:00' WHERE granted_via = 'squad_seed'`)
    const again = await seedSquadMembers(env, 'sq-seed')
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true })
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM capabilities WHERE granted_via = 'squad_seed' AND expires_at IS NOT NULL").get()).toEqual({ n: 0 })
    expect(typeof deterministicMemberId).toBe('function')
    h.sqlite.close()
  })
})

describe('squad move records WHO revoked the source grant and attributes the destination grant', () => {
  it('revoke context brackets the source DELETE (set before, clear after)', async () => {
    const { moveAgentSquad } = await import('../src/org/service')
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'd', 'a', 'A'), ('sq-b', 'd', 'b', 'B');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('m-1', 'M1', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('a-1', 'sq-a', 'a1', 'A1', 'member', 't', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'a-1', 'm-1', datetime('now'));
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-1', 'a-1', 'sq-a', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-1', 'm-1', 'squad', 'sq-a', 'member');
    `)
    const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
    const out = await moveAgentSquad(env, {
      agentId: 'a-1', fromSquadId: 'sq-a', toSquadId: 'sq-b', memberId: 'm-1', capability: 'member',
      actor: { id: 'mover-1', type: 'user' }, reason: 'reorg',
    })
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true })
    const rev = h.sqlite.prepare("SELECT actor, reason FROM grant_events WHERE event = 'revoked'").all()
    expect(rev).toEqual([{ actor: 'mover-1', reason: 'reorg' }])
    const dest = h.sqlite.prepare("SELECT granted_by, granted_via FROM capabilities WHERE scope_id = 'sq-b'").get()
    expect(dest).toEqual({ granted_by: 'mover-1', granted_via: 'squad_move' })
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM grant_event_context').get()).toEqual({ n: 0 })
    h.sqlite.close()
  })
})

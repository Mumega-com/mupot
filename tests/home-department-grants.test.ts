// mupot#1646 — capability-grant WRITERS must refuse a home department.
//
// Defect class: every READER assumes nobody can hold a department-scope grant on a
// member's home department (planeCoversScope: org/department/role authority never covers
// a home squad), but the plain-department invite door wrote exactly that grant.
// parseInvite only checked the department existed; acceptInvite refused home targets for
// SQUAD scope only. Fix: refuse at invite creation, at redemption (pre-authorization
// ages), and exclude kind='home' squads from the department expansion in
// resolveReadableSquadIds (defence in depth).
//
// Real migration chain via createSqliteD1 + applyAllMigrations; every Env.DB is wrapped in
// strictBindingEnv (the shared double silently drops surplus binds, mupot#1642).

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acceptInvite, membersApp } from '../src/members'
import { createHomeForMember } from '../src/org/service'
import { openDoor, selfGrant } from '../src/onboarding/doors'
import {
  resolveAccessibleSquadIds,
  resolveGrantedSquadIds,
  resolveReadableSquadIds,
} from '../src/projects/readable-squads'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

// Same wrapper as tests/task-dispatch-runtime-receipts.test.ts (D1 rejects a bind count
// that differs from the highest ?N; node:sqlite silently drops surplus values).
function strictBindingEnv(env: Env, violations: string[]): Env {
  const realDb = env.DB
  const check = (sql: string, values: unknown[]): void => {
    const indexes = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]))
    const count = indexes.length === 0 ? 0 : Math.max(...indexes)
    // Bare `?` placeholders are positional; count them when no ?N is present.
    const bare = indexes.length === 0 ? (sql.match(/\?/g) ?? []).length : count
    if (values.length !== bare) {
      violations.push(`bound ${values.length} values, SQL declares ${bare}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  const db = {
    prepare(sql: string) {
      const stmt = realDb.prepare(sql)
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === 'bind') {
            return (...values: unknown[]) => { check(sql, values); return target.bind(...values) }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
  } as unknown as D1Database
  return { ...env, DB: db } as Env
}

describe('mupot#1646 — home department grants', () => {
  let harness: SqliteD1Harness
  let violations: string[]
  let homeDeptId: string
  let homeSquadId: string

  function baseEnv(): Env {
    const session = JSON.stringify({
      userId: 'user-member-admin',
      email: 'admin@pot.test',
      role: 'member',
      createdAt: new Date().toISOString(),
    })
    const raw = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      BRAND: 'Test Pot',
      PUBLIC_ORIGIN: ORIGIN,
      SESSIONS: {
        get: async (key: string) => (key === 'sess:member-admin' ? session : null),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
    return strictBindingEnv(raw, violations)
  }

  function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return membersApp.request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'mupot_session=member-admin',
          Origin: ORIGIN,
        },
        body: JSON.stringify(body),
      },
      baseEnv(),
    )
  }

  function inviteCount(): number {
    return (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }).n
  }
  function capsOn(memberId: string, scopeType: string): number {
    return (harness.sqlite
      .prepare('SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ? AND scope_type = ?')
      .get(memberId, scopeType) as { n: number }).n
  }

  beforeEach(async () => {
    violations = []
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-work', 'dept-work', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-work', 'dept-work', 'squad-work', 'Work Squad');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES
        ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}'),
        ('member-victim', 'victim@pot.test', 'Victim', 'active', '${TENANT}'),
        ('member-other', 'other@pot.test', 'Other', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-admin', 'member-admin', 'org', NULL, 'admin');
    `)
    const home = await createHomeForMember(baseEnv(), 'member-victim')
    if (!home.ok) throw new Error('home setup failed')
    homeSquadId = home.squad.id
    homeDeptId = home.squad.department_id
  })

  afterEach(() => {
    expect(violations).toEqual([])
    harness.close()
  })

  describe('(a) the exact exploit — invite onto a home department', () => {
    it('POST /invites with the home department_id is refused at creation (403, no row)', async () => {
      const res = await post('/invites', { email: 'attacker@example.com', department_id: homeDeptId, capability: 'member' })
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toMatchObject({ error: 'home_scope_not_invitable' })
      expect(inviteCount()).toBe(0)
    })

    it('a work department invite still works (201)', async () => {
      const res = await post('/invites', { email: 'ok@example.com', department_id: 'dept-work', capability: 'member' })
      expect(res.status).toBe(201)
    })

    it('a pre-existing invite onto a home department is refused at redemption, nothing minted, invite unspent', async () => {
      harness.sqlite
        .prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES ('inv-home', 'attacker@example.com', ?, 'member', 'member-admin')`)
        .run(homeDeptId)
      const result = await acceptInvite(baseEnv(), 'inv-home', 'Attacker')
      expect(result).toEqual({ ok: false, error: 'home_scope_not_invitable' })
      const row = harness.sqlite.prepare(`SELECT accepted_at, member_id FROM invites WHERE id='inv-home'`).get() as { accepted_at: string | null; member_id: string | null }
      expect(row.accepted_at).toBeNull()
      expect(row.member_id).toBeNull()
      expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE email='attacker@example.com'`).get() as { n: number }).n).toBe(0)
      expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE scope_id = ?`).get(homeDeptId) as { n: number }).n).toBe(0)
    })

    it('redemption of a work-department invite still mints the department grant', async () => {
      harness.sqlite
        .prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES ('inv-work', 'new@example.com', 'dept-work', 'member', 'member-admin')`)
        .run()
      const result = await acceptInvite(baseEnv(), 'inv-work', 'New')
      expect(result.ok).toBe(true)
    })

    it('redemption through the real mounted route is refused too', async () => {
      harness.sqlite
        .prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES ('inv-home-http', 'attacker@example.com', ?, 'member', 'member-admin')`)
        .run(homeDeptId)
      const res = await membersApp.request(
        '/invites/inv-home-http/accept',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'A' }) },
        baseEnv(),
      )
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE scope_id = ?`).get(homeDeptId) as { n: number }).n).toBe(0)
    })
  })

  describe('(b) every other department-grant writer refuses a home department', () => {
    it('POST /members/:id/capabilities (department scope) → home_scope_not_grantable', async () => {
      const res = await post('/members/member-other/capabilities', { scope_type: 'department', scope_id: homeDeptId, capability: 'member' })
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toMatchObject({ error: 'home_scope_not_grantable' })
      expect(capsOn('member-other', 'department')).toBe(0)
    })

    it('onboarding door selfGrant (department scope) → home_scope_not_grantable', async () => {
      const door = await openDoor(baseEnv(), 'member-admin', { allowedScopes: ['squad', 'department'], maxCapability: 'member' })
      expect(door.ok).toBe(true)
      const result = await selfGrant(baseEnv(), {
        actorMemberId: 'member-other', subjectMemberId: 'member-other',
        scopeType: 'department', scopeId: homeDeptId, capability: 'member',
      })
      expect(result).toEqual({ ok: false, error: 'home_scope_not_grantable' })
      expect(capsOn('member-other', 'department')).toBe(0)
    })

    it('redemption write is guarded in SQL too: with the JS pre-check blinded, the batch still lands no grant', async () => {
      harness.sqlite
        .prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES ('inv-blind', 'attacker@example.com', ?, 'member', 'member-admin')`)
        .run(homeDeptId)
      const real = baseEnv()
      const blind = {
        ...real,
        DB: {
          prepare(sql: string) {
            if (/SELECT kind FROM departments WHERE id = \?/.test(sql)) {
              return { bind: () => ({ first: async () => ({ kind: 'work' }) }) }
            }
            return real.DB.prepare(sql)
          },
          batch: (stmts: D1PreparedStatement[]) => real.DB.batch(stmts),
        },
      } as unknown as Env
      await acceptInvite(blind, 'inv-blind', 'Attacker').catch(() => undefined)
      expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE scope_id = ?`).get(homeDeptId) as { n: number }).n).toBe(0)
      expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE email='attacker@example.com'`).get() as { n: number }).n).toBe(0)
    })
  })

  describe('(c) resolver — home squads are excluded from department/org expansion', () => {
    const deptGrant = (deptId: string): CapabilityGrant => ({
      member_id: 'member-other', scope_type: 'department', scope_id: deptId, capability: 'member',
    })

    beforeEach(() => {
      // A home squad that sits inside a WORK department (inconsistent data an older
      // writer could have produced) — dept expansion on dept-work must not return it.
      harness.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home-in-work', 'dept-work', 'home-in-work', 'Home in work', 'home');
      `)
    })

    it('department grant on a WORK department returns the work squad but not a home squad inside it', async () => {
      const ids = await resolveGrantedSquadIds(baseEnv(), [deptGrant('dept-work')], 'observer')
      expect(ids).toContain('squad-work')
      expect(ids).not.toContain('squad-home-in-work')
    })

    it('a (poisoned) department grant on a home department yields no home squad', async () => {
      const ids = await resolveGrantedSquadIds(baseEnv(), [deptGrant(homeDeptId)], 'observer')
      expect(ids).not.toContain(homeSquadId)
    })

    it('resolveReadableSquadIds: department list excludes home; exact squad id still includes it', async () => {
      expect(await resolveReadableSquadIds(baseEnv(), [], [homeDeptId, 'dept-work'])).not.toContain(homeSquadId)
      expect(await resolveReadableSquadIds(baseEnv(), [homeSquadId], [])).toContain(homeSquadId)
    })

    it('home owner with the exact squad grant still resolves their own home squad', async () => {
      const grants: CapabilityGrant[] = [{ member_id: 'member-victim', scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' }]
      expect(await resolveGrantedSquadIds(baseEnv(), grants, 'observer')).toEqual([homeSquadId])
      const auth: AuthContext = {
        userId: 'u', memberId: 'member-victim', email: 'victim@pot.test', role: 'member', tenant: TENANT,
        channel: 'workspace', boundAgentId: null, capabilities: grants,
      }
      expect(await resolveAccessibleSquadIds(baseEnv(), auth)).toEqual([homeSquadId])
    })

    it('org-wide caller does not get home squads', async () => {
      const grants: CapabilityGrant[] = [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }]
      const ids = await resolveGrantedSquadIds(baseEnv(), grants, 'observer')
      expect(ids).toContain('squad-work')
      expect(ids).not.toContain(homeSquadId)
      expect(ids).not.toContain('squad-home-in-work')
    })

    it('a caller with exact grants on a home AND a dept grant gets the home only via the exact grant', async () => {
      const grants: CapabilityGrant[] = [
        { member_id: 'member-victim', scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' },
        deptGrant('dept-work'),
      ]
      const ids = await resolveGrantedSquadIds(baseEnv(), grants, 'observer')
      expect(ids).toContain(homeSquadId)
      expect(ids).toContain('squad-work')
      expect(ids).not.toContain('squad-home-in-work')
    })
  })

  describe('(d) home owner normal flows unaffected', () => {
    it('createHomeForMember still writes the owner exact squad admin grant and no department grant', () => {
      const exact = harness.sqlite
        .prepare(`SELECT capability FROM capabilities WHERE member_id='member-victim' AND scope_type='squad' AND scope_id = ?`)
        .get(homeSquadId) as { capability: string } | undefined
      expect(exact?.capability).toBe('admin')
      expect(capsOn('member-victim', 'department')).toBe(0)
    })

    it('home owner inviting onto their own home squad is still refused (existing squad fence unchanged)', async () => {
      const res = await post('/invites', { email: 'x@example.com', squad_id: homeSquadId, capability: 'member' })
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toMatchObject({ error: 'home_scope_not_invitable' })
    })
  })

  describe('detection SQL (scripts/detect-home-department-grants.sql)', () => {
    it('runs on the real schema, finds a poisoned grant and a stale invite, finds nothing on clean data', () => {
      const statements = readFileSync('scripts/detect-home-department-grants.sql', 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
        .split(';').map((x) => x.trim()).filter(Boolean)
      const run = (): number[] => statements.map((q) => harness.sqlite.prepare(q).all().length)
      expect(run()).toEqual([0, 0, 0, 0, 0])
      harness.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('bad', 'member-other', 'department', ?, 'member')`).run(homeDeptId)
      harness.sqlite.prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by) VALUES ('stale', 's@example.com', ?, 'member', 'member-admin')`).run(homeDeptId)
      expect(run()).toEqual([1, 0, 0, 1, 0])
    })
  })
})

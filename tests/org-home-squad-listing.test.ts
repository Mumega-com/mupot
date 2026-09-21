// tests/org-home-squad-listing.test.ts — mupot#1452 P1-6 (Athena's ruling,
// Round 2): a kind='home' department/squad (a member's private room) must
// never appear in a work-tree enumeration, GET /api/org/tree and GET
// /departments named explicitly. Both routes previously pulled every row with
// NO kind filter at all (no per-row authz beyond tenant scope either), so a
// home squad's name/slug — and its position in the tree — leaked to any
// authenticated tenant member. Drives the REAL HTTP surface (orgApp.fetch),
// same harness pattern as tests/org-kind-boundary.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { orgApp } = await import('../src/org')
const { createHomeForMember } = await import('../src/org/service')

const TENANT = 'tenant-home-listing'

function getReq(path: string): Request {
  return new Request(`https://pot.example${path}`)
}

describe('mupot#1452 P1-6: GET /departments and GET /tree exclude kind=\'home\'', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    authState.current = { userId: 'owner-1', email: 'owner@example.test', role: 'owner', tenant: TENANT }
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  async function seedMemberAndHome(memberId: string, name: string) {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`,
    )
      .bind(memberId, TENANT, name)
      .run()
    const home = await createHomeForMember(env, memberId, {
      userId: memberId,
      memberId,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    })
    if (!home.ok) throw new Error(`setup failed: ${JSON.stringify(home)}`)
    return home
  }

  it('GET /departments: an org owner sees ordinary work departments but never a member\'s home department', async () => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('dept-work', 'work', 'Work Dept', 'work')`)
    const home = await seedMemberAndHome('member-shadi', 'Shadi')

    const res = await orgApp.fetch(getReq('/departments'), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { departments: Array<{ id: string; slug: string }> }
    const ids = body.departments.map((d) => d.id)
    expect(ids).toContain('dept-work')
    expect(ids).not.toContain(home.squad.department_id)
  })

  it('GET /tree: a member\'s home department and squad are absent from the tree, even for the org owner', async () => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('dept-work', 'work', 'Work Dept', 'work')`)
    harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-work', 'dept-work', 'work', 'Work Squad', 'work')`)
    const home = await seedMemberAndHome('member-shadi', 'Shadi')

    const res = await orgApp.fetch(getReq('/tree'), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      departments: Array<{ id: string; squads: Array<{ id: string }> }>
    }
    const deptIds = body.departments.map((d) => d.id)
    expect(deptIds).toContain('dept-work')
    expect(deptIds).not.toContain(home.squad.department_id)

    const allSquadIds = body.departments.flatMap((d) => d.squads.map((s) => s.id))
    expect(allSquadIds).toContain('squad-work')
    expect(allSquadIds).not.toContain(home.squad.id)
  })

  it('GET /departments/:id/squads: a home squad is excluded even when queried under its own department id', async () => {
    const home = await seedMemberAndHome('member-shadi', 'Shadi')

    const res = await orgApp.fetch(getReq(`/departments/${home.squad.department_id}/squads`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { squads: Array<{ id: string }> }
    expect(body.squads.map((s) => s.id)).not.toContain(home.squad.id)
  })

  // MUTATION-CHECK, documented per this repo's convention: temporarily
  // dropping `WHERE kind != 'home'` (or `AND kind != 'home'`) from any of the
  // three queries above reintroduces the leak this file exists to catch, and
  // was verified red/green during the build (see the round's report).
})

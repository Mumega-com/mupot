// tests/org-home-squad-http-routes.test.ts — mupot#1452 P0-1 Round 2, Athena
// condition (b): the HTTP-route call sites of the collapsed `canOnSquad`
// wrapper in src/org/index.ts and the two wrappers (`canOnSquad`,
// `canOnSquadRead`) in src/dashboard/index.ts, proven through the REAL
// routes (orgApp.fetch / dashboardApp.fetch), not just at the shared
// primitive. Same auth-mock harness as tests/org-kind-boundary.test.ts and
// tests/org-home-squad-listing.test.ts.

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
const { dashboardApp } = await import('../src/dashboard')
const { createHomeForMember, createDepartment, createSquad } = await import('../src/org/service')

const TENANT = 'tenant-home-http'

function orgAdminGrantAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

describe('mupot#1452 P0-1 call-site coverage (Athena condition b): org/index.ts + dashboard/index.ts HTTP routes', () => {
  let harness: SqliteD1Harness
  let env: Env
  let homeSquadId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-shadi', ?1, NULL, 'Shadi', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-admin', ?1, NULL, 'Admin', 'active', datetime('now'))`).bind(TENANT).run()

    const home = await createHomeForMember(env, 'member-shadi', {
      userId: 'member-shadi',
      memberId: 'member-shadi',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    })
    if (!home.ok) throw new Error(`setup failed: ${JSON.stringify(home)}`)
    homeSquadId = home.squad.id

    authState.current = orgAdminGrantAuth('member-admin')
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  // ── site: src/org/index.ts's `canOnSquad` (= canOnSquadAuth), POST /squads/:id/agents ──
  it('org/index.ts POST /squads/:id/agents: an org-scope admin grant is refused creating an agent on a home squad', async () => {
    const res = await orgApp.fetch(
      new Request(`https://pot.example/squads/${homeSquadId}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'intruder', name: 'Intruder' }),
      }),
      env,
    )
    expect(res.status).toBe(403)
    const agentCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?1`).bind(homeSquadId).first<{ n: number }>()
    expect(agentCount?.n ?? 0).toBe(0)
  })

  // ── site: src/dashboard/index.ts's `canOnSquad` (lead), POST /squads/:id/agents ──
  it('dashboard/index.ts POST /squads/:id/agents: an org-scope admin grant is refused creating an agent on a home squad', async () => {
    const res = await dashboardApp.fetch(
      new Request(`https://pot.example/squads/${homeSquadId}/agents`, {
        method: 'POST',
        // form-urlencoded is one of the CORS-simple content types hono's
        // csrf() middleware gates by Origin — a same-origin Origin header is
        // required here so the request reaches the route's own canOnSquad
        // check at all, rather than being refused earlier by CSRF (which
        // would make this test pass for the wrong reason regardless of the
        // home-squad fix).
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.example' },
        body: new URLSearchParams({ slug: 'intruder', name: 'Intruder', role: 'member', model: 'test' }).toString(),
      }),
      env,
    )
    expect(res.status).toBe(403)
    const agentCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?1`).bind(homeSquadId).first<{ n: number }>()
    expect(agentCount?.n ?? 0).toBe(0)
  })

  // ── site: src/dashboard/index.ts's `canOnSquadRead` (observer), GET /squads/:id ──
  it('dashboard/index.ts GET /squads/:id: an org-scope admin grant is refused reading a home squad\'s board', async () => {
    const res = await dashboardApp.fetch(new Request(`https://pot.example/squads/${homeSquadId}`), env)
    expect(res.status).toBe(403)
  })

  // Sanity: the SAME org-admin grant reads and writes an ORDINARY work squad
  // fine — proves the 403s above are real home-squad isolation, not a broken
  // route or an over-tightened gate.
  it('sanity: the same org-scope admin grant DOES read and write an ordinary work squad', async () => {
    const dept = await createDepartment(env, { slug: 'dept-work', name: 'Work Dept' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-work', name: 'Work Squad' })
    if (!squad.ok) throw new Error('setup failed')

    const readRes = await dashboardApp.fetch(new Request(`https://pot.example/squads/${squad.value.id}`), env)
    expect(readRes.status).toBe(200)

    const writeRes = await orgApp.fetch(
      new Request(`https://pot.example/squads/${squad.value.id}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ok-agent', name: 'OK Agent' }),
      }),
      env,
    )
    expect(writeRes.status).toBe(201)
  })
})

// tests/org-kind-boundary.test.ts — BLOCK-1 (P0, mupot#925 P0-928, third
// adversarial pass): the authenticated REST org routes must never be able to
// skip the plan-entitlement gate by putting `kind:"home"` in the JSON body.
//
// THE DEFECT: src/org/index.ts casts an unvalidated request body straight
// into DepartmentInput/SquadInput/AgentInput (`body = (await c.req.json())
// as CreateXBody` — a CAST, not a parse; TypeScript's excess-property check
// does not apply to a variable). Before the fix, `kind` lived on those Input
// interfaces, so any org:admin/department:admin/squad:lead caller could POST
// {"slug":"x","name":"x","kind":"home"} and skip checkCreateLimit entirely —
// on ANY tier, not just free — and the planted row would be invisible (the
// GET routes never select `kind`).
//
// THE FIX (src/org/service.ts): kind no longer lives on any Input interface.
// createDepartment/createSquad/createAgent take it as a separate `opts`
// parameter that only src/members/bootstrap-self.ts ever supplies. A route
// handler that hands a request body straight to `input` has no way to reach
// `opts` — this file proves that holds through the REAL HTTP surface
// (orgApp.fetch), not just at the service-function level (see
// tests/org-create-limits.test.ts and tests/org-kind-exemption.test.ts for
// the service-level pins).
//
// MUTATION-CHECK (per the build brief): temporarily changing src/org/index.ts
// to forward the body's kind into opts — e.g.
// `createDepartment(c.env, body, { kind: body.kind as OrgKind })` on all
// three routes — reintroduces exactly the P0-928 bypass and makes every test
// below fail (each POST that should be blocked instead returns 201). See the
// build report for the literal red output.

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

const TENANT = 'tenant-boundary'

function postJson(path: string, body: unknown): Request {
  return new Request(`https://pot.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('BLOCK-1: POST /departments, POST /departments/:id/squads, POST /squads/:id/agents never honor a "kind" key in the body', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    // org:admin via the legacy-role escape (isOrgAdmin) — satisfies every
    // route's authz check (department admin / squad lead both inherit from
    // org admin), so these tests isolate the entitlement gate, not authz.
    authState.current = { userId: 'owner-1', email: 'owner@example.test', role: 'owner', tenant: TENANT }
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('POST /departments: a body with kind:"home" at the free department ceiling (1) is still blocked', async () => {
    // Consume the free ceiling with an ordinary work department first.
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('d-existing', 'existing', 'Existing', 'work')`)

    const res = await orgApp.fetch(postJson('/departments', { slug: 'evil-dept', name: 'Evil', kind: 'home' }), env)
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'department_limit_reached' })

    // Nothing was planted — kind:"home" bought nothing, visible or not.
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM departments').get()).toEqual({ n: 1 })
  })

  it('POST /departments: UNDER the ceiling, kind:"home" in the body still creates an ordinary kind="work" row', async () => {
    const res = await orgApp.fetch(postJson('/departments', { slug: 'evil-dept', name: 'Evil', kind: 'home' }), env)
    expect(res.status).toBe(201)
    const body = await res.json() as { department: { id: string } }

    const row = harness.sqlite.prepare('SELECT kind FROM departments WHERE id = ?').get(body.department.id)
    expect(row).toEqual({ kind: 'work' })
  })

  it('POST /departments/:id/squads: a body with kind:"home" at the free squad ceiling (1) is still blocked', async () => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1')`)
    harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('s-existing', 'd1', 'existing', 'Existing', 'work')`)

    const res = await orgApp.fetch(postJson('/departments/d1/squads', { slug: 'evil-squad', name: 'Evil', kind: 'home' }), env)
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'squad_limit_reached' })

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM squads WHERE department_id = ?').get('d1')).toEqual({ n: 1 })
  })

  it('POST /squads/:id/agents: a body with kind:"home" at the free agent ceiling (2) is still blocked', async () => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1')`)
    harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S1')`)
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, kind) VALUES ('a-1', 's1', 'a-1', 'A1', 'work');
      INSERT INTO agents (id, squad_id, slug, name, kind) VALUES ('a-2', 's1', 'a-2', 'A2', 'work');
    `)

    const res = await orgApp.fetch(postJson('/squads/s1/agents', { slug: 'evil-agent', name: 'Evil', kind: 'home' }), env)
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'agent_limit_reached' })

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?').get('s1')).toEqual({ n: 2 })
  })

  it('the planted-row-would-be-invisible aggravation: even if the gate WERE skipped, GET /departments never selects kind — pinned so a future column addition does not quietly reopen the visibility gap', async () => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('d-home', 'home-ish', 'Home-ish', 'home')`)
    const res = await orgApp.fetch(new Request('https://pot.example/departments'), env)
    expect(res.status).toBe(200)
    const body = await res.json() as { departments: Record<string, unknown>[] }
    expect(body.departments[0]).not.toHaveProperty('kind')
  })
})

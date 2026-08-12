// tests/org-create-limits.test.ts — S6: plan entitlement enforcement on create.
//
// The tier's PLAN_LIMITS (maxAgents / maxSquads) BITE at the service-layer create
// chokepoint (src/org/service.ts), fail-closed to 'free' when the pot is unconfigured.
// Existing overage is grandfathered (the gate only blocks the NEXT create).

import { describe, it, expect } from 'vitest'
import { createAgent, createSquad, createDepartment } from '../src/org/service'
import { checkCreateLimit } from '../src/billing/entitlement'
import type { Env } from '../src/types'

// A sql-keyed mock: org_settings → billing_state (tier or null), COUNT(*) → configured
// counts, INSERT → ok. tier=null models an UNCONFIGURED pot (resolves to 'free').
function makeEnv(opts: { tier?: string | null; agents?: number; squads?: number; departments?: number }): Env {
  return {
    TENANT_SLUG: 'test',
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind() {
            return stmt
          },
          async first() {
            if (sql.includes('org_settings')) {
              return opts.tier == null ? null : { value: JSON.stringify({ tier: opts.tier }) }
            }
            if (sql.includes('FROM agents')) return { n: opts.agents ?? 0 }
            if (sql.includes('FROM squads')) return { n: opts.squads ?? 0 }
            if (sql.includes('FROM departments')) return { n: opts.departments ?? 0 }
            return null
          },
          async run() {
            return { meta: { changes: 1 } }
          },
          async all() {
            return { results: [] }
          },
        }
        return stmt
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        const out = []
        for (const s of statements) out.push(await s.run())
        return out
      },
    },
  } as unknown as Env
}

const AGENT = { slug: 'bot', name: 'Bot' }
const SQUAD = { slug: 'sq', name: 'Squad' }
const DEPARTMENT = { slug: 'dept', name: 'Dept' }

describe('checkCreateLimit (the pure-ish gate)', () => {
  it('free: blocks the 3rd agent (ceiling 2), allows the 2nd', async () => {
    const env = makeEnv({ tier: 'free' })
    const at2 = await checkCreateLimit(env, 'maxAgents', 2)
    expect(at2.ok).toBe(false)
    if (!at2.ok) expect(at2).toMatchObject({ tier: 'free', ceiling: 2, current: 2 })
    expect((await checkCreateLimit(env, 'maxAgents', 1)).ok).toBe(true)
  })

  it('scale: unlimited (-1 ceiling) always allows', async () => {
    const env = makeEnv({ tier: 'scale' })
    expect((await checkCreateLimit(env, 'maxAgents', 10_000)).ok).toBe(true)
  })

  it('unconfigured pot fails closed to free', async () => {
    const env = makeEnv({ tier: null })
    expect((await checkCreateLimit(env, 'maxSquads', 1)).ok).toBe(false) // free maxSquads = 1
  })
})

describe('createAgent — maxAgents enforcement', () => {
  it('blocks at the free ceiling (2 existing → agent_limit_reached)', async () => {
    const res = await createAgent(makeEnv({ tier: 'free', agents: 2 }), 'squad-1', AGENT)
    expect(res).toEqual({ ok: false, error: 'agent_limit_reached' })
  })

  it('allows under the ceiling (1 existing → the 2nd is created)', async () => {
    const res = await createAgent(makeEnv({ tier: 'free', agents: 1 }), 'squad-1', AGENT)
    expect(res.ok).toBe(true)
  })

  it('starter raises the ceiling to 8 (7 existing allowed, 8 blocked)', async () => {
    expect((await createAgent(makeEnv({ tier: 'starter', agents: 7 }), 's', AGENT)).ok).toBe(true)
    expect(await createAgent(makeEnv({ tier: 'starter', agents: 8 }), 's', AGENT)).toEqual({
      ok: false,
      error: 'agent_limit_reached',
    })
  })

  it('scale is unlimited (100 existing still allowed)', async () => {
    expect((await createAgent(makeEnv({ tier: 'scale', agents: 100 }), 's', AGENT)).ok).toBe(true)
  })

  it('unconfigured pot fails closed to free (2 existing → blocked)', async () => {
    const res = await createAgent(makeEnv({ tier: null, agents: 2 }), 's', AGENT)
    expect(res).toEqual({ ok: false, error: 'agent_limit_reached' })
  })
})

describe('createSquad — maxSquads enforcement', () => {
  it('blocks at the free ceiling (1 existing → squad_limit_reached)', async () => {
    const res = await createSquad(makeEnv({ tier: 'free', squads: 1 }), 'dept-1', SQUAD)
    expect(res).toEqual({ ok: false, error: 'squad_limit_reached' })
  })

  it('allows the first squad on free (0 existing)', async () => {
    const res = await createSquad(makeEnv({ tier: 'free', squads: 0 }), 'dept-1', SQUAD)
    expect(res.ok).toBe(true)
  })

  it('pro raises the ceiling to 10 (9 allowed, 10 blocked)', async () => {
    expect((await createSquad(makeEnv({ tier: 'pro', squads: 9 }), 'd', SQUAD)).ok).toBe(true)
    expect(await createSquad(makeEnv({ tier: 'pro', squads: 10 }), 'd', SQUAD)).toEqual({
      ok: false,
      error: 'squad_limit_reached',
    })
  })
})

describe('createDepartment — maxDepartments enforcement (mupot#925 P0-N1)', () => {
  it('blocks at the free ceiling (1 existing → department_limit_reached)', async () => {
    const res = await createDepartment(makeEnv({ tier: 'free', departments: 1 }), DEPARTMENT)
    expect(res).toEqual({ ok: false, error: 'department_limit_reached' })
  })

  it('allows the first department on free (0 existing)', async () => {
    const res = await createDepartment(makeEnv({ tier: 'free', departments: 0 }), DEPARTMENT)
    expect(res.ok).toBe(true)
  })

  it('pro raises the ceiling to 5 (4 allowed, 5 blocked)', async () => {
    expect((await createDepartment(makeEnv({ tier: 'pro', departments: 4 }), DEPARTMENT)).ok).toBe(true)
    expect(await createDepartment(makeEnv({ tier: 'pro', departments: 5 }), DEPARTMENT)).toEqual({
      ok: false,
      error: 'department_limit_reached',
    })
  })

  it('unconfigured pot fails closed to free (1 existing → blocked)', async () => {
    const res = await createDepartment(makeEnv({ tier: null, departments: 1 }), DEPARTMENT)
    expect(res).toEqual({ ok: false, error: 'department_limit_reached' })
  })
})

// kind='home' (bootstrap_self's identity container) is STRUCTURALLY exempt —
// the gate never even runs, regardless of how many WORK rows already exist at
// the ceiling. This mock's `first()` always returns the SAME configured count
// no matter the WHERE clause, so what these tests actually pin is that
// createDepartment/createSquad/createAgent never call checkCreateLimit AT ALL
// for a kind:'home' input — proven by the create succeeding even when the mock
// is configured at (or past) the ceiling.
describe('kind:\'home\' is structurally exempt from every plan counter (mupot#925 P0-N1)', () => {
  // kind now arrives ONLY via the third `opts` parameter (mupot#925 P0-928,
  // BLOCK-1) — never via a field on the input object — so these calls pass
  // `{ kind: 'home' }` as opts, not spread into the input literal. See
  // src/org/service.ts's CreateOpts block comment for why: DepartmentInput/
  // SquadInput/AgentInput no longer declare a `kind` field at all, so a JSON
  // request body (cast, not parsed, at src/org/index.ts) has nowhere to bind
  // a `kind` key to — the exemption is reachable only from TypeScript code
  // that has the literal `opts` parameter, i.e. only bootstrap-self.ts.
  it('createDepartment: a home department succeeds even at/past the free department ceiling', async () => {
    const res = await createDepartment(makeEnv({ tier: 'free', departments: 5 }), DEPARTMENT, { kind: 'home' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.kind).toBe('home')
  })

  it('createSquad: a home squad succeeds even at/past the free squad ceiling', async () => {
    const res = await createSquad(makeEnv({ tier: 'free', squads: 5 }), 'dept-1', SQUAD, { kind: 'home' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.kind).toBe('home')
  })

  it('createAgent: a home agent succeeds even at/past the free agent ceiling', async () => {
    const res = await createAgent(makeEnv({ tier: 'free', agents: 5 }), 'squad-1', AGENT, { kind: 'home' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.kind).toBe('home')
  })

  it('a WORK row, by contrast, is still gated normally at the same ceiling (no accidental blanket exemption)', async () => {
    expect(await createDepartment(makeEnv({ tier: 'free', departments: 1 }), DEPARTMENT)).toEqual({
      ok: false,
      error: 'department_limit_reached',
    })
    expect(await createSquad(makeEnv({ tier: 'free', squads: 1 }), 'dept-1', SQUAD)).toEqual({
      ok: false,
      error: 'squad_limit_reached',
    })
    expect(await createAgent(makeEnv({ tier: 'free', agents: 2 }), 'squad-1', AGENT)).toEqual({
      ok: false,
      error: 'agent_limit_reached',
    })
  })
})

// BLOCK-1 (P0, mupot#925 P0-928): a `kind` key ON THE INPUT OBJECT — exactly
// the shape an unvalidated JSON request body takes at src/org/index.ts
// (`body = (await c.req.json()) as CreateXBody`, a CAST that lets an extra
// key ride along unrejected) — must be silently IGNORED by the service layer.
// The gate exemption is reachable ONLY through the third `opts` parameter,
// never through anything that could originate from a caller's JSON body.
//
// MUTATION-CHECK: reverting src/org/service.ts's kind derivation from
// `opts.kind ?? 'work'` back to reading `input.kind` (the pre-fix shape) made
// every test below fail — see the build report for the literal red output.
describe('BLOCK-1: a `kind` field ON THE INPUT OBJECT is never honored — only the opts parameter is', () => {
  it('createDepartment: input.kind="home" at the free department ceiling is still blocked', async () => {
    const res = await createDepartment(makeEnv({ tier: 'free', departments: 1 }), { ...DEPARTMENT, kind: 'home' })
    expect(res).toEqual({ ok: false, error: 'department_limit_reached' })
  })

  it('createSquad: input.kind="home" at the free squad ceiling is still blocked', async () => {
    const res = await createSquad(makeEnv({ tier: 'free', squads: 1 }), 'dept-1', { ...SQUAD, kind: 'home' })
    expect(res).toEqual({ ok: false, error: 'squad_limit_reached' })
  })

  it('createAgent: input.kind="home" at the free agent ceiling is still blocked', async () => {
    const res = await createAgent(makeEnv({ tier: 'free', agents: 2 }), 'squad-1', { ...AGENT, kind: 'home' })
    expect(res).toEqual({ ok: false, error: 'agent_limit_reached' })
  })

  it('createDepartment: input.kind="home" UNDER the ceiling creates a normal kind="work" row (the key is ignored, not just blocked)', async () => {
    const res = await createDepartment(makeEnv({ tier: 'free', departments: 0 }), { ...DEPARTMENT, kind: 'home' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.kind).toBe('work')
  })
})

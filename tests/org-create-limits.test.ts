// tests/org-create-limits.test.ts — S6: plan entitlement enforcement on create.
//
// The tier's PLAN_LIMITS (maxAgents / maxSquads) BITE at the service-layer create
// chokepoint (src/org/service.ts), fail-closed to 'free' when the pot is unconfigured.
// Existing overage is grandfathered (the gate only blocks the NEXT create).

import { describe, it, expect } from 'vitest'
import { createAgent, createSquad } from '../src/org/service'
import { checkCreateLimit } from '../src/billing/entitlement'
import type { Env } from '../src/types'

// A sql-keyed mock: org_settings → billing_state (tier or null), COUNT(*) → configured
// counts, INSERT → ok. tier=null models an UNCONFIGURED pot (resolves to 'free').
function makeEnv(opts: { tier?: string | null; agents?: number; squads?: number }): Env {
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

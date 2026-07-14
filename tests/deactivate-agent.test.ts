import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// deactivate_agent is the inverse of create_agent: a gated, auditable way to retire a
// dead/junk agent (or a duplicate identity) without a raw-D1 hand-edit. These tests
// drive it through the same JSON-RPC seam as the other provision tools and assert the
// four load-bearing invariants:
//   - SOFT delete: agents.status flips to 'inactive' via UPDATE, never DELETE FROM agents
//     (reversible; task/membership history stays intact).
//   - The agent actually loses the ability to ACT: live member_tokens are revoked,
//     fleet_agents presence is cleared, agent_keys are removed.
//   - HARD GUARDS fail closed: fleet consumer/ops agents and self-deactivation are refused.
//   - The id/slug bridge ambiguity guard (mirrors src/fleet/registry.ts) — a slug shared
//     with another agent in a different squad is never swept.

interface Captured {
  sql: string
  args: unknown[]
}

const AGENT = { id: 'agent-1', squad_id: 'squad-1', slug: 'junk-bot', name: 'Junk Bot' }
const memberId = 'member-operator'

interface Opts {
  grants?: CapabilityGrant[]
  agentExists?: boolean
  slugDupeCount?: number // how many agents tenant-wide share AGENT.slug (1 = unique/safe)
  liveTokenChanges?: number // rows UPDATE member_tokens reports revoked
  fleetIdRowExists?: boolean
  fleetSlugRowExists?: boolean
  keyIdRowExists?: boolean
  keySlugRowExists?: boolean
  boundAgentId?: string | null
  fleetConsumerAgent?: string
  fleetOpsAgent?: string
  events?: unknown[]
}

function makeEnv(opts: Opts = {}, captured: Captured[] = []): Env {
  const grants = opts.grants ?? [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const agentExists = opts.agentExists ?? true
  const slugDupeCount = opts.slugDupeCount ?? 1
  const liveTokenChanges = opts.liveTokenChanges ?? 1
  const fleetIdRowExists = opts.fleetIdRowExists ?? true
  const fleetSlugRowExists = opts.fleetSlugRowExists ?? false
  const keyIdRowExists = opts.keyIdRowExists ?? true
  const keySlugRowExists = opts.keySlugRowExists ?? false

  const agentRow = { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }

  function handler(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          sql,
          args,
          async first() {
            if (sql.includes('FROM member_tokens') && sql.includes('JOIN members')) {
              return {
                member_id: memberId,
                email: null,
                display_name: 'Operator',
                telegram_chat_id: null,
                status: 'active',
                created_at: '2026-01-01 00:00:00',
                channel: 'workspace',
                bound_agent_id: opts.boundAgentId ?? null,
              }
            }
            if (sql.includes('SELECT department_id FROM squads')) {
              return args[0] === AGENT.squad_id ? { department_id: 'dept-1' } : null
            }
            if (sql.includes('FROM agents') && sql.includes('WHERE id')) {
              return agentExists && args[0] === AGENT.id ? agentRow : null
            }
            if (sql.includes('SELECT COUNT(*) AS n FROM agents WHERE slug')) {
              return { n: slugDupeCount }
            }
            return null
          },
          async all() {
            if (sql.includes('FROM capabilities')) return { results: grants }
            if (sql.includes('FROM agents') && sql.includes('WHERE slug')) {
              return agentExists && args[0] === AGENT.slug ? { results: [agentRow] } : { results: [] }
            }
            return { results: [] }
          },
          async run() {
            return { meta: { changes: 1 } }
          },
        }
      },
    }
  }

  return {
    TENANT_SLUG: 'digid',
    FLEET_CONSUMER_AGENT: opts.fleetConsumerAgent,
    FLEET_OPS_AGENT: opts.fleetOpsAgent,
    DB: {
      prepare: (sql: string) => handler(sql),
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        captured.push(...stmts)
        return stmts.map((s) => {
          if (s.sql.startsWith('UPDATE agents')) {
            return { meta: { changes: agentExists ? 1 : 0 } }
          }
          if (s.sql.startsWith('UPDATE member_tokens')) {
            return { meta: { changes: liveTokenChanges } }
          }
          if (s.sql.startsWith('DELETE FROM fleet_agents')) {
            const keyedBySlug = s.args[1] === AGENT.slug
            const exists = keyedBySlug ? fleetSlugRowExists : fleetIdRowExists
            return { meta: { changes: exists ? 1 : 0 } }
          }
          if (s.sql.startsWith('DELETE FROM agent_keys')) {
            const keyedBySlug = s.args[1] === AGENT.slug
            const exists = keyedBySlug ? keySlugRowExists : keyIdRowExists
            return { meta: { changes: exists ? 1 : 0 } }
          }
          return { meta: { changes: 0 } }
        })
      },
    },
    BUS: { send: async (event: unknown) => { opts.events?.push(event) } },
  } as unknown as Env
}

async function call(name: string, args: Record<string, unknown>, env: Env, auth = true) {
  return mcpApp.request(
    'https://agents.digid.ca/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer test-token' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    env,
  )
}

describe('deactivate_agent — advertised', () => {
  it('appears in tools/list', async () => {
    const res = await mcpApp.request(
      'https://agents.digid.ca/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } }
    const tool = body.result.tools.find((t) => t.name === 'deactivate_agent')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { agent: { type: 'string' }, reason: { type: 'string' } },
      required: ['agent'],
      additionalProperties: false,
    })
  })
})

describe('deactivate_agent — happy path', () => {
  it('org-admin deactivates: soft status flip + tokens revoked + fleet detached + key removed + audit event', async () => {
    const captured: Captured[] = []
    const events: unknown[] = []
    const res = await call('deactivate_agent', { agent: 'junk-bot', reason: 'test cleanup' }, makeEnv({ events }, captured))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          status: string
          agent: { id: string; slug: string; name: string }
          detached: number
          tokens_revoked: number
          keys_removed: number
        }
      }
    }
    expect(body.result.structuredContent).toEqual({
      status: 'deactivated',
      agent: { id: AGENT.id, slug: AGENT.slug, name: AGENT.name },
      detached: 1,
      tokens_revoked: 1,
      keys_removed: 1,
    })

    // SOFT delete — an UPDATE, never a DELETE FROM agents.
    const agentWrite = captured.find((c) => c.sql.includes('agents') && !c.sql.includes('fleet_agents') && !c.sql.includes('agent_keys'))
    expect(agentWrite?.sql).toContain('UPDATE agents')
    expect(agentWrite?.sql).toContain("status = 'inactive'")
    expect(captured.some((c) => c.sql.startsWith('DELETE FROM agents'))).toBe(false)

    // credential revocation is tenant-scoped and welded to the agent id.
    const tokenWrite = captured.find((c) => c.sql.includes('member_tokens'))
    expect(tokenWrite?.sql).toContain('UPDATE member_tokens')
    expect(tokenWrite?.args).toEqual(expect.arrayContaining(['digid', AGENT.id]))

    // fleet + key cleanup tenant-scoped.
    expect(captured.some((c) => c.sql.includes('DELETE FROM fleet_agents') && c.args.includes(AGENT.id))).toBe(true)
    expect(captured.some((c) => c.sql.includes('DELETE FROM agent_keys') && c.args.includes(AGENT.id))).toBe(true)

    // attributed audit event, reason carried through.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'org.provisioned',
      squad_id: AGENT.squad_id,
      agent_id: AGENT.id,
      actor: { kind: 'member', id: memberId },
      payload: { kind: 'agent_deactivated', id: AGENT.id, by: memberId, reason: 'test cleanup' },
    })
  })

  it('resolves by id as well as slug', async () => {
    const captured: Captured[] = []
    const res = await call('deactivate_agent', { agent: AGENT.id }, makeEnv({}, captured))
    expect(res.status).toBe(200)
  })

  it('omits reason from the audit payload when not supplied', async () => {
    const events: unknown[] = []
    const res = await call('deactivate_agent', { agent: 'junk-bot' }, makeEnv({ events }))
    expect(res.status).toBe(200)
    expect((events[0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty('reason')
  })
})

describe('deactivate_agent — authorization', () => {
  it('403s a squad-lead (needs admin, same rank as mint/register)', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: memberId, scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'lead' },
    ]
    const captured: Captured[] = []
    const res = await call('deactivate_agent', { agent: 'junk-bot' }, makeEnv({ grants }, captured))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('forbidden')
    expect(captured).toEqual([]) // nothing written on a denied call
  })

  it('requires a bearer token', async () => {
    const res = await call('deactivate_agent', { agent: 'junk-bot' }, makeEnv(), false)
    expect(res.status).toBe(401)
  })

  it('404s an agent that does not exist (also covers cross-tenant: this tenant\'s D1 has no such row)', async () => {
    const res = await call('deactivate_agent', { agent: 'ghost' }, makeEnv({ agentExists: false }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('agent_not_found')
  })
})

describe('deactivate_agent — hard guards', () => {
  it('refuses to deactivate the configured FLEET_CONSUMER_AGENT (by slug)', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ fleetConsumerAgent: AGENT.slug }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('protected_agent')
    expect(captured).toEqual([])
  })

  it('refuses to deactivate the configured FLEET_CONSUMER_AGENT (by id)', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ fleetConsumerAgent: AGENT.id }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('protected_agent')
    expect(captured).toEqual([])
  })

  it('refuses to deactivate the configured FLEET_OPS_AGENT', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ fleetOpsAgent: AGENT.slug }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('protected_agent')
    expect(captured).toEqual([])
  })

  it('refuses self-deactivation (caller\'s own bound-agent token)', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ boundAgentId: AGENT.id }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('cannot_deactivate_self')
    expect(captured).toEqual([])
  })

  it('allows a different agent-bound token to deactivate this agent', async () => {
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ boundAgentId: 'some-other-agent' }),
    )
    expect(res.status).toBe(200)
  })
})

describe('deactivate_agent — id/slug bridge ambiguity guard', () => {
  it('sweeps both id- and slug-keyed fleet_agents/agent_keys rows when the slug is unique tenant-wide', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ slugDupeCount: 1, fleetSlugRowExists: true, keySlugRowExists: true }, captured),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { detached: number; keys_removed: number; slug_sweep_skipped?: boolean } }
    }
    // id-keyed (1) + slug-keyed (1) = 2 each
    expect(body.result.structuredContent.detached).toBe(2)
    expect(body.result.structuredContent.keys_removed).toBe(2)
    expect(captured.filter((c) => c.sql.includes('DELETE FROM fleet_agents'))).toHaveLength(2)
    expect(captured.filter((c) => c.sql.includes('DELETE FROM agent_keys'))).toHaveLength(2)
    // slug was safe to sweep — no skip flag should be surfaced.
    expect(body.result.structuredContent.slug_sweep_skipped).toBeUndefined()
  })

  it('refuses the slug-keyed sweep when the slug is shared with another agent (ambiguous), and says so', async () => {
    const captured: Captured[] = []
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ slugDupeCount: 2, fleetSlugRowExists: true, keySlugRowExists: true }, captured),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { detached: number; keys_removed: number; slug_sweep_skipped?: boolean } }
    }
    // only the id-keyed row is swept; the slug-keyed row (which could belong to a
    // DIFFERENT agent in a different squad) is left untouched.
    expect(body.result.structuredContent.detached).toBe(1)
    expect(body.result.structuredContent.keys_removed).toBe(1)
    expect(captured.filter((c) => c.sql.includes('DELETE FROM fleet_agents'))).toHaveLength(1)
    expect(captured.filter((c) => c.sql.includes('DELETE FROM agent_keys'))).toHaveLength(1)
    // the ambiguous-slug skip must be visible in the result, not silent —
    // a signed runtime key or fleet row keyed by the bare slug can survive
    // this deactivation and the operator needs to know to clean it up by hand.
    expect(body.result.structuredContent.slug_sweep_skipped).toBe(true)
  })

  it('reports zero when the agent has no fleet presence / no key (still succeeds)', async () => {
    const res = await call(
      'deactivate_agent',
      { agent: 'junk-bot' },
      makeEnv({ fleetIdRowExists: false, keyIdRowExists: false, liveTokenChanges: 0 }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { status: string; detached: number; keys_removed: number; tokens_revoked: number } }
    }
    expect(body.result.structuredContent).toMatchObject({ status: 'deactivated', detached: 0, keys_removed: 0, tokens_revoked: 0 })
  })
})

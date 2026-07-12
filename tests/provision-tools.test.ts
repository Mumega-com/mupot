import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { Capability, CapabilityGrant, Env } from '../src/types'

// The provision tools (create_squad / create_agent / mint_agent_token) are the in-band
// org-builder surface. These tests drive them through the JSON-RPC seam (tools/call) the
// same way Codex/Claude Code would. The DB mock routes by SQL substring AND records every
// bound INSERT so we can assert the two security invariants directly:
//   - the WELD: mint_agent_token binds the new token to the agent (member_tokens.agent_id).
//   - the ESCALATION GUARD: the agent's only capability is squad-scoped observer/member
//     (never org/department, never above member) — it cannot inherit the operator's org-admin.

interface Captured {
  sql: string
  args: unknown[]
}

interface Opts {
  grants?: CapabilityGrant[]
  squadExists?: boolean
  agentExists?: boolean
  deptExists?: boolean
  agentTokenMembers?: string[]
  existingGrantCapabilities?: Capability[]
  events?: unknown[]
}

const SQUAD = { id: 'squad-1', department_id: 'dept-1' }
const TARGET_SQUAD = { id: 'squad-2', department_id: 'dept-2', slug: 'target-squad' }
const AGENT = { id: 'agent-1', squad_id: 'squad-1', slug: 'growth-lead', name: 'Growth Lead' }

function makeEnv(opts: Opts = {}, captured: Captured[] = []): Env {
  const memberId = 'member-operator'
  const grants = opts.grants ?? [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const squadExists = opts.squadExists ?? true
  const agentExists = opts.agentExists ?? true
  const deptExists = opts.deptExists ?? true
  const agentTokenMembers = opts.agentTokenMembers ?? ['member-agent-1']
  const existingGrantCapabilities = opts.existingGrantCapabilities ?? []

  const agentRow = { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }

  const handler = (sql: string) => ({
    bind(...args: unknown[]) {
      const ref = args[0]
      const byId = sql.includes('WHERE id')
      return {
        // carried so DB.batch() can record the composed INSERTs (atomic mint path)
        sql,
        args,
        // .first() serves the member_tokens authn lookup and every WHERE-id resolve
        // (ids are globally unique). Slug resolves go through .all() (count matches).
        async first() {
          if (sql.includes('FROM member_tokens')) {
            return {
              member_id: memberId,
              email: null,
              display_name: 'Operator',
              telegram_chat_id: null,
              status: 'active',
              created_at: '2026-06-09 00:00:00',
              channel: 'workspace',
              bound_agent_id: null,
            }
          }
          if (sql.includes('FROM agent_keys')) return null
          if (sql.includes('FROM departments') && byId) {
            return deptExists && ref === 'dept-1' ? { id: 'dept-1' } : null
          }
          if (sql.includes('FROM squads') && byId) {
            // resolveSquad + resolveSquadDepartment (memberCanOnSquad) both key on id.
            if (!squadExists) return null
            if (ref === SQUAD.id) return { id: SQUAD.id, department_id: SQUAD.department_id }
            if (ref === TARGET_SQUAD.id) return { id: TARGET_SQUAD.id, department_id: TARGET_SQUAD.department_id }
            return null
          }
          if (sql.includes('FROM agents') && byId) {
            return agentExists && ref === AGENT.id ? agentRow : null
          }
          return null
        },
        async all() {
          if (sql.includes('SELECT capability FROM capabilities')) {
            return { results: existingGrantCapabilities.map((capability) => ({ capability })) }
          }
          if (sql.includes('FROM capabilities')) return { results: grants }
          if (sql.includes('SELECT DISTINCT t.member_id')) {
            return {
              results: [...new Set(agentTokenMembers)].slice(0, 2).map((member_id) => ({ member_id })),
            }
          }
          // slug resolves: count matches. 'dup' deliberately matches TWO agents.
          if (sql.includes('FROM agents') && sql.includes('WHERE slug')) {
            if (ref === 'dup') return { results: [agentRow, { ...agentRow, id: 'agent-2', squad_id: 'squad-2' }] }
            return agentExists && ref === AGENT.slug ? { results: [agentRow] } : { results: [] }
          }
          if (sql.includes('FROM squads') && sql.includes('WHERE slug')) {
            if (squadExists && ref === TARGET_SQUAD.slug) {
              return { results: [{ id: TARGET_SQUAD.id, department_id: TARGET_SQUAD.department_id }] }
            }
            return squadExists && ref === 'squad-slug'
              ? { results: [{ id: SQUAD.id, department_id: SQUAD.department_id }] }
              : { results: [] }
          }
          if (sql.includes('FROM departments') && sql.includes('WHERE slug')) {
            return deptExists && ref === 'dept-slug' ? { results: [{ id: 'dept-1' }] } : { results: [] }
          }
          return { results: [] }
        },
        async run() {
          // record every mutating INSERT so the test can assert what was written
          if (sql.includes('INSERT INTO')) captured.push({ sql, args })
          return { meta: { changes: 1 } }
        },
      }
    },
  })

  return {
    TENANT_SLUG: 'digid',
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare: (sql: string) => handler(sql),
      // atomic mint runs member+capability+token as one batch; record each INSERT.
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) if (s.sql.includes('INSERT INTO')) captured.push({ sql: s.sql, args: s.args })
        return stmts.map(() => ({ meta: { changes: 1 } }))
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

describe('provision tools — advertised', () => {
  it('all provision tools appear in tools/list', async () => {
    const res = await mcpApp.request(
      'https://agents.digid.ca/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('create_department')
    expect(names).toContain('create_squad')
    expect(names).toContain('create_agent')
    expect(names).toContain('mint_agent_token')
    expect(names).toContain('register_agent_key')
    expect(names).toContain('grant_agent_capability')
  })

  it('advertises grant_agent_capability with its exact schema', async () => {
    const res = await mcpApp.request(
      'https://agents.digid.ca/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as {
      result: { tools: { name: string; inputSchema: unknown }[] }
    }
    const tool = body.result.tools.find(({ name }) => name === 'grant_agent_capability')
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        agent: { type: 'string' },
        squad: { type: 'string' },
        capability: { type: 'string' },
      },
      required: ['agent', 'squad', 'capability'],
      additionalProperties: false,
    })
  })
})

describe('create_department', () => {
  it('org-admin creates a department (zero-state root)', async () => {
    const cap = [] as Captured[]
    const res = await call('create_department', { slug: 'revenue', name: 'Revenue' }, makeEnv({}, cap))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { department: { slug: string } } } }
    expect(body.result.structuredContent.department.slug).toBe('revenue')
    expect(cap.some((c) => c.sql.includes('INSERT INTO departments'))).toBe(true)
  })

  it('403s a non-org-admin (department is org-structure)', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'department', scope_id: 'dept-1', capability: 'admin' },
    ]
    const res = await call('create_department', { slug: 'revenue', name: 'Revenue' }, makeEnv({ grants }))
    expect(res.status).toBe(403)
  })
})

describe('create_squad', () => {
  it('org-admin creates a squad in a department', async () => {
    const cap = [] as Captured[]
    const res = await call('create_squad', { department: 'dept-1', slug: 'growth', name: 'Growth' }, makeEnv({}, cap))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { squad: { slug: string } } } }
    expect(body.result.structuredContent.squad.slug).toBe('growth')
    expect(cap.some((c) => c.sql.includes('INSERT INTO squads'))).toBe(true)
  })

  it('404s when the department does not exist', async () => {
    const res = await call('create_squad', { department: 'ghost', slug: 'growth', name: 'Growth' }, makeEnv({ deptExists: false }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('department_not_found')
  })

  it('403s a non-admin (squad-lead only) — squad creation needs department admin', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: 'squad-1', capability: 'lead' },
    ]
    const res = await call('create_squad', { department: 'dept-1', slug: 'growth', name: 'Growth' }, makeEnv({ grants }))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('forbidden')
  })

  it('400s an invalid slug (validation mirrors the dashboard path)', async () => {
    const res = await call('create_squad', { department: 'dept-1', slug: 'Bad Slug!', name: 'Growth' }, makeEnv())
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_slug')
  })

  it('400s an unknown field at the seam (W1 runtime schema enforcement)', async () => {
    const res = await call(
      'create_squad',
      { department: 'dept-1', slug: 'growth', name: 'Growth', evil: 'x' },
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_args')
  })

  it('400s a prototype-chain key (constructor) — no additionalProperties bypass (P2)', async () => {
    const res = await call(
      'create_squad',
      { department: 'dept-1', slug: 'growth', name: 'Growth', constructor: 'x' },
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_args')
  })

  it('400s a negative budget_cap_cents (W4)', async () => {
    const res = await call(
      'create_squad',
      { department: 'dept-1', slug: 'growth', name: 'Growth', budget_cap_cents: -1 },
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_budget_cap_cents')
  })
})

describe('create_agent', () => {
  it('squad-lead creates an agent in their squad', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: 'squad-1', capability: 'lead' },
    ]
    const cap = [] as Captured[]
    const res = await call('create_agent', { squad: 'squad-1', slug: 'sdr-1', name: 'SDR One' }, makeEnv({ grants }, cap))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { agent: { slug: string } } } }
    expect(body.result.structuredContent.agent.slug).toBe('sdr-1')
    expect(cap.some((c) => c.sql.includes('INSERT INTO agents'))).toBe(true)
  })

  it('403s a squad member (needs lead)', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' },
    ]
    const res = await call('create_agent', { squad: 'squad-1', slug: 'sdr-1', name: 'SDR One' }, makeEnv({ grants }))
    expect(res.status).toBe(403)
  })

  it('404s when the squad does not exist', async () => {
    const res = await call('create_agent', { squad: 'ghost', slug: 'sdr-1', name: 'SDR One' }, makeEnv({ squadExists: false }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('squad_not_found')
  })
})

describe('mint_agent_token', () => {
  it('org-admin mints a bound token (the weld) with a default hard-capped squad member grant', async () => {
    const cap = [] as Captured[]
    const res = await call('mint_agent_token', { agent: 'growth-lead' }, makeEnv({}, cap))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          token: { raw: string; agent_id: string; capability: string }
          agent: { id: string }
          mcp_endpoint: string
          wake_contract: {
            emit_url: string
            auth_header: string
            body_shape: { type: string; agent_id: string; tenant: string; squad_id: string }
            note: string
          }
        }
      }
    }
    const sc = body.result.structuredContent
    // show-once raw token, bound to the agent
    expect(sc.token.raw.startsWith('mupot_')).toBe(true)
    expect(sc.token.agent_id).toBe('agent-1')
    expect(sc.token.capability).toBe('member')
    expect(sc.agent.id).toBe('agent-1')
    expect(sc.mcp_endpoint).toBe('https://agents.digid.ca/mcp')

    // THE WAKE CONTRACT (#115): machine-readable wake spec returned alongside mcp_endpoint.
    expect(sc.wake_contract.emit_url).toBe('https://agents.digid.ca/bus/emit')
    expect(sc.wake_contract.auth_header).toBe('Authorization')
    expect(sc.wake_contract.body_shape.type).toBe('agent.wake')
    expect(sc.wake_contract.body_shape.agent_id).toBe('agent-1')
    expect(sc.wake_contract.body_shape.squad_id).toBe('squad-1')
    expect(sc.wake_contract.body_shape.tenant).toBe('digid')
    expect(typeof sc.wake_contract.note).toBe('string')

    // THE WELD: member_tokens insert carries the agent id in agent_id.
    const tokenInsert = cap.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert).toBeDefined()
    expect(tokenInsert!.args).toContain('agent-1')
    expect(tokenInsert!.args).toContain('digid')

    // THE ESCALATION GUARD: the agent's capability is squad-scoped 'member' by
    // default on its OWN squad — never org/department, never above member.
    const capInsert = cap.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.sql).toContain("'squad'")
    expect(capInsert!.args).toContain('squad-1') // scope_id bound to the agent's squad
    expect(capInsert!.args).toContain('member')
  })

  it('can mint a lower observer-bound token but not a higher one', async () => {
    const observerRows = [] as Captured[]
    const observerRes = await call(
      'mint_agent_token',
      { agent: 'growth-lead', capability: 'observer' },
      makeEnv({}, observerRows),
    )
    expect(observerRes.status).toBe(200)
    const observerBody = (await observerRes.json()) as {
      result: { structuredContent: { token: { capability: string } } }
    }
    expect(observerBody.result.structuredContent.token.capability).toBe('observer')
    const observerCap = observerRows.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(observerCap).toBeDefined()
    expect(observerCap!.args).toContain('observer')
    expect(observerCap!.args).toContain('squad-1')

    const higherRows = [] as Captured[]
    const higherRes = await call(
      'mint_agent_token',
      { agent: 'growth-lead', capability: 'lead' },
      makeEnv({}, higherRows),
    )
    expect(higherRes.status).toBe(400)
    expect(((await higherRes.json()) as { error: { message: string } }).error.message).toBe('invalid_capability')
    expect(higherRows).toEqual([])
  })

  it('403s a squad-lead — minting a credential needs admin', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: 'squad-1', capability: 'lead' },
    ]
    const cap = [] as Captured[]
    const res = await call('mint_agent_token', { agent: 'growth-lead' }, makeEnv({ grants }, cap))
    expect(res.status).toBe(403)
    // no member / capability / token rows written on a denied mint
    expect(cap.length).toBe(0)
  })

  it('404s when the agent does not exist', async () => {
    const res = await call('mint_agent_token', { agent: 'ghost' }, makeEnv({ agentExists: false }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('agent_not_found')
  })

  it('409s an ambiguous slug — refuses to bind a credential to an arbitrary row (P1 guard)', async () => {
    // 'dup' matches two agents in different squads. A LIMIT-1 resolve would mint a
    // credential onto an arbitrary one; we refuse and tell the caller to use the id.
    const cap = [] as Captured[]
    const res = await call('mint_agent_token', { agent: 'dup' }, makeEnv({}, cap))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('ambiguous_slug')
    // nothing minted on an ambiguous resolve
    expect(cap.length).toBe(0)
  })

  it('requires a bearer token', async () => {
    const res = await call('mint_agent_token', { agent: 'growth-lead' }, makeEnv(), false)
    expect(res.status).toBe(401)
  })
})

describe('register_agent_key', () => {
  const publicKey = '5c2qcgyH-XJyGIYqP--Ibqlc8Y2qIuNhEhqEZZyv0oY'

  it('registers public-only material against the minted agent identity', async () => {
    const captured: Captured[] = []
    const res = await call(
      'register_agent_key',
      { agent: 'growth-lead', public_key: publicKey },
      makeEnv({}, captured),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { status: string; key_id: string; member_id: string; public_key: string; agent: { id: string } } }
    }
    expect(body.result.structuredContent).toMatchObject({
      status: 'registered',
      key_id: 'agent-1',
      member_id: 'member-agent-1',
      public_key: publicKey,
      agent: { id: 'agent-1' },
    })
    const insert = captured.find((row) => row.sql.includes('INSERT INTO agent_keys'))
    expect(insert?.args).toEqual(['digid', 'agent-1', publicKey, 'member-agent-1', expect.any(Number)])
    expect(JSON.stringify(captured)).not.toContain('"d"')
  })

  it('rejects malformed public keys before writing', async () => {
    const captured: Captured[] = []
    const res = await call(
      'register_agent_key',
      { agent: 'growth-lead', public_key: 'not-a-key' },
      makeEnv({}, captured),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_public_key')
    expect(captured).toEqual([])
  })

  it('requires admin on the agent squad', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: 'squad-1', capability: 'lead' },
    ]
    const captured: Captured[] = []
    const res = await call(
      'register_agent_key',
      { agent: 'growth-lead', public_key: publicKey },
      makeEnv({ grants }, captured),
    )
    expect(res.status).toBe(403)
    expect(captured).toEqual([])
  })

  it('allows an explicit legacy slug or exact database id and rejects aliases', async () => {
    const idRows: Captured[] = []
    const idRes = await call(
      'register_agent_key',
      { agent: 'growth-lead', key_id: 'agent-1', public_key: publicKey },
      makeEnv({}, idRows),
    )
    expect(idRes.status).toBe(200)
    expect(idRows.find((row) => row.sql.includes('INSERT INTO agent_keys'))?.args[1]).toBe('agent-1')

    const slugRows: Captured[] = []
    const slugRes = await call(
      'register_agent_key',
      { agent: 'growth-lead', key_id: 'growth-lead', public_key: publicKey },
      makeEnv({}, slugRows),
    )
    expect(slugRes.status).toBe(200)
    expect(slugRows.find((row) => row.sql.includes('INSERT INTO agent_keys'))?.args[1]).toBe('growth-lead')

    const aliasRows: Captured[] = []
    const aliasRes = await call(
      'register_agent_key',
      { agent: 'growth-lead', key_id: 'another-agent', public_key: publicKey },
      makeEnv({}, aliasRows),
    )
    expect(aliasRes.status).toBe(400)
    expect(((await aliasRes.json()) as { error: { message: string } }).error.message).toBe('invalid_key_id')
    expect(aliasRows).toEqual([])
  })
})

describe('grant_agent_capability', () => {
  const args = { agent: AGENT.slug, squad: TARGET_SQUAD.slug, capability: 'member' }

  it('grants a resolved active agent member on the target squad without exposing token fields', async () => {
    const captured: Captured[] = []
    const events: unknown[] = []
    const res = await call('grant_agent_capability', args, makeEnv({ events }, captured))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          agent: { id: string }
          squad: { id: string }
          member_id: string
          grant: CapabilityGrant
          result: string
        }
      }
    }
    expect(body.result.structuredContent).toEqual({
      agent: { id: AGENT.id },
      squad: { id: TARGET_SQUAD.id },
      member_id: 'member-agent-1',
      grant: {
        member_id: 'member-agent-1',
        scope_type: 'squad',
        scope_id: TARGET_SQUAD.id,
        capability: 'member',
      },
      result: 'created',
    })
    expect(captured.find((row) => row.sql.includes('INSERT INTO capabilities'))?.args).toEqual([
      expect.any(String),
      'member-agent-1',
      'squad',
      TARGET_SQUAD.id,
      'member',
    ])

    expect(JSON.stringify(body.result.structuredContent)).not.toMatch(/token|raw|hash/i)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'org.provisioned',
      squad_id: TARGET_SQUAD.id,
      agent_id: AGENT.id,
      payload: { kind: 'capability', id: TARGET_SQUAD.id, by: 'member-operator' },
    })
    expect(JSON.stringify(events[0])).not.toMatch(/token|raw|hash/i)
  })

  it('reports unchanged when the target member already has the requested squad grant', async () => {
    const res = await call(
      'grant_agent_capability',
      args,
      makeEnv({ existingGrantCapabilities: ['member'] }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { result: string } } }
    expect(body.result.structuredContent.result).toBe('unchanged')
  })

  it('accepts multiple active tokens welded to the same member identity', async () => {
    const res = await call(
      'grant_agent_capability',
      args,
      makeEnv({ agentTokenMembers: ['member-agent-1', 'member-agent-1'] }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { member_id: string } } }
    expect(body.result.structuredContent.member_id).toBe('member-agent-1')
  })

  it('rejects an unminted agent identity before writing a grant', async () => {
    const captured: Captured[] = []
    const res = await call('grant_agent_capability', args, makeEnv({ agentTokenMembers: [] }, captured))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('agent_identity_unminted')
    expect(captured).toEqual([])
  })

  it('rejects an agent with ambiguous active member identities before writing a grant', async () => {
    const captured: Captured[] = []
    const res = await call(
      'grant_agent_capability',
      args,
      makeEnv({ agentTokenMembers: ['member-agent-1', 'member-agent-2'] }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('agent_identity_ambiguous')
    expect(captured).toEqual([])
  })

  it('rejects capabilities outside the grantable allowlist', async () => {
    const captured: Captured[] = []
    const res = await call(
      'grant_agent_capability',
      { ...args, capability: 'owner' },
      makeEnv({}, captured),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('invalid_capability')
    expect(captured).toEqual([])
  })

  it('requires admin on the target squad rather than the agent home squad', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'admin' },
    ]
    const captured: Captured[] = []
    const res = await call('grant_agent_capability', args, makeEnv({ grants }, captured))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('forbidden')
    expect(captured).toEqual([])
  })

  it('rejects an admin grant above a caller limited to target-squad lead', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: TARGET_SQUAD.id, capability: 'lead' },
    ]
    const captured: Captured[] = []
    const res = await call(
      'grant_agent_capability',
      { ...args, capability: 'admin' },
      makeEnv({ grants }, captured),
    )
    expect(res.status).toBe(403)
    expect(captured).toEqual([])
  })
})

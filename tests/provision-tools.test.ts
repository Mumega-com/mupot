import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// The provision tools (create_squad / create_agent / mint_agent_token) are the in-band
// org-builder surface. These tests drive them through the JSON-RPC seam (tools/call) the
// same way Codex/Claude Code would. The DB mock routes by SQL substring AND records every
// bound INSERT so we can assert the two security invariants directly:
//   - the WELD: mint_agent_token binds the new token to the agent (member_tokens.agent_id).
//   - the ESCALATION GUARD: the agent's only capability is squad-scoped 'member' (never
//     org/department, never above member) — it cannot inherit the operator's org-admin.

interface Captured {
  sql: string
  args: unknown[]
}

interface Opts {
  grants?: CapabilityGrant[]
  squadExists?: boolean
  agentExists?: boolean
  deptExists?: boolean
}

const SQUAD = { id: 'squad-1', department_id: 'dept-1' }
const AGENT = { id: 'agent-1', squad_id: 'squad-1', slug: 'growth-lead', name: 'Growth Lead' }

function makeEnv(opts: Opts = {}, captured: Captured[] = []): Env {
  const memberId = 'member-operator'
  const grants = opts.grants ?? [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const squadExists = opts.squadExists ?? true
  const agentExists = opts.agentExists ?? true
  const deptExists = opts.deptExists ?? true

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
          if (sql.includes('FROM departments') && byId) {
            return deptExists && ref === 'dept-1' ? { id: 'dept-1' } : null
          }
          if (sql.includes('FROM squads') && byId) {
            // resolveSquad + resolveSquadDepartment (memberCanOnSquad) both key on id.
            return squadExists && ref === SQUAD.id
              ? { id: SQUAD.id, department_id: SQUAD.department_id }
              : null
          }
          if (sql.includes('FROM agents') && byId) {
            return agentExists && ref === AGENT.id ? agentRow : null
          }
          return null
        },
        async all() {
          if (sql.includes('FROM capabilities')) return { results: grants }
          // slug resolves: count matches. 'dup' deliberately matches TWO agents.
          if (sql.includes('FROM agents') && sql.includes('WHERE slug')) {
            if (ref === 'dup') return { results: [agentRow, { ...agentRow, id: 'agent-2', squad_id: 'squad-2' }] }
            return agentExists && ref === AGENT.slug ? { results: [agentRow] } : { results: [] }
          }
          if (sql.includes('FROM squads') && sql.includes('WHERE slug')) {
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
    BUS: { send: async () => {} },
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
  it('all three appear in tools/list', async () => {
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
  it('org-admin mints a bound token (the weld) with a hard-capped squad member grant', async () => {
    const cap = [] as Captured[]
    const res = await call('mint_agent_token', { agent: 'growth-lead' }, makeEnv({}, cap))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { token: { raw: string; agent_id: string }; agent: { id: string }; mcp_endpoint: string } }
    }
    const sc = body.result.structuredContent
    // show-once raw token, bound to the agent
    expect(sc.token.raw.startsWith('mupot_')).toBe(true)
    expect(sc.token.agent_id).toBe('agent-1')
    expect(sc.agent.id).toBe('agent-1')
    expect(sc.mcp_endpoint).toBe('https://agents.digid.ca/mcp')

    // THE WELD: member_tokens insert carries the agent id in agent_id (6th bind;
    // channel is a hard-coded literal, so binds are id,member,hash,label,created_at,agent_id).
    const tokenInsert = cap.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert).toBeDefined()
    expect(tokenInsert!.args[5]).toBe('agent-1')

    // THE ESCALATION GUARD: the agent's only capability is squad-scoped 'member'
    // on its OWN squad — never org/department, never above member.
    const capInsert = cap.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.sql).toContain("'squad'")
    expect(capInsert!.sql).toContain("'member'")
    expect(capInsert!.args).toContain('squad-1') // scope_id bound to the agent's squad
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

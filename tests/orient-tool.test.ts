import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// orient is the basin-drop MCP tool. These tests drive it through the JSON-RPC seam
// (tools/call) the same way a real agent harness would. The DB is a hand-rolled mock
// that routes by SQL substring — buildOrient fans out across several tables, so the
// mock answers each leg (agent → squad → dept → memberships → tasks → field → induction).

interface Opts {
  boundAgentId?: string | null // member_tokens.agent_id (the weld)
  grants?: CapabilityGrant[] // the caller's capabilities
  agentExists?: boolean // does the resolved agent row exist
}

const AGENT = {
  id: 'agent-growth-1',
  slug: 'growth-lead',
  name: 'Growth Lead',
  role: 'lead',
  status: 'active',
  squad_id: 'squad-1',
  okr: 'Grow pipeline',
  kpi_target: '20 demos',
  kpi_progress: 40,
  effort: 'steady',
  autonomy: 'draft',
  budget_cap_cents: 5000,
  budget_window: 'month',
}

function makeEnv(opts: Opts = {}): Env {
  const memberId = 'member-1'
  const grants = opts.grants ?? [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const agentExists = opts.agentExists ?? true

  const handler = (sql: string) => ({
    bind() {
      return {
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
              bound_agent_id: opts.boundAgentId ?? null,
            }
          }
          // resolveAgentRef (id then slug) + buildOrient's full agent SELECT
          if (sql.includes('FROM agents')) {
            if (!agentExists) return null
            if (sql.includes('okr, kpi_target')) return AGENT // full row
            return { id: AGENT.id, squad_id: AGENT.squad_id } // ref lookup
          }
          // buildOrient squad row (has charter/okr) vs resolveSquadDepartment (department_id only)
          if (sql.includes('FROM squads')) {
            if (sql.includes('charter')) {
              return { id: 'squad-1', name: 'Growth', charter: 'Win customers', okr: 'Pipeline', department_id: 'dept-1' }
            }
            return { department_id: 'dept-1' }
          }
          if (sql.includes('FROM departments')) return { id: 'dept-1', name: 'Revenue' }
          if (sql.includes('FROM agent_field')) return null
          if (sql.includes('first_inducted_at FROM agent_orientation')) return null // induction = true
          return null
        },
        async all() {
          if (sql.includes('FROM capabilities')) return { results: grants }
          if (sql.includes('FROM memberships')) {
            return {
              results: [
                { agent_id: AGENT.id, name: AGENT.name, role: AGENT.role, capability: 'lead' },
              ],
            }
          }
          if (sql.includes('FROM tasks')) {
            return { results: [{ id: 'task-1', title: 'Ship landing page', status: 'open' }] }
          }
          return { results: [] }
        },
        async run() {
          return {}
        },
      }
    },
  })

  return {
    TENANT_SLUG: 'digid',
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: { prepare: (sql: string) => handler(sql) },
  } as unknown as Env
}

async function orient(args: Record<string, unknown>, env: Env, auth = true) {
  return mcpApp.request(
    'https://agents.digid.ca/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer test-token' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orient', arguments: args } }),
    },
    env,
  )
}

describe('orient MCP tool', () => {
  it('is advertised in tools/list', async () => {
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
    expect(body.result.tools.map((t) => t.name)).toContain('orient')
  })

  it('orients the token-bound agent with no args (the weld)', async () => {
    const res = await orient({}, makeEnv({ boundAgentId: AGENT.id }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { packet: { agent: { id: string } }; brief: string } }
    }
    expect(body.result.structuredContent.packet.agent.id).toBe(AGENT.id)
    expect(body.result.structuredContent.brief).toContain('Growth Lead')
    // the brief grounds the agent in THIS pot's MCP endpoint, derived from the request origin
    expect(body.result.structuredContent.brief).toContain('https://agents.digid.ca/mcp')
  })

  it('orients an explicitly named agent (operator path)', async () => {
    const res = await orient({ agent: 'growth-lead' }, makeEnv({ boundAgentId: null }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { packet: { agent: { id: string } } } } }
    expect(body.result.structuredContent.packet.agent.id).toBe(AGENT.id)
  })

  it('400s when an unbound token names no agent', async () => {
    const res = await orient({}, makeEnv({ boundAgentId: null }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('invalid_args')
  })

  it('403s when the caller has neither org-admin nor squad access', async () => {
    const res = await orient({ agent: 'growth-lead' }, makeEnv({ boundAgentId: null, grants: [] }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('forbidden')
  })

  it('404s when the agent does not exist', async () => {
    const res = await orient({ agent: 'ghost' }, makeEnv({ grants: [{ member_id: 'member-1', scope_type: 'org', scope_id: null, capability: 'admin' }], agentExists: false }))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('agent_not_found')
  })

  it('requires a bearer token', async () => {
    const res = await orient({}, makeEnv({ boundAgentId: AGENT.id }), false)
    expect(res.status).toBe(401)
  })
})

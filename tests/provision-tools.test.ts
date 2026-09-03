import { describe, expect, it } from 'vitest'
import { done, mcpApp } from '../src/mcp'
import type { ToolCtx, ToolSpec } from '../src/mcp'
import { callerCanGrantAgentCapability, PROVISION_TOOLS } from '../src/mcp/provision'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../src/types'

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
  guardedGrantNoRow?: boolean
  events?: unknown[]
  publicOrigin?: string | null
  boundAgentId?: string | null
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
  let accessMembership = existingGrantCapabilities.length > 0
    ? {
        id: 'existing-membership-id',
        agent_id: AGENT.id,
        squad_id: TARGET_SQUAD.id,
        capability: existingGrantCapabilities[0],
      }
    : null
  let accessCapability: Capability | null = existingGrantCapabilities[0] ?? null

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
          if (sql.includes('LEFT JOIN agent_member_bindings')) {
            return {
              home_squad_id: AGENT.squad_id,
              bound_member_id: agentTokenMembers[0] ?? null,
            }
          }
          if (sql.includes('FROM agent_member_bindings')) {
            const member_id = agentTokenMembers[0]
            return member_id === undefined ? null : { member_id }
          }
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
          if (sql.includes('SELECT squad_id AS home_squad_id FROM agents')) {
            return agentExists ? { home_squad_id: AGENT.squad_id } : null
          }
          if (sql.includes('FROM agents') && byId) {
            return agentExists && ref === AGENT.id ? agentRow : null
          }
          if (sql.includes('SELECT id FROM squads WHERE id')) {
            return squadExists ? { id: ref } : null
          }
          if (sql.includes('FROM memberships')) return accessMembership
          if (sql.includes('SELECT capability') && sql.includes('FROM capabilities')) {
            return accessCapability === null ? null : { capability: accessCapability }
          }
          if (sql.includes('SELECT member_id, scope_type, scope_id, capability')) {
            return accessCapability === null
              ? null
              : {
                  member_id: agentTokenMembers[0],
                  scope_type: 'squad',
                  scope_id: TARGET_SQUAD.id,
                  capability: accessCapability,
                }
          }
          return null
        },
        async all() {
          if (sql.includes('WITH active_identity AS MATERIALIZED')) {
            const distinctMembers = [...new Set(agentTokenMembers)]
            if (opts.guardedGrantNoRow || distinctMembers.length !== 1 || distinctMembers[0] !== args[2]) {
              return { results: [] }
            }
            const createdId = args[3] as string
            const updatedId = args[6] as string
            const capability = args[5] as Capability
            const returnedId = existingGrantCapabilities.length === 0
              ? createdId
              : existingGrantCapabilities.length === 1 && existingGrantCapabilities[0] === capability
                ? 'existing-grant-id'
                : updatedId
            captured.push({
              sql: 'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)',
              args: [returnedId, args[2], 'squad', args[4], capability],
            })
            return {
              results: [{
                id: returnedId,
                member_id: args[2],
                scope_type: 'squad',
                scope_id: args[4],
                capability,
              }],
            }
          }
          if (sql.includes('SELECT capability FROM capabilities')) {
            return { results: existingGrantCapabilities.map((capability) => ({ capability })) }
          }
          if (sql.includes('FROM capabilities')) return { results: grants }
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
    PUBLIC_ORIGIN: opts.publicOrigin === null
      ? undefined
      : (opts.publicOrigin ?? 'https://agents.digid.ca'),
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare: (sql: string) => handler(sql),
      // atomic mint runs member+capability+token as one batch; record each INSERT.
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        if (
          stmts.length === 2
          && stmts[0].sql.includes('INSERT INTO memberships')
          && stmts[1].sql.includes('INSERT INTO capabilities')
        ) {
          if (opts.guardedGrantNoRow) {
            return stmts.map(() => ({ meta: { changes: 0 } }))
          }
          accessMembership = {
            id: stmts[0].args[0] as string,
            agent_id: stmts[0].args[1] as string,
            squad_id: stmts[0].args[2] as string,
            capability: stmts[0].args[3] as Capability,
          }
          accessCapability = stmts[1].args[3] as Capability
          captured.push({ sql: stmts[0].sql, args: stmts[0].args })
          captured.push({
            sql: 'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)',
            args: [stmts[1].args[0], stmts[1].args[1], 'squad', stmts[1].args[2], stmts[1].args[3]],
          })
          return stmts.map(() => ({ meta: { changes: 1 } }))
        }
        for (const s of stmts) if (s.sql.includes('INSERT INTO')) captured.push({ sql: s.sql, args: s.args })
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
    },
    BUS: { send: async (event: unknown) => { opts.events?.push(event) } },
    // mupot#987: mint_agent_token stores the raw secret behind a one-time claim
    // in SESSIONS KV (src/auth/credential-claim.ts) instead of returning it —
    // needs a real in-memory store, not a stub.
    SESSIONS: (() => {
      const store = new Map<string, string>()
      return {
        async get(key: string) { return store.get(key) ?? null },
        async put(key: string, value: string) { store.set(key, value) },
        async delete(key: string) { store.delete(key) },
      }
    })(),
  } as unknown as Env
}

async function call(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  auth = true,
  requestOrigin = 'https://agents.digid.ca',
) {
  return mcpApp.request(
    `${requestOrigin}/`,
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
    expect(names).toContain('provision_agent_connection')
    expect(names).toContain('verify_agent_connection')
    expect(names).toContain('register_agent_key')
    expect(names).toContain('grant_agent_capability')
    expect(names).toContain('squad_member_add')
    expect(names).toContain('squad_member_remove')
    expect(names).toContain('squad_member_list')
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
        capability: { type: 'string', enum: ['observer', 'member', 'lead', 'admin'] },
      },
      required: ['agent', 'squad', 'capability'],
      additionalProperties: false,
    })
  })

  it('refuses agent-bound callers on provision, mint, and grant surfaces', async () => {
    for (const [name, args] of [
      ['mint_agent_token', { agent: AGENT.id }],
      ['grant_agent_capability', {
        agent: AGENT.id,
        squad: TARGET_SQUAD.id,
        capability: 'member',
      }],
      ['provision_agent_connection', {
        request_id: 'agent-self-provision',
        existing_agent: AGENT.id,
        credential: { action: 'add' },
      }],
    ] as const) {
      const captured: Captured[] = []
      const response = await call(
        name,
        args,
        makeEnv({ boundAgentId: 'agent-caller' }, captured),
      )
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { message: string } }).error.message)
        .toBe('operator_principal_required')
      expect(captured).toEqual([])
    }
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
    expect(cap.some((c) => /INSERT INTO members\s*\(/.test(c.sql))).toBe(false)
    expect(cap.some((c) => c.sql.includes('INSERT INTO agent_member_bindings'))).toBe(false)
    expect(cap.some((c) => c.sql.includes('INSERT INTO capabilities'))).toBe(false)
    expect(cap.some((c) => c.sql.includes('INSERT INTO member_tokens'))).toBe(false)
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
    const env = makeEnv({ agentTokenMembers: [] }, cap)
    // Fresh agent (no prior member) so the FIRST mint creates the member + guard cap.
    const res = await call('mint_agent_token', { agent: 'growth-lead' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          token: { agent_id: string; capability: string }
          credential_claim: { claim_id: string; fingerprint: string; expires_at: string }
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
    // mupot#987: the raw token must NEVER be in this tool result — structural
    // proof, not a field-by-field allowlist.
    expect(JSON.stringify(body)).not.toMatch(/"raw"\s*:/)
    expect(sc.credential_claim.claim_id).toBeTruthy()
    expect(sc.credential_claim.fingerprint).toMatch(/^[0-9a-f]{16}$/)

    // The claim redeems exactly once, as the same caller who minted it.
    const revealRes = await call('reveal_credential_claim', { claim_id: sc.credential_claim.claim_id }, env)
    expect(revealRes.status).toBe(200)
    const revealBody = (await revealRes.json()) as { result: { structuredContent: { raw: string } } }
    expect(revealBody.result.structuredContent.raw.startsWith('mupot_')).toBe(true)

    const secondReveal = await call('reveal_credential_claim', { claim_id: sc.credential_claim.claim_id }, env)
    expect(secondReveal.status).toBe(410)

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
      makeEnv({ agentTokenMembers: [] }, observerRows),
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

  it('reuses the canonical member and committed home capability on an additional credential', async () => {
    const rows: Captured[] = []
    const res = await call(
      'mint_agent_token',
      { agent: AGENT.slug, capability: 'member' },
      makeEnv({ existingGrantCapabilities: ['observer'] }, rows),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { token: { member_id: string; capability: string } } }
    }
    expect(body.result.structuredContent.token).toMatchObject({
      member_id: 'member-agent-1',
      capability: 'observer',
    })
    expect(rows.filter(({ sql }) => sql.includes('INSERT INTO member_tokens'))).toHaveLength(1)
    expect(rows.some(({ sql }) => /INSERT INTO members\s*\(/.test(sql))).toBe(false)
    expect(rows.some(({ sql }) => sql.includes('INSERT INTO agent_member_bindings'))).toBe(false)
    expect(rows.some(({ sql }) => sql.includes('INSERT INTO capabilities'))).toBe(false)
  })

  it('requires a safe pinned origin before minting and ignores a malicious request host', async () => {
    for (const publicOrigin of [null, 'http://evil.example']) {
      const rows: Captured[] = []
      const res = await call(
        'mint_agent_token',
        { agent: AGENT.slug },
        makeEnv({ agentTokenMembers: [], publicOrigin }, rows),
      )
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { message: string } }).error.message)
        .toBe('public_origin_unconfigured')
      expect(rows).toEqual([])
    }

    const res = await call(
      'mint_agent_token',
      { agent: AGENT.slug },
      makeEnv({ agentTokenMembers: [], publicOrigin: 'https://pot.example' }),
      true,
      'https://evil.example',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { mcp_endpoint: string; wake_contract: { emit_url: string } } }
    }
    expect(body.result.structuredContent.mcp_endpoint).toBe('https://pot.example/mcp')
    expect(body.result.structuredContent.wake_contract.emit_url).toBe('https://pot.example/bus/emit')
    expect(JSON.stringify(body)).not.toContain('evil.example')
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

  it('refuses squad-admin rotation before agent lookup without an existence oracle', async () => {
    const grants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: SQUAD.id, capability: 'admin' },
    ]
    const cases = [
      { agent: AGENT.slug, env: makeEnv({ grants }) },
      { agent: 'ghost', env: makeEnv({ grants, agentExists: false }) },
      { agent: 'dup', env: makeEnv({ grants }) },
    ]

    const responses = await Promise.all(cases.map(({ agent, env }) => call(
      'mint_agent_token',
      { agent, rotate_prior_token_id: 'opaque-prior-id' },
      env,
    )))
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{
      error: { message: string; data?: unknown }
    }>

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403])
    expect(bodies.map((body) => body.error.message)).toEqual(['forbidden', 'forbidden', 'forbidden'])
    expect(bodies.map((body) => body.error.data)).toEqual([
      { need: 'admin', scope: 'org' },
      { need: 'admin', scope: 'org' },
      { need: 'admin', scope: 'org' },
    ])
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

  it('refuses to create a key before the canonical agent identity exists', async () => {
    const captured: Captured[] = []
    const res = await call(
      'register_agent_key',
      { agent: AGENT.slug, public_key: publicKey },
      makeEnv({ agentTokenMembers: [] }, captured),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message)
      .toBe('agent_identity_unminted')
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
    expect(captured.find((row) => row.sql.includes('INSERT INTO memberships'))?.args.slice(1, 3)).toEqual([
      AGENT.id,
      TARGET_SQUAD.id,
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

  it('reports a receipt failure when the guarded write returns no row but identity is unchanged', async () => {
    const captured: Captured[] = []
    const res = await call(
      'grant_agent_capability',
      args,
      makeEnv({ guardedGrantNoRow: true }, captured),
    )
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('receipt_failed')
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

  it('writes the requested capability on the home squad (memberships clamp removed, mupot#1161)', async () => {
    const captured: Captured[] = []
    const res = await call(
      'grant_agent_capability',
      { agent: AGENT.slug, squad: SQUAD.id, capability: 'lead' },
      makeEnv({}, captured),
    )
    expect(res.status).toBe(200)
    expect(captured.find((row) => row.sql.includes('INSERT INTO memberships'))?.args[3]).toBe('lead')
    expect(captured.find((row) => row.sql.includes('INSERT INTO capabilities'))?.args[4]).toBe('lead')
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

  it('retains the target-squad admin gate for a caller limited to lead', async () => {
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

describe('grant_agent_capability authorization ceiling', () => {
  it('evaluates requested capability against the caller effective target-squad grants', () => {
    const leadGrants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: TARGET_SQUAD.id, capability: 'lead' },
    ]
    const adminGrants: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: TARGET_SQUAD.id, capability: 'admin' },
    ]

    expect(callerCanGrantAgentCapability(leadGrants, TARGET_SQUAD, 'lead')).toBe(true)
    expect(callerCanGrantAgentCapability(leadGrants, TARGET_SQUAD, 'admin')).toBe(false)
    expect(callerCanGrantAgentCapability(adminGrants, TARGET_SQUAD, 'admin')).toBe(true)
  })
})

// ── operator-principal invariant — exhaustive by construction ────────────────
//
// mupot P0 (2026-08-09): register_agent_key was missing the operator-principal
// check every sibling credential/capability tool carries. It was unreachable
// while no bound agent could hold admin — that admin gate WAS the implicit
// operator check. Migration 0087 drops the home_capability_ceiling triggers,
// so a bound agent can now hold admin on its own squad, and the missing check
// became a live peer-identity-capture path (register a key for a keyless peer
// → hasRegisteredKey() closes that peer's bearer attach path → attacker holds
// the only private key for the victim's agent id).
//
// The bug survived because the old test (below, "refuses agent-bound callers
// on provision, mint, and grant surfaces") hand-enumerated THREE tools and
// silently stopped covering the rest. A hand-maintained list can always drift
// behind the real registry. This block replaces that pattern: it drives every
// tool the module actually registers (PROVISION_TOOLS, not a literal copied
// into the test) and requires each one to either enforce the guard or be
// named — with a reason — on the exemption list below. A new tool that omits
// the check needs no test update to be caught; it fails this test on its own.
describe('provision tools — operator-principal invariant is exhaustive', () => {
  // Every entry here is a considered exception, not a gap. Each is backed by
  // its own dedicated coverage elsewhere, so removing an entry without also
  // changing the tool's run() will fail THIS test, and adding the guard back
  // without removing the entry changes nothing (the tool would just pass both
  // ways) — the pairing is what keeps the list honest.
  const OPERATOR_PRINCIPAL_EXEMPT: ReadonlySet<string> = new Set([
    // Read-only, pot-internal metadata disclosure gated at the 'observer'
    // FLOOR (see the block comments on these two tools in provision.ts). No
    // write, no credential, no peer-identity mutation — never in scope for
    // this guard.
    'resolve_agent',
    'get_agent_profile',
    // CREATE new org structure the caller already holds admin/lead on. These
    // never touch an EXISTING peer's identity or credential — the attack
    // this guard defends against (capturing/locking out a peer agent) does
    // not apply to minting a brand-new row. Matches the dashboard HTTP
    // equivalent (src/org/index.ts POST /squads/:id/agents), which has no
    // operator_principal_required check either — same design, same surface.
    'create_department',
    'create_squad',
    'create_agent',
    // Read-only membership listing. Observer+ on the target squad. No write.
    'squad_member_list',
    // Deliberately allows one bound agent to deactivate ANOTHER agent —
    // only self-deactivation is blocked (see the 'cannot_deactivate_self'
    // guard in toolDeactivateAgent and the explicit assertion in
    // tests/deactivate-agent.test.ts: "allows a different agent-bound token
    // to deactivate this agent" → 200). This is an existing, tested product
    // decision, not an oversight uncovered by this audit — flagged for
    // Kasra-core to re-examine now that 0087 makes it reachable by more
    // callers than before, but not silently changed here.
    'deactivate_agent',
    // mupot#1288: update_agent grew a SELF LANE — an agent-bound caller
    // correcting its OWN row (auth.boundAgentId === the resolved agent's id)
    // acts on its own authority, no admin required. Deciding self-vs-other
    // needs `agent` resolved first, so the operator-principal refusal can no
    // longer be the literal first statement in run() (this loop calls every
    // tool with EMPTY args, which the self lane can't classify without an
    // `agent` to resolve). The guard itself is NOT gone: an agent-bound
    // caller targeting a DIFFERENT agent's row still gets
    // operator_principal_required, and the self lane has its own admin-field
    // gate (SELF_FORBIDDEN_FIELDS) rejecting slug/owner/qnft_ref/capabilities/
    // budget_cap_cents/budget_window even on the caller's own row. Exhaustive
    // coverage of both axes — self-allowed, self-forbidden-fields, other-agent
    // still refused, admin path unchanged — lives in
    // tests/agent-self-update.test.ts, not here.
    'update_agent',
  ])

  const boundAgentAuth: AuthContext = {
    userId: 'agent-caller',
    email: null,
    role: 'member',
    tenant: 'digid',
    memberId: 'member-agent-1',
    capabilities: [
      // Worst case: the bound agent's own home identity holds org:admin —
      // exactly what migration 0087 makes reachable. If the guard is
      // missing, this grant is enough to sail past every downstream
      // capability check, so a false pass here cannot hide behind "the
      // capability gate would have caught it anyway."
      { member_id: 'member-agent-1', scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
    boundAgentId: 'agent-caller',
  }
  const ctx: ToolCtx = { origin: 'https://agents.digid.ca' }

  // Args deliberately empty: the guard must be the FIRST statement in run(),
  // before any argument is even read, so it must fire on a call carrying no
  // arguments at all. Calling tool.run() directly (bypassing the JSON-RPC /
  // inputSchema seam) means this loop needs no per-tool argument fixtures —
  // which is what lets it generalize to a tool that doesn't exist yet.
  async function isGuarded(tool: ToolSpec, env: Env): Promise<boolean> {
    const outcome = await tool.run(boundAgentAuth, env, {}, ctx)
    return outcome.ok === false && outcome.status === 403 && outcome.error === 'operator_principal_required'
  }

  it('every registered provision tool is either guarded or an explicit, commented exemption', () => {
    const names = new Set(PROVISION_TOOLS.map((t) => t.name))
    for (const exempt of OPERATOR_PRINCIPAL_EXEMPT) {
      expect(names.has(exempt)).toBe(true) // catches a stale/typo'd exemption entry
    }
  })

  it('every non-exempt tool refuses a bound-agent caller as the first statement in run()', async () => {
    const env = makeEnv()
    const ungated: string[] = []
    for (const tool of PROVISION_TOOLS) {
      if (OPERATOR_PRINCIPAL_EXEMPT.has(tool.name)) continue
      if (!(await isGuarded(tool, env))) ungated.push(tool.name)
    }
    expect(ungated).toEqual([])
  })

  it('catches a newly-added tool that forgets the guard (regression simulation)', async () => {
    // Structurally identical to a real provision tool — reads args, checks a
    // squad-admin capability — but omits the operator_principal_required
    // line, i.e. exactly the register_agent_key bug this suite exists to
    // catch. Appended to a COPY of the real registry (the real one is never
    // mutated) so this test proves the loop above actually fails on a
    // regression instead of vacuously passing every run.
    const forgotTheGuard: ToolSpec = {
      name: 'simulated_new_tool_missing_guard',
      scope: "agent's squad",
      min: 'admin',
      args: '{}',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_auth, _env, _args) {
        return done({ ok: true })
      },
    }
    const registryWithRegression = [...PROVISION_TOOLS, forgotTheGuard]
    const env = makeEnv()
    const ungated: string[] = []
    for (const tool of registryWithRegression) {
      if (OPERATOR_PRINCIPAL_EXEMPT.has(tool.name)) continue
      if (!(await isGuarded(tool, env))) ungated.push(tool.name)
    }
    expect(ungated).toEqual(['simulated_new_tool_missing_guard'])
  })
})

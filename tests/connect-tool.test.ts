import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// connect MCP tool — #128 self-name-to-bind (cold→hot path).
//
// An authorized-but-unbound connection (shared apikey, boundAgentId=null) calls connect
// with its agent_name → mupot resolves the agent, verifies squad access, returns the orient
// packet → the connection is HOT (knows its identity for the session).
//
// Security invariants:
//   - Never fabricates or auto-creates agents. Agent must already exist.
//   - Caller must have squad-member capability on the agent's squad (or be org-admin).
//   - Binding is session-local: no write to member_tokens.agent_id.
//   - agent_name is a claim only; capability check authorizes it.
//
// QA findings from live connector boot (#128):
//   QA-1: Every refusal carries next_step — tested via boot_context unminted + orient dead-end.
//   QA-2: boot_context reports identity_status:"unminted" (D6 covers this — regression guard here).
//   QA-3: Tool description must not contain real tenant slugs (checked via tools/list).

// ── test helpers ──────────────────────────────────────────────────────────────

const SQUAD = { id: 'squad-acme-eng', department_id: 'dept-1' }
const AGENT = {
  id: 'agent-growth-lead',
  squad_id: 'squad-acme-eng',
  slug: 'growth-lead',
  name: 'Growth Lead',
}

interface Opts {
  boundAgentId?: string | null
  grants?: CapabilityGrant[]
  agentExists?: boolean
  ambiguousSlug?: boolean
  /** budget_cap_cents on the agent row (default null). Set non-null to prove redaction. */
  agentBudgetCents?: number | null
}

function makeEnv(opts: Opts = {}): Env {
  const memberId = 'member-bot-1'
  const boundAgentId = opts.boundAgentId ?? null
  const agentExists = opts.agentExists ?? true
  const ambiguousSlug = opts.ambiguousSlug ?? false
  const agentBudgetCents = opts.agentBudgetCents ?? null

  const grants: CapabilityGrant[] = opts.grants ?? [
    // Squad-member capability on the agent's squad (typical shared-apikey scenario)
    { member_id: memberId, scope_type: 'squad', scope_id: SQUAD.id, capability: 'member' },
  ]

  // Orient service queries: tasks, orient data, agents. We return minimal stubs.
  const handler = (sql: string) => ({
    bind(..._args: unknown[]) {
      const bound = _args[0]
      return {
        sql,
        args: _args,
        async first() {
          if (sql.includes('FROM member_tokens')) {
            return {
              member_id: memberId,
              email: null,
              display_name: 'Bot',
              telegram_chat_id: null,
              status: 'active',
              created_at: '2026-06-13 00:00:00',
              channel: 'workspace',
              bound_agent_id: boundAgentId,
            }
          }
          if (sql.includes('FROM squads') && sql.includes('WHERE id')) {
            if (bound === SQUAD.id) return { id: SQUAD.id, name: 'Acme Eng', charter: null, okr: null, department_id: SQUAD.department_id }
            return null
          }
          if (sql.includes('FROM departments') && sql.includes('WHERE id')) {
            return { id: SQUAD.department_id, name: 'Engineering' }
          }
          // orient service full agent SELECT (includes kpi_progress / budget_cap_cents)
          // Must precede the narrow resolveAgentRef check (id+squad_id only) because
          // buildOrient's SELECT also contains WHERE id — distinguisher is kpi_progress.
          if (sql.includes('FROM agents') && sql.includes('kpi_progress')) {
            if (agentExists) {
              return { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name, role: 'engineer', status: 'active', effort: 'standard', autonomy: 'draft', kpi_progress: 0, budget_cap_cents: agentBudgetCents, budget_window: 'day', okr: null, kpi_target: null }
            }
            return null
          }
          // resolveAgentRef narrow lookup (id + squad_id only)
          if (sql.includes('FROM agents') && sql.includes('WHERE id')) {
            if (agentExists && bound === AGENT.id) {
              return { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }
            }
            return null
          }
          if (sql.includes('FROM org_settings')) return null
          return null
        },
        async all() {
          if (sql.includes('FROM capabilities')) return { results: grants }
          if (sql.includes('FROM agents') && sql.includes('WHERE slug')) {
            if (!agentExists) return { results: [] }
            if (ambiguousSlug) {
              // Two agents with same slug in different squads → ambiguous
              return {
                results: [
                  { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name },
                  { id: 'agent-alt', squad_id: 'squad-alt', slug: AGENT.slug, name: 'Alt' },
                ],
              }
            }
            return { results: [{ id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }] }
          }
          // orient service fan-out queries
          if (sql.includes('FROM tasks')) return { results: [] }
          if (sql.includes('FROM squads')) {
            return { results: [{ id: SQUAD.id, department_id: SQUAD.department_id, slug: 'acme-eng', name: 'Acme Eng', charter: null, role: null, okr: null, kpi_target: null, kpi_progress: 0, effort: 'standard', autonomy: 'draft', budget_cap_cents: null, budget_window: 'day', created_at: '2026-06-13' }] }
          }
          if (sql.includes('FROM connectors')) return { results: [] }
          if (sql.includes('FROM capabilities')) return { results: grants }
          return { results: [] }
        },
        async run() { return { meta: { changes: 0 } } },
      }
    },
    // DB.batch support (not used by connect, but keep for safety)
    batch() { return Promise.resolve([]) },
  })

  return {
    TENANT_SLUG: 'acme',       // fictional slug — never a real tenant slug
    BRAND: 'Acme Co',
    OAUTH_PROVIDER: 'google',
    DB: { prepare: (sql: string) => handler(sql) } as unknown as Env['DB'],
    VEC: {
      query: async () => ({ matches: [] }),
    } as unknown as Env['VEC'],
    BUS: { send: async () => {} } as unknown as Env['BUS'],
    SESSIONS: {} as unknown as Env['SESSIONS'],
    OAUTH_KV: {} as unknown as Env['OAUTH_KV'],
    BLOBS: {} as unknown as Env['BLOBS'],
    AI: {} as unknown as Env['AI'],
    AGENT: {} as unknown as Env['AGENT'],
    SQUAD: {} as unknown as Env['SQUAD'],
  } as unknown as Env
}

async function callConnect(env: Env, agentName: string, auth = true) {
  return mcpApp.request(
    'https://mcp.acme-example.co/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer shared-apikey-token' } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'connect', arguments: { agent_name: agentName } },
      }),
    },
    env,
  )
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('connect MCP tool (#128 — self-name-to-bind)', () => {
  // ── happy path ──────────────────────────────────────────────────────────────

  it('advertised in tools/list', async () => {
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string; description: string }[] } }
    const tool = body.result.tools.find((t) => t.name === 'connect')
    expect(tool).toBeDefined()

    // QA-3: no real tenant slugs in the tool description
    const desc = tool!.description
    expect(desc).not.toContain('viamar')
    expect(desc).not.toContain('gaf')
    expect(desc).not.toContain('digid')
    // fictional examples are fine
    expect(desc).toMatch(/growth-lead|researcher|example/)
  })

  it('self-names to bind: authorized unbound connection claims existing agent → HOT', async () => {
    const env = makeEnv({ boundAgentId: null })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      result: {
        structuredContent: {
          connection_status: string
          claimed_agent: { id: string; slug: string; name: string }
          binding: string
          next_step: string
          packet: unknown
          brief: string
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.connection_status).toBe('hot')
    expect(sc.claimed_agent.id).toBe(AGENT.id)
    expect(sc.claimed_agent.slug).toBe(AGENT.slug)
    expect(sc.claimed_agent.name).toBe(AGENT.name)
    expect(sc.binding).toBe('session_local')
    expect(sc.next_step).toMatch(/mint_agent_token/)
    expect(sc.packet).toBeDefined()
    expect(typeof sc.brief).toBe('string')
  })

  it('resolves by agent id (not just slug)', async () => {
    const env = makeEnv({ boundAgentId: null })
    const res = await callConnect(env, AGENT.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { connection_status: string; claimed_agent: { id: string } } }
    }
    expect(body.result.structuredContent.connection_status).toBe('hot')
    expect(body.result.structuredContent.claimed_agent.id).toBe(AGENT.id)
  })

  it('already-minted token can also call connect (no harm — session-local bind succeeds)', async () => {
    const env = makeEnv({ boundAgentId: AGENT.id }) // already minted
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { connection_status: string } }
    }
    expect(body.result.structuredContent.connection_status).toBe('hot')
  })

  // ── rejection cases (the security invariants) ───────────────────────────────

  it('401 without bearer token', async () => {
    const res = await callConnect(makeEnv(), AGENT.slug, false)
    expect(res.status).toBe(401)
  })

  it('agent_name required — missing field rejected', async () => {
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'connect', arguments: {} },
        }),
      },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })

  it('nonexistent agent name → 404 with next_step instruction', async () => {
    const env = makeEnv({ agentExists: false })
    const res = await callConnect(env, 'no-such-agent')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string; data: string } }
    expect(body.error.message).toBe('agent_not_found')
    // QA-1: must carry map out of dead end
    expect(body.error.data).toMatch(/create_agent/)
  })

  it('ambiguous slug → 409 with disambiguation instruction', async () => {
    const env = makeEnv({ ambiguousSlug: true })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { message: string; data: string } }
    expect(body.error.message).toBe('ambiguous_slug')
    // QA-1: must instruct to use id
    expect(body.error.data).toMatch(/id/)
  })

  it('no squad access → 403 (prevents unauthorized agent claim)', async () => {
    // Token has no capabilities at all — cannot claim any agent
    const env = makeEnv({
      grants: [], // empty grants → no squad access
    })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      error: { message: string; data: { reason: string; need: string; scope: string } }
    }
    expect(body.error.message).toBe('forbidden')
    expect(body.error.data.reason).toBe('no_squad_access')
    expect(body.error.data.need).toBe('member')
    // QA-1: must carry guidance
    expect(body.error.data.detail).toMatch(/admin/)
  })

  it('rejects extra fields (additionalProperties: false)', async () => {
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'connect', arguments: { agent_name: AGENT.slug, injected_field: 'attack' } },
        }),
      },
      makeEnv(),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('invalid_args')
  })

  // ── QA finding 1: every refusal carries a next_step / map out ───────────────

  it('QA-1: boot_context unminted next_step mentions connect as the immediate path', async () => {
    const env = makeEnv({ boundAgentId: null })
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'boot_context', arguments: {} },
        }),
      },
      env,
    )
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          identity_status: string
          next_step: string
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('unminted')
    // QA-1: must name connect as the immediate path, not just mint_agent_token
    expect(sc.next_step).toMatch(/connect/)
    expect(sc.next_step).toMatch(/mint_agent_token/)
  })

  it('QA-1: orient without agent arg on unbound token → refusal includes connect instruction', async () => {
    const env = makeEnv({ boundAgentId: null })
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'orient', arguments: {} },
        }),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string; data: string } }
    expect(body.error.message).toBe('invalid_args')
    // QA-1: must mention connect as the named-agent path out of the dead end
    expect(body.error.data).toMatch(/connect/)
  })

  // ── QA finding 2 regression guard (D6 coverage) ─────────────────────────────

  it('QA-2 regression: boot_context always reports identity_status (unminted or minted)', async () => {
    // unminted
    const unmintedEnv = makeEnv({ boundAgentId: null })
    const r1 = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'boot_context', arguments: {} },
        }),
      },
      unmintedEnv,
    )
    const b1 = (await r1.json()) as { result: { structuredContent: { identity_status: string } } }
    expect(b1.result.structuredContent.identity_status).toBe('unminted')

    // minted
    const mintedEnv = makeEnv({ boundAgentId: 'agent-x' })
    const r2 = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'boot_context', arguments: {} },
        }),
      },
      mintedEnv,
    )
    const b2 = (await r2.json()) as { result: { structuredContent: { identity_status: string } } }
    expect(b2.result.structuredContent.identity_status).toBe('minted')
  })

  // ── QA finding 3: no real tenant slugs in any tool description ───────────────

  it('QA-3: tools/list descriptions contain no real tenant slugs (viamar, gaf, digid)', async () => {
    const res = await mcpApp.request(
      'https://mcp.acme-example.co/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string; description: string }[] } }
    for (const tool of body.result.tools) {
      const desc = tool.description
      // Real tenant slugs must never appear in public tool descriptions
      expect(desc, `tool ${tool.name} description leaks real slug "viamar"`).not.toContain('viamar')
      expect(desc, `tool ${tool.name} description leaks real slug "gaf"`).not.toContain(' gaf ')
      expect(desc, `tool ${tool.name} description leaks "gaf)" `).not.toMatch(/\bgaf\b/)
    }
  })

  // ── viewSensitive parity regressions (#128 security fix) ─────────────────────
  //
  // kasra-review DOOR-7 finding: connect hardcoded viewSensitive=true, letting a bare
  // squad-member read a PEER's budget_cap_cents / field state that orient would redact.
  // These three cases lock the corrected parity rule (orgAdmin || isSelf || squad-lead).

  it('SEC: bare squad-member connecting as a PEER gets redacted packet (no budget/field)', async () => {
    // The caller is a bare member on the squad (not lead, not admin, not welded to AGENT).
    // boundAgentId=null (unbound shared key). Connect claims the agent → must be redacted.
    const env = makeEnv({
      boundAgentId: null,             // unbound — isSelf=false
      agentBudgetCents: 9900,         // $99 budget; must be hidden from the peer
      grants: [
        { member_id: 'member-bot-1', scope_type: 'squad', scope_id: SQUAD.id, capability: 'member' },
      ],
    })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      result: {
        structuredContent: {
          connection_status: string
          packet: { agent: { budget_cap_cents: number | null }; field_restricted?: boolean }
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.connection_status).toBe('hot')
    // sensitive fields must be redacted — peer budget hidden, field restricted
    expect(sc.packet.agent.budget_cap_cents).toBeNull()
    expect(sc.packet.field_restricted).toBe(true)
  })

  it('SEC: self-connect (welded token, isSelf=true) gets full unredacted packet', async () => {
    // The token is permanently welded to AGENT.id — this IS the agent connecting as itself.
    const env = makeEnv({
      boundAgentId: AGENT.id,         // isSelf=true → viewSensitive=true
      agentBudgetCents: 5000,
      grants: [
        { member_id: 'member-bot-1', scope_type: 'squad', scope_id: SQUAD.id, capability: 'member' },
      ],
    })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      result: {
        structuredContent: {
          connection_status: string
          packet: { agent: { budget_cap_cents: number | null }; field_restricted?: boolean }
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.connection_status).toBe('hot')
    // isSelf → full packet, budget and field visible
    expect(sc.packet.agent.budget_cap_cents).toBe(5000)
    expect(sc.packet.field_restricted).toBe(false)
  })

  it('SEC: cross-squad capability claim → 403 (member on squad-B cannot claim agent on squad-A)', async () => {
    // The caller has member capability on squad-OTHER (squad-B), but AGENT lives on SQUAD.id
    // (squad-A). connect must 403 — no squad access on the target agent's squad.
    const env = makeEnv({
      boundAgentId: null,
      grants: [
        // capability on a DIFFERENT squad — not the agent's squad
        { member_id: 'member-bot-1', scope_type: 'squad', scope_id: 'squad-other', capability: 'member' },
      ],
    })
    const res = await callConnect(env, AGENT.slug)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string; data: { reason: string } } }
    expect(body.error.message).toBe('forbidden')
    expect(body.error.data.reason).toBe('no_squad_access')
  })
})

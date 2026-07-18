import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

const MEMBER_ID = 'member-manager'
const SQUAD_ID = 'squad-dme'
const OTHER_SQUAD_ID = 'squad-other'

interface Captured {
  sql: string
  args: unknown[]
}

function managerAuth(): AuthContext {
  const capabilities: CapabilityGrant[] = [
    {
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    },
  ]
  return {
    userId: 'user-manager',
    email: null,
    role: 'member',
    tenant: 'dme-temp',
    channel: 'workspace',
    memberId: MEMBER_ID,
    capabilities,
    boundAgentId: 'agent-manager',
  }
}

function multiSquadManagerAuth(): AuthContext {
  const auth = managerAuth()
  return {
    ...auth,
    capabilities: [
      ...(auth.capabilities ?? []),
      {
        member_id: MEMBER_ID,
        scope_type: 'squad',
        scope_id: OTHER_SQUAD_ID,
        capability: 'member',
      },
    ],
  }
}

function orgOnlyManagerAuth(): AuthContext {
  const auth = managerAuth()
  return {
    ...auth,
    capabilities: [
      {
        member_id: MEMBER_ID,
        scope_type: 'org',
        scope_id: null,
        capability: 'admin',
      },
    ],
  }
}

function managerEnv(
  options: {
    surfaceGrant?: boolean
    credentialSurfaceGrant?: boolean
    failAudit?: boolean
    mintReplay?: { agent_id: string; token_id: string; detail: string; recorded_at: string }
  } = {},
  captured: Captured[] = [],
): Env {
  const surfaceGrant = options.surfaceGrant ?? true
  const credentialSurfaceGrant = options.credentialSurfaceGrant ?? true
  const rows = [
    {
      id: 'agent-manager',
      squad_id: SQUAD_ID,
      slug: 'admin',
      name: 'Main Hermes Manager',
      role: 'admin',
      model: 'gpt-5.6-sol',
      status: 'active',
      created_at: '2026-07-16T00:00:00Z',
    },
    {
      id: 'agent-worker',
      squad_id: SQUAD_ID,
      slug: 'outreach-researcher',
      name: 'Outreach Researcher',
      role: 'member',
      model: 'gpt-5.6-sol',
      status: 'active',
      created_at: '2026-07-16T00:00:00Z',
    },
    {
      id: 'agent-other',
      squad_id: OTHER_SQUAD_ID,
      slug: 'other',
      name: 'Other Squad Agent',
      role: 'member',
      model: 'gpt-5.6-sol',
      status: 'active',
      created_at: '2026-07-16T00:00:00Z',
    },
  ]

  return {
    TENANT_SLUG: 'dme-temp',
    BRAND: 'DME',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              sql,
              args,
              async first() {
                if (sql.includes('FROM gate_grants')) {
                  if (args[1] === 'agents:manage') return surfaceGrant ? { 1: 1 } : null
                  if (args[1] === 'agents:credentials') return credentialSurfaceGrant ? { 1: 1 } : null
                  return null
                }
                if (sql.includes('FROM agent_manager_audit')) return options.mintReplay ?? null
                if (sql.includes('SELECT COUNT(*) AS n FROM agents')) return { n: 0 }
                if (sql.includes('FROM member_tokens') && sql.includes('JOIN agents')) {
                  if (args[0] === 'token-worker') {
                    return { id: 'token-worker', member_id: 'member-worker-token', agent_id: 'agent-worker', squad_id: SQUAD_ID, revoked_at: null }
                  }
                  if (args[0] === 'token-current') {
                    return { id: 'token-current', member_id: MEMBER_ID, agent_id: 'agent-manager', squad_id: SQUAD_ID, revoked_at: null }
                  }
                  if (args[0] === 'token-other') {
                    return { id: 'token-other', member_id: 'member-other-token', agent_id: 'agent-other', squad_id: OTHER_SQUAD_ID, revoked_at: null }
                  }
                  return null
                }
                if (sql.includes('FROM agents') && sql.includes('WHERE id')) {
                  return rows.find((row) => row.id === args[0]) ?? null
                }
                if (sql.includes('FROM squads') && (args[0] === SQUAD_ID || args[0] === OTHER_SQUAD_ID)) {
                  return {
                    id: args[0],
                    department_id: args[0] === SQUAD_ID ? 'dept-dme' : 'dept-other',
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM gate_grants')) {
                  return { results: surfaceGrant ? [{ capability: 'agents:manage' }] : [] }
                }
                if (sql.includes('FROM member_tokens') && sql.includes('agent_id IN')) {
                  return {
                    results: args[0] === SQUAD_ID
                      ? [{ id: 'token-worker', agent_id: 'agent-worker', label: 'worker-runtime', channel: 'workspace', created_at: '2026-07-16T00:00:00Z', revoked_at: null }]
                      : [{ id: 'token-other', agent_id: 'agent-other', label: 'other-runtime', channel: 'workspace', created_at: '2026-07-16T00:00:00Z', revoked_at: null }],
                  }
                }
                if (sql.includes('FROM agents') && sql.includes('WHERE squad_id')) {
                  return { results: rows.filter((row) => row.squad_id === args[0]) }
                }
                return { results: [] }
              },
              async run() {
                if (/^\s*INSERT INTO agents/.test(sql)) captured.push({ sql, args })
                if (/^\s*INSERT INTO agent_manager_audit/.test(sql)) captured.push({ sql, args })
                if (/^\s*UPDATE agents SET status/.test(sql)) captured.push({ sql, args })
                if (/^\s*UPDATE member_tokens SET revoked_at/.test(sql)) captured.push({ sql, args })
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
      async batch(statements: { sql: string; args: unknown[] }[]) {
        if (options.failAudit && statements.some(({ sql }) => /^\s*INSERT INTO agent_manager_audit/.test(sql))) {
          throw new Error('simulated audit persistence failure')
        }
        for (const statement of statements) captured.push({ sql: statement.sql, args: statement.args })
        return statements.map(() => ({ meta: { changes: 1 } }))
      },
    },
  } as unknown as Env
}

describe('squad agent manager', () => {
  it('manager status proves the authenticated member has the surface grant on this squad', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_status',
      { squad_id: SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        enabled: true,
        surface: 'agents:manage',
        squad_id: SQUAD_ID,
        actor_member_id: MEMBER_ID,
        bound_agent_id: 'agent-manager',
      },
    })
  })

  it('lists only agents in a squad where the token is a member and has agents:manage', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_list',
      { squad_id: SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: true, tool: 'agent_manager_list' })
    if (!outcome.ok) throw new Error('expected manager list to succeed')
    expect(outcome.result).toMatchObject({
      squad_id: SQUAD_ID,
      agents: [
        { id: 'agent-manager', squad_id: SQUAD_ID },
        { id: 'agent-worker', squad_id: SQUAD_ID },
      ],
      tokens: [
        { id: 'token-worker', agent_id: 'agent-worker', label: 'worker-runtime', revoked_at: null },
      ],
    })
    expect(JSON.stringify(outcome.result)).not.toContain('agent-other')
    expect(JSON.stringify(outcome.result)).not.toMatch(/token_hash|raw/)
  })

  it('denies a squad member that lacks the explicit agents:manage surface grant', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({ surfaceGrant: false }),
      'agent_manager_list',
      { squad_id: SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'agents:manage' },
    })
  })

  it('does not let inherited org or department rank substitute for exact squad membership', async () => {
    const outcome = await invokeTool(
      orgOnlyManagerAuth(),
      managerEnv(),
      'agent_manager_list',
      { squad_id: SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'member', scope: 'squad', exact: true },
    })
  })

  it('requires a separate credential surface grant for mint and revoke', async () => {
    const attempts: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: 'agent_manager_mint_token',
        args: { squad_id: SQUAD_ID, agent_id: 'agent-worker', request_id: 'credential-gate-001' },
      },
      {
        tool: 'agent_manager_revoke_token',
        args: { squad_id: SQUAD_ID, token_id: 'token-worker' },
      },
    ]

    for (const attempt of attempts) {
      const outcome = await invokeTool(
        managerAuth(),
        managerEnv({ credentialSurfaceGrant: false }),
        attempt.tool,
        attempt.args,
        'https://mupot.example',
      )
      expect(outcome).toMatchObject({
        ok: false,
        status: 403,
        error: 'forbidden',
        detail: { need: 'agents:credentials' },
      })
    }
  })

  it('does not let owner or admin rank bypass the explicit agents:manage grant', async () => {
    const elevated = { ...managerAuth(), role: 'owner' as const }
    const outcome = await invokeTool(
      elevated,
      managerEnv({ surfaceGrant: false }),
      'agent_manager_list',
      { squad_id: SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'agents:manage' },
    })
  })

  it('fails all lifecycle mutations atomically when the audit receipt cannot persist', async () => {
    const attempts: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'agent_manager_create', args: { squad_id: SQUAD_ID, slug: 'atomic-worker', name: 'Atomic Worker' } },
      { tool: 'agent_manager_set_status', args: { squad_id: SQUAD_ID, agent_id: 'agent-worker', status: 'paused' } },
      { tool: 'agent_manager_mint_token', args: { squad_id: SQUAD_ID, agent_id: 'agent-worker', request_id: 'atomic-mint-001' } },
      { tool: 'agent_manager_revoke_token', args: { squad_id: SQUAD_ID, token_id: 'token-worker' } },
    ]

    for (const attempt of attempts) {
      const captured: Captured[] = []
      const outcome = await invokeTool(
        managerAuth(),
        managerEnv({ failAudit: true }, captured),
        attempt.tool,
        attempt.args,
        'https://mupot.example',
      )
      expect(outcome).toMatchObject({ ok: false, status: 500, error: 'internal_error' })
      expect(captured).toEqual([])
    }
  })

  it('denies a manager targeting a squad where its token is not a member', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_list',
      { squad_id: OTHER_SQUAD_ID },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'member', scope: 'squad' },
    })
  })

  it('creates only a member-role agent in the authorized squad', async () => {
    const captured: Captured[] = []
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({}, captured),
      'agent_manager_create',
      { squad_id: SQUAD_ID, slug: 'researcher-2', name: 'Researcher Two', model: 'gpt-5.6-sol' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      tool: 'agent_manager_create',
      result: {
        agent: {
          squad_id: SQUAD_ID,
          slug: 'researcher-2',
          role: 'member',
          status: 'active',
        },
      },
    })
    const insert = captured.find(({ sql }) => /^\s*INSERT INTO agents/.test(sql))
    expect(insert?.args).toContain('member')
    expect(insert?.args).toContain(SQUAD_ID)
    const audit = captured.find(({ sql }) => /^\s*INSERT INTO agent_manager_audit/.test(sql))
    expect(audit?.args).toContain('create')
    expect(JSON.stringify(audit?.args)).not.toMatch(/mupot_|token_hash/)
  })

  it('pauses an agent in the authorized squad', async () => {
    const captured: Captured[] = []
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({}, captured),
      'agent_manager_set_status',
      { squad_id: SQUAD_ID, agent_id: 'agent-worker', status: 'paused' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      tool: 'agent_manager_set_status',
      result: { agent: { id: 'agent-worker', squad_id: SQUAD_ID, status: 'paused' } },
    })
    expect(captured).toContainEqual({
      sql: 'UPDATE agents SET status = ? WHERE id = ?',
      args: ['paused', 'agent-worker'],
    })
    const statusAudit = captured.find(({ sql }) => /^\s*INSERT INTO agent_manager_audit/.test(sql))
    expect(statusAudit?.args).toContain('set_status')
    expect(statusAudit?.sql).toContain('WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND squad_id = ? AND status = ?)')
    expect(statusAudit?.args.slice(-3)).toEqual(['agent-worker', SQUAD_ID, 'paused'])
  })

  it('cannot pause its own bound agent identity', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_set_status',
      { squad_id: SQUAD_ID, agent_id: 'agent-manager', status: 'paused' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 409, error: 'self_management_forbidden' })
  })

  it('cannot pause an agent in another squad even when the manager belongs to both squads', async () => {
    const outcome = await invokeTool(
      multiSquadManagerAuth(),
      managerEnv(),
      'agent_manager_set_status',
      { squad_id: SQUAD_ID, agent_id: 'agent-other', status: 'paused' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 404, error: 'agent_not_found' })
  })

  it('rejects agent statuses other than active or paused', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_set_status',
      { squad_id: SQUAD_ID, agent_id: 'agent-worker', status: 'deleted' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_status' })
  })

  it('mints a show-once worker credential hard-capped to member on the agent squad', async () => {
    const captured: Captured[] = []
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({}, captured),
      'agent_manager_mint_token',
      { squad_id: SQUAD_ID, agent_id: 'agent-worker', request_id: 'worker-runtime-001', label: 'worker-runtime' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      tool: 'agent_manager_mint_token',
      result: {
        token: {
          agent_id: 'agent-worker',
          capability: 'member',
          label: 'worker-runtime',
        },
      },
    })
    if (!outcome.ok) throw new Error('expected token mint to succeed')
    const result = outcome.result as { token: { raw: string } }
    expect(result.token.raw).toMatch(/^mupot_/)

    const capabilityInsert = captured.find(({ sql }) => sql.includes('INSERT INTO capabilities'))
    expect(capabilityInsert?.args).toContain(SQUAD_ID)
    expect(capabilityInsert?.args).toContain('member')
    expect(capabilityInsert?.args).not.toContain('admin')
    expect(capabilityInsert?.args).not.toContain('owner')

    const tokenInsert = captured.find(({ sql }) => sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert?.args).toContain('agent-worker')
    expect(tokenInsert?.args).toContain('dme-temp')
    const audit = captured.find(({ sql }) => /^\s*INSERT INTO agent_manager_audit/.test(sql))
    expect(audit?.args).toContain('mint_token')
    expect(JSON.stringify(audit?.args)).not.toContain(result.token.raw)
  })

  it('replays only safe metadata for an exact retry of a committed mint operation', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({
        mintReplay: {
          agent_id: 'agent-worker',
          token_id: 'token-prior-worker',
          detail: JSON.stringify({ label: 'worker-runtime', capability: 'member' }),
          recorded_at: '2026-07-16T00:00:00Z',
        },
      }),
      'agent_manager_mint_token',
      {
        squad_id: SQUAD_ID,
        agent_id: 'agent-worker',
        request_id: 'worker-runtime-001',
        label: 'worker-runtime',
      },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        replayed: true,
        secret_available: false,
        token: { id: 'token-prior-worker', agent_id: 'agent-worker', label: 'worker-runtime' },
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('raw')
  })

  it('rejects reuse of a mint operation ID for a different agent or label', async () => {
    const conflicts = [
      {
        agent_id: 'agent-other',
        token_id: 'token-prior-other',
        detail: JSON.stringify({ label: 'worker-runtime', capability: 'member' }),
        recorded_at: '2026-07-16T00:00:00Z',
      },
      {
        agent_id: 'agent-worker',
        token_id: 'token-prior-label',
        detail: JSON.stringify({ label: 'different-label', capability: 'member' }),
        recorded_at: '2026-07-16T00:00:00Z',
      },
    ]

    for (const mintReplay of conflicts) {
      const outcome = await invokeTool(
        managerAuth(),
        managerEnv({ mintReplay }),
        'agent_manager_mint_token',
        {
          squad_id: SQUAD_ID,
          agent_id: 'agent-worker',
          request_id: 'worker-runtime-001',
          label: 'worker-runtime',
        },
        'https://mupot.example',
      )
      expect(outcome).toMatchObject({ ok: false, status: 409, error: 'idempotency_conflict' })
    }
  })

  it('rejects attempts to choose a higher capability during manager mint', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_mint_token',
      { squad_id: SQUAD_ID, agent_id: 'agent-worker', capability: 'admin' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
  })

  it('revokes an agent-bound token in the authorized squad', async () => {
    const captured: Captured[] = []
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv({}, captured),
      'agent_manager_revoke_token',
      { squad_id: SQUAD_ID, token_id: 'token-worker' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({
      ok: true,
      tool: 'agent_manager_revoke_token',
      result: { token: { id: 'token-worker', agent_id: 'agent-worker', status: 'revoked' } },
    })
    const update = captured.find(({ sql }) => /^\s*UPDATE member_tokens SET revoked_at/.test(sql))
    expect(update?.args).toContain('token-worker')
    expect(update?.args).toContain('member-worker-token')
    expect(update?.args).toContain('dme-temp')
    expect(captured.find(({ sql }) => /^\s*INSERT INTO agent_manager_audit/.test(sql))?.args).toContain('revoke_token')
  })

  it('cannot revoke the credential backing its current authenticated member', async () => {
    const outcome = await invokeTool(
      managerAuth(),
      managerEnv(),
      'agent_manager_revoke_token',
      { squad_id: SQUAD_ID, token_id: 'token-current' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 409, error: 'self_management_forbidden' })
  })

  it('cannot revoke another-squad token even when the manager belongs to both squads', async () => {
    const outcome = await invokeTool(
      multiSquadManagerAuth(),
      managerEnv(),
      'agent_manager_revoke_token',
      { squad_id: SQUAD_ID, token_id: 'token-other' },
      'https://mupot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 404, error: 'agent_token_not_found' })
  })
})

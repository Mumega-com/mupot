import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeHostTool, invokeTool } from '../src/mcp'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'
const SESSION_A = 'local-handle-A7vY1VbJoFmN7nO2R8gPk3xL6wQ9'
const SESSION_B = 'local-handle-B8wZ2WcKpGnO8oP3S9hQl4yM7xR0'
const HOST_ONLY_TOOLS = new Set([
  'runtime_endpoint_check_in',
  'runtime_endpoint_heartbeat',
  'runtime_endpoint_revoke',
  'runtime_endpoint_inbox',
  'runtime_endpoint_accept',
])

async function invokeEndpointTool(
  principal: AuthContext,
  env: Env,
  tool: string,
  args: Record<string, unknown>,
) {
  return await (HOST_ONLY_TOOLS.has(tool) ? invokeHostTool : invokeTool)(
    principal,
    env,
    tool,
    args,
    ORIGIN,
  )
}

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name) VALUES
      ('member-a', '${TENANT}', 'member-a@example.test', 'Member A'),
      ('member-b', '${TENANT}', 'member-b@example.test', 'Member B');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept', 'a', 'A'),
      ('squad-b', 'dept', 'b', 'B');
    INSERT INTO agents (id, squad_id, slug, name, role, model) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'builder', 'codex'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B', 'reviewer', 'codex');
    INSERT INTO projects (id, slug, name) VALUES
      ('proj-a', 'proj-a', 'Project A'),
      ('proj-hidden', 'proj-hidden', 'Hidden Project');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('proj-a', 'squad-a', 'write'),
      ('proj-a', 'squad-b', 'write'),
      ('proj-hidden', 'squad-b', 'write');
  `)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    endpointRows: () =>
      harness.sqlite.prepare('SELECT * FROM runtime_endpoints ORDER BY registered_at, id').all() as Array<Record<string, unknown>>,
    messageRows: () =>
      harness.sqlite.prepare('SELECT * FROM runtime_endpoint_messages ORDER BY seq').all() as Array<Record<string, unknown>>,
    exec: (sql: string) => harness.sqlite.exec(sql),
  }
}

function grant(
  memberId: string,
  capability: CapabilityGrant['capability'],
  scopeId: string,
): CapabilityGrant {
  return {
    member_id: memberId,
    scope_type: 'squad',
    scope_id: scopeId,
    capability,
  } as CapabilityGrant
}

function auth(memberId: string, agentId: string, squadId: string): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    boundAgentId: agentId,
    capabilities: [grant(memberId, 'member', squadId)],
  }
}

const agentA = auth('member-a', 'agent-a', 'squad-a')
const agentB = auth('member-b', 'agent-b', 'squad-b')

function checkInArgs(handle: string, overrides: Record<string, unknown> = {}) {
  return {
    runtime_kind: 'codex',
    runtime_session_handle: handle,
    node_id: 'node-macbook',
    local_source_id: 'source-codex-desktop',
    project_id: 'proj-a',
    purpose: 'mupot-review',
    workspace: 'Mumega-com/mupot',
    wake_adapter: 'codex_cli',
    allowed_senders: ['agent-b'],
    lease_seconds: 300,
    ...overrides,
  }
}

async function checkIn(
  db: ReturnType<typeof makeDb>,
  principal: AuthContext,
  handle: string,
  overrides: Record<string, unknown> = {},
) {
  return await invokeEndpointTool(
    principal,
    db.env,
    'runtime_endpoint_check_in',
    checkInArgs(handle, overrides),
  )
}

function endpointCredentials(result: Awaited<ReturnType<typeof checkIn>>) {
  if (!result.ok) throw new Error('fixture check-in failed')
  const body = result.result as {
    endpoint: { id: string }
    endpoint_capability: string
  }
  return { id: body.endpoint.id, capability: body.endpoint_capability }
}

describe('runtime endpoint MCP contract', () => {
  it('advertises safe discovery and send tools but keeps capability-bearing lifecycle operations host-only', async () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'runtime_endpoint_list',
      'runtime_endpoint_send',
    ]))
    expect(names).not.toEqual(expect.arrayContaining([...HOST_ONLY_TOOLS]))
    expect(await invokeTool(
      agentA,
      makeDb().env,
      'runtime_endpoint_check_in',
      checkInArgs(SESSION_A),
      ORIGIN,
    )).toMatchObject({ ok: false, status: 400, error: 'unknown_tool' })
  })

  it('derives the agent from auth and never persists or returns the host-local session handle', async () => {
    const db = makeDb()
    const result = await checkIn(db, agentA, SESSION_A)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const body = result.result as Record<string, unknown>
    expect(body.schema).toBe('mupot.runtime-endpoint/v1')
    expect(body.endpoint).toMatchObject({
      agent_id: 'agent-a',
      member_id: 'member-a',
      runtime_kind: 'codex',
      project_id: 'proj-a',
      node_id: 'node-macbook',
      local_source_id: 'source-codex-desktop',
      status: 'active',
      allowed_senders: ['agent-b'],
    })
    expect(body.endpoint_capability).toMatch(/^[A-Za-z0-9_-]{40,128}$/)
    expect(JSON.stringify(body)).not.toContain(SESSION_A)

    const rows = db.endpointRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('agent-a')
    expect(rows[0].session_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(rows[0].capability_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(rows[0].capability_hash).not.toBe(body.endpoint_capability)
    expect(JSON.stringify(rows[0])).not.toContain(SESSION_A)
    expect(JSON.stringify(rows[0])).not.toContain(body.endpoint_capability)

    const listed = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_list', {})
    expect(listed.ok).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(body.endpoint_capability)
  })

  it('supports two concurrent threads for one agent and idempotently renews only the matching one', async () => {
    const db = makeDb()
    const first = await checkIn(db, agentA, SESSION_A)
    const second = await checkIn(db, agentA, SESSION_B)
    const renewed = await checkIn(db, agentA, SESSION_A, { purpose: 'mupot-review-renewed' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(renewed.ok).toBe(true)
    if (!first.ok || !second.ok || !renewed.ok) return
    const firstEndpoint = endpointCredentials(first)
    const secondEndpoint = endpointCredentials(second)
    const renewedEndpoint = endpointCredentials(renewed)
    const firstId = firstEndpoint.id
    const secondId = secondEndpoint.id
    const renewedId = renewedEndpoint.id
    expect(firstId).not.toBe(secondId)
    expect(renewedId).toBe(firstId)
    expect(renewedEndpoint.capability).not.toBe(firstEndpoint.capability)
    expect(await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: renewedId,
      endpoint_capability: firstEndpoint.capability,
    })).toMatchObject({ ok: false, status: 404, error: 'endpoint_not_found' })
    expect(db.endpointRows()).toHaveLength(2)
  })

  it('refuses to move an existing endpoint handle to another host binding', async () => {
    const db = makeDb()
    const first = await checkIn(db, agentA, SESSION_A)
    expect(first.ok).toBe(true)

    const rebound = await checkIn(db, agentA, SESSION_A, { node_id: 'node-other' })
    expect(rebound).toMatchObject({ ok: false, status: 409, error: 'endpoint_binding_conflict' })
    expect(db.endpointRows()).toHaveLength(1)
    expect(db.endpointRows()[0].node_id).toBe('node-macbook')
  })

  it('rejects raw Codex thread UUIDs and inaccessible projects before writing', async () => {
    const db = makeDb()
    const rawThread = await checkIn(
      db,
      agentA,
      '00000000-0000-4000-8000-000000000001',
    )
    expect(rawThread).toMatchObject({ ok: false, status: 400, error: 'raw_runtime_session_forbidden' })

    const hidden = await checkIn(db, agentA, SESSION_A, { project_id: 'proj-hidden' })
    expect(hidden).toMatchObject({ ok: false, status: 404, error: 'project_not_found' })
    expect(db.endpointRows()).toHaveLength(0)
  })

  it('delivers to one explicit endpoint without leaking to a sibling thread', async () => {
    const db = makeDb()
    const first = await checkIn(db, agentA, SESSION_A)
    const second = await checkIn(db, agentA, SESSION_B)
    if (!first.ok || !second.ok) throw new Error('fixture check-in failed')
    const endpointA = endpointCredentials(first)
    const endpointB = endpointCredentials(second)

    const sent = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpointA.id,
      project_id: 'proj-a',
      body: 'review the exact head',
      kind: 'request',
      request_id: 'req-exact-thread-1',
    })
    expect(sent).toMatchObject({ ok: true, result: { endpoint_id: endpointA.id, duplicate: false } })

    const wrong = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: endpointB.id,
      endpoint_capability: endpointB.capability,
      limit: 10,
    })
    expect(wrong).toMatchObject({ ok: true, result: { messages: [], remaining: 0, consumed: false } })

    const right = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: endpointA.id,
      endpoint_capability: endpointA.capability,
      limit: 10,
    })
    expect(right.ok).toBe(true)
    if (!right.ok) return
    expect(right.result).toMatchObject({ remaining: 1, consumed: false })
    expect((right.result as { messages: Array<Record<string, unknown>> }).messages).toEqual([
      expect.objectContaining({
        from_agent: 'agent-b',
        endpoint_id: endpointA.id,
        request_id: 'req-exact-thread-1',
        project_id: 'proj-a',
      }),
    ])
    expect(db.messageRows()[0].accepted_at).toBeNull()
  })

  it('prevents a different agent from reading or accepting an endpoint inbox', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    if (!checked.ok) throw new Error('fixture check-in failed')
    const endpoint = endpointCredentials(checked)

    const read = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })
    expect(read).toMatchObject({ ok: false, status: 404, error: 'endpoint_not_found' })
  })

  it('requires the endpoint-specific capability even for a sibling thread using the same agent token', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    const endpoint = endpointCredentials(checked)
    const sent = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'capability-isolated request',
      kind: 'request',
      request_id: 'req-capability-1',
    })
    if (!sent.ok) throw new Error('fixture send failed')
    const messageId = (sent.result as { id: string }).id
    const wrongCapability = 'wrongEndpointCapabilityValueThatIsLongEnough123456'

    for (const [tool, args] of [
      ['runtime_endpoint_inbox', {}],
      ['runtime_endpoint_heartbeat', {}],
      ['runtime_endpoint_accept', { message_id: messageId, runtime_turn_id: 'turn-wrong-capability' }],
      ['runtime_endpoint_revoke', {}],
    ] as const) {
      expect(await invokeEndpointTool(agentA, db.env, tool, {
        endpoint_id: endpoint.id,
        endpoint_capability: wrongCapability,
        ...args,
      })).toMatchObject({ ok: false, status: 404, error: 'endpoint_not_found' })
    }

    expect(db.messageRows()[0].accepted_at).toBeNull()
    expect((db.endpointRows()[0] as { status: string }).status).toBe('active')
  })

  it('rejects an unauthorized sender before queue insertion', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    const endpoint = endpointCredentials(checked)

    const sent = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'self-send is not on the endpoint allowlist',
      kind: 'request',
      request_id: 'req-denied-sender-1',
    })

    expect(sent).toMatchObject({ ok: false, status: 403, error: 'sender_not_allowed' })
    expect(db.messageRows()).toHaveLength(0)
  })

  it('rejects acknowledgement messages before they can starve a wake inbox', async () => {
    const db = makeDb()
    const endpoint = endpointCredentials(await checkIn(db, agentA, SESSION_A))
    const sent = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'must not become a wake item',
      kind: 'ack',
      request_id: 'req-ack-loop-1',
    })

    expect(sent).toMatchObject({ ok: false, status: 400 })
    expect(db.messageRows()).toHaveLength(0)
  })

  it('stops listing and renewing an endpoint after project access is removed', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    const endpoint = endpointCredentials(checked)
    db.exec(`DELETE FROM project_squad_access WHERE project_id = 'proj-a' AND squad_id = 'squad-a'`)

    expect(await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_list', {}))
      .toMatchObject({ ok: true, result: { endpoints: [] } })
    expect(await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_heartbeat', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })).toMatchObject({ ok: false, status: 404, error: 'endpoint_not_found' })

    expect((await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_revoke', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })).ok).toBe(true)
  })

  it('refuses delivery after endpoint revocation', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    if (!checked.ok) throw new Error('fixture check-in failed')
    const endpoint = endpointCredentials(checked)
    expect((await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_revoke', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })).ok).toBe(true)

    const sent = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'must remain unsent',
      kind: 'request',
      request_id: 'req-revoked-1',
    })
    expect(sent).toMatchObject({ ok: false, status: 409, error: 'endpoint_unavailable' })
    expect(db.messageRows()).toHaveLength(0)
  })

  it('does not report revocation success if a concurrent check-in rotates the capability', async () => {
    const db = makeDb()
    const endpoint = endpointCredentials(await checkIn(db, agentA, SESSION_A))
    const originalDb = db.env.DB
    const racingDb = {
      prepare(sql: string) {
        const statement = originalDb.prepare(sql)
        if (!sql.includes("UPDATE runtime_endpoints SET status = 'revoked'")) return statement
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args)
            const rotate = async () => {
              await originalDb.prepare(
                'UPDATE runtime_endpoints SET capability_hash = ?1 WHERE id = ?2',
              )
                .bind('f'.repeat(64), endpoint.id)
                .run()
            }
            return {
              async run() {
                await rotate()
                return await bound.run()
              },
              async first<T>() {
                await rotate()
                return await bound.first<T>()
              },
            }
          },
        }
      },
    } as unknown as Env['DB']

    expect(await invokeEndpointTool(
      agentA,
      { ...db.env, DB: racingDb },
      'runtime_endpoint_revoke',
      {
        endpoint_id: endpoint.id,
        endpoint_capability: endpoint.capability,
      },
    )).toMatchObject({ ok: false, status: 409, error: 'endpoint_unavailable' })
    expect(db.endpointRows()[0].status).toBe('active')
  })

  it('fails a stale lease closed and leaves its durable message recoverable', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A, { lease_seconds: 60 })
    if (!checked.ok) throw new Error('fixture check-in failed')
    const endpoint = endpointCredentials(checked)

    await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'durable until accepted',
      kind: 'request',
      request_id: 'req-stale-1',
    })
    await (db.env.DB as unknown as { prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown> } } })
      .prepare(`UPDATE runtime_endpoints SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`)
      .bind(endpoint.id)
      .run()

    const read = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })
    expect(read).toMatchObject({ ok: false, status: 409, error: 'endpoint_unavailable' })
    expect(db.messageRows()).toHaveLength(1)
    expect(db.messageRows()[0].accepted_at).toBeNull()
  })

  it('accepts only after runtime handoff and emits an idempotent correlated receipt', async () => {
    const db = makeDb()
    const checked = await checkIn(db, agentA, SESSION_A)
    if (!checked.ok) throw new Error('fixture check-in failed')
    const endpoint = endpointCredentials(checked)
    const sent = await invokeEndpointTool(agentB, db.env, 'runtime_endpoint_send', {
      endpoint_id: endpoint.id,
      project_id: 'proj-a',
      body: 'wake this thread',
      kind: 'request',
      request_id: 'req-accept-1',
    })
    if (!sent.ok) throw new Error('fixture send failed')
    const messageId = (sent.result as { id: string }).id

    const first = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_accept', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
      message_id: messageId,
      runtime_turn_id: 'turn-accepted-01',
    })
    const replay = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_accept', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
      message_id: messageId,
      runtime_turn_id: 'turn-accepted-01',
    })

    expect(first).toMatchObject({
      ok: true,
      result: {
        schema: 'mupot.runtime-endpoint-ack/v1',
        receipt: {
          endpoint_id: endpoint.id,
          message_id: messageId,
          request_id: 'req-accept-1',
          runtime_turn_id: 'turn-accepted-01',
          duplicate: false,
        },
      },
    })
    expect(replay).toMatchObject({
      ok: true,
      result: { receipt: { duplicate: true } },
    })
    const conflictingReplay = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_accept', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
      message_id: messageId,
      runtime_turn_id: 'turn-different-02',
    })
    expect(conflictingReplay).toMatchObject({
      ok: false,
      status: 409,
      error: 'message_already_accepted',
    })

    const drained = await invokeEndpointTool(agentA, db.env, 'runtime_endpoint_inbox', {
      endpoint_id: endpoint.id,
      endpoint_capability: endpoint.capability,
    })
    expect(drained).toMatchObject({ ok: true, result: { messages: [], remaining: 0 } })
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

vi.mock('../src/auth/member-bearer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/member-bearer')>()
  return {
    ...actual,
    bearerToken: (header?: string | null) =>
      header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null,
    resolveMemberByToken: async (_env: unknown, token: string | null) => {
      if (token === 'token-a') {
        return {
          memberId: 'member-a',
          displayName: 'Member A',
          email: 'member-a@example.test',
          boundAgentId: 'agent-a',
        }
      }
      if (token === 'token-b') {
        return {
          memberId: 'member-b',
          displayName: 'Member B',
          email: 'member-b@example.test',
          boundAgentId: 'agent-b',
        }
      }
      return null
    },
  }
})

const { runtimeEndpointsApp } = await import('../src/runtime-endpoints/routes')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const SESSION_A = 'local-handle-A7vY1VbJoFmN7nO2R8gPk3xL6wQ9'

function makeEnv(): Env {
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
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-a', 'member-a', 'squad', 'squad-a', 'member'),
      ('cap-b', 'member-b', 'squad', 'squad-b', 'member');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('proj-a', 'squad-a', 'write'),
      ('proj-a', 'squad-b', 'write');
  `)
  return { DB: harness.db, TENANT_SLUG: TENANT } as Env
}

function request(
  path: string,
  token?: string,
  body?: Record<string, unknown>,
  method = body ? 'POST' : 'GET',
): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

function checkInBody() {
  return {
    runtime_kind: 'codex',
    runtime_session_handle: SESSION_A,
    node_id: 'node-macbook',
    local_source_id: 'source-codex-desktop',
    project_id: 'proj-a',
    purpose: 'mupot-review',
    workspace: 'Mumega-com/mupot',
    wake_adapter: 'codex_cli',
    allowed_senders: ['agent-b'],
    lease_seconds: 300,
  }
}

describe('runtime endpoint HTTP surface', () => {
  it('requires a welded bearer token', async () => {
    const response = await runtimeEndpointsApp.fetch(
      request('/check-in', undefined, checkInBody()),
      makeEnv(),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('registers, peeks, and accepts an exact endpoint without returning its local handle', async () => {
    const env = makeEnv()
    const checked = await runtimeEndpointsApp.fetch(
      request('/check-in', 'token-a', checkInBody()),
      env,
    )
    expect(checked.status).toBe(200)
    expect(checked.headers.get('cache-control')).toBe('no-store')
    expect(checked.headers.get('referrer-policy')).toBe('no-referrer')
    const checkedBody = await checked.json() as {
      endpoint: { id: string }
      endpoint_capability: string
    }
    const endpointId = checkedBody.endpoint.id
    const endpointCapability = checkedBody.endpoint_capability
    expect(JSON.stringify(checkedBody)).not.toContain(SESSION_A)

    const sent = await runtimeEndpointsApp.fetch(
      request('/send', 'token-b', {
        endpoint_id: endpointId,
        project_id: 'proj-a',
        body: 'wake the exact review thread',
        kind: 'request',
        request_id: 'http-req-1',
      }),
      env,
    )
    expect(sent.status).toBe(200)
    const sentBody = await sent.json() as { id: string }

    const peeked = await runtimeEndpointsApp.fetch(
      request('/inbox', 'token-a', {
        endpoint_id: endpointId,
        endpoint_capability: endpointCapability,
        limit: 10,
      }),
      env,
    )
    expect(peeked.status).toBe(200)
    expect(await peeked.json()).toMatchObject({
      consumed: false,
      remaining: 1,
      messages: [{ id: sentBody.id, endpoint_id: endpointId, request_id: 'http-req-1' }],
    })

    const accepted = await runtimeEndpointsApp.fetch(
      request('/accept', 'token-a', {
        endpoint_id: endpointId,
        endpoint_capability: endpointCapability,
        message_id: sentBody.id,
        runtime_turn_id: 'turn-http-1',
      }),
      env,
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      schema: 'mupot.runtime-endpoint-ack/v1',
      receipt: {
        endpoint_id: endpointId,
        message_id: sentBody.id,
        request_id: 'http-req-1',
        runtime_turn_id: 'turn-http-1',
      },
    })
  })
})

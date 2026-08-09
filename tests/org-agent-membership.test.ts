import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { orgApp } = await import('../src/org')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const AGENT_ID = 'agent-1'
const MEMBER_ID = 'member-1'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'

function createHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD_ID}', 'dept-1', 'home', 'Home'),
      ('${TARGET_SQUAD_ID}', 'dept-1', 'target', 'Target');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Agent Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-07-24T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('grant-home', '${MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');
  `)
  return harness
}

function request(squadId: string, capability: string): Request {
  return new Request(`https://pot.example/agents/${AGENT_ID}/memberships`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ squad_id: squadId, capability }),
  })
}

describe('POST /agents/:id/memberships canonical delegation', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createHarness()
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    authState.current = {
      userId: 'owner-1',
      email: 'owner@example.test',
      role: 'owner',
      tenant: TENANT,
    }
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('creates and updates synchronized access through the sole writer', async () => {
    const created = await orgApp.fetch(request(TARGET_SQUAD_ID, 'admin'), env)
    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toMatchObject({
      result: 'created',
      membership: {
        agent_id: AGENT_ID,
        squad_id: TARGET_SQUAD_ID,
        capability: 'member',
      },
      grant: {
        member_id: MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'admin',
      },
    })

    const updated = await orgApp.fetch(request(TARGET_SQUAD_ID, 'lead'), env)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      result: 'updated',
      membership: { capability: 'member' },
      grant: { capability: 'lead' },
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ count: 1 })
  })

  it('requires target-squad admin for delegation', async () => {
    authState.current = {
      userId: 'lead-1',
      memberId: 'lead-1',
      email: 'lead@example.test',
      role: 'member',
      tenant: TENANT,
      capabilities: [{
        member_id: 'lead-1',
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'lead',
      }],
    }

    const response = await orgApp.fetch(request(TARGET_SQUAD_ID, 'member'), env)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden', need: 'admin' })
  })

  it('refuses an agent-bound principal before resolving or writing delegation', async () => {
    authState.current = {
      userId: 'agent-user',
      memberId: 'agent-member',
      email: null,
      role: 'owner',
      tenant: TENANT,
      boundAgentId: 'agent-caller',
      capabilities: [{
        member_id: 'agent-member',
        scope_type: 'org',
        scope_id: null,
        capability: 'owner',
      }],
    }

    const response = await orgApp.fetch(request(TARGET_SQUAD_ID, 'member'), env)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'operator_principal_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ count: 0 })
  })

  it('allows home escalation and refuses an unminted identity without partial writes', async () => {
    const home = await orgApp.fetch(request(HOME_SQUAD_ID, 'lead'), env)
    expect(home.status).toBe(200)

    harness.sqlite.exec(`
      DELETE FROM capabilities WHERE member_id = '${MEMBER_ID}';
      DELETE FROM agent_member_bindings WHERE tenant = '${TENANT}' AND agent_id = '${AGENT_ID}';
    `)
    const unminted = await orgApp.fetch(request(TARGET_SQUAD_ID, 'member'), env)
    expect(unminted.status).toBe(409)
    await expect(unminted.json()).resolves.toEqual({ error: 'agent_identity_unminted' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ count: 0 })
  })
})

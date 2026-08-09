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

const { membersApp } = await import('../src/members')

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

function capabilityRequest(body: Record<string, unknown>): Request {
  return new Request(`https://pot.example/members/${MEMBER_ID}/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /members/:id/capabilities bound-agent delegation', () => {
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

  it('delegates bound-member squad grant and revoke through the synchronized writer', async () => {
    const granted = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
      capability: 'lead',
    }), env)
    expect(granted.status).toBe(201)
    await expect(granted.json()).resolves.toMatchObject({
      action: 'grant',
      result: 'created',
      grant: {
        member_id: MEMBER_ID,
        scope_id: TARGET_SQUAD_ID,
        capability: 'lead',
      },
    })
    expect(harness.sqlite.prepare(
      'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'member' })
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'lead' })

    const revoked = await membersApp.fetch(capabilityRequest({
      action: 'revoke',
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
    }), env)
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({
      member_id: MEMBER_ID,
      action: 'revoke',
      result: 'removed',
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
  })

  it('refuses non-squad grants for a canonical bound member', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'org',
      capability: 'member',
    }), env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'agent_capability_scope_unsupported',
    })
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ? AND scope_type = 'org'",
    ).get(MEMBER_ID)).toEqual({ n: 0 })
  })

  it('allows a bound member home escalation to lead (ceiling removed per Hadi directive 2026-08-09)', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: HOME_SQUAD_ID,
      capability: 'lead',
    }), env)
    expect(response.status).toBe(200)
  })

  it('refuses the unsupported owner rank for bound-agent squad access', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
      capability: 'owner',
    }), env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_agent_capability',
      allowed: ['observer', 'member', 'lead', 'admin'],
    })
  })
})

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
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'lead' })
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

// ── #1337: TARGET-rank ceiling on POST /members/:id/capabilities ──────────────
//
// The pre-existing ceiling guards the capability being GRANTED. It never looked
// at what the target ALREADY HOLDS, so an org admin could remove or demote the
// org OWNER. Both reachable paths are covered here because both DELETE the
// target's existing row:
//
//   revoke  — DELETEs by (member_id, scope_type, scope_id), not by capability
//   grant   — upsertCapabilityGrant is DELETE-then-INSERT on the same key, so
//             granting a LOWER capability deletes the higher one. The grant
//             ceiling cannot catch that: rank('member') is BELOW the actor's.
//
// Fixtures use the REAL migration chain (createHarness above), and every
// assertion re-reads the row rather than trusting the response body.
describe('POST /members/:id/capabilities — target-rank ceiling (#1337)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const OWNER_MEMBER = 'member-owner'
  const ADMIN_MEMBER = 'member-admin'
  const PEER_ADMIN = 'member-peer-admin'

  function ownerCapabilityRequest(target: string, body: Record<string, unknown>): Request {
    return new Request(`https://pot.example/members/${target}/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function orgCapabilityOf(memberId: string): { capability: string } | undefined {
    return harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'org' AND scope_id IS NULL`,
    ).get(memberId) as { capability: string } | undefined
  }

  beforeEach(() => {
    harness = createHarness()
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES
        ('${OWNER_MEMBER}', 'The Owner', 'active', '${TENANT}'),
        ('${ADMIN_MEMBER}', 'An Admin', 'active', '${TENANT}'),
        ('${PEER_ADMIN}', 'Peer Admin', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner', '${OWNER_MEMBER}', 'org', NULL, 'owner'),
        ('cap-admin', '${ADMIN_MEMBER}', 'org', NULL, 'admin'),
        ('cap-peer',  '${PEER_ADMIN}',  'org', NULL, 'admin');
    `)
    // The ACTOR is an org admin, not an owner. role is deliberately 'member' so
    // standing comes from the capability grant, which is the plane that matters.
    authState.current = {
      userId: 'admin-user',
      email: 'admin@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: ADMIN_MEMBER,
      capabilities: [
        { member_id: ADMIN_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
    } as AuthContext
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('refuses an admin REVOKING the org owner, and the owner row survives', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(OWNER_MEMBER, {
      action: 'revoke',
      scope_type: 'org',
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // The row is what matters, not the status code.
    expect(orgCapabilityOf(OWNER_MEMBER)).toEqual({ capability: 'owner' })
  })

  it('refuses an admin DEMOTING the org owner via a lower grant — the path the grant ceiling cannot see', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(OWNER_MEMBER, {
      scope_type: 'org',
      capability: 'member',
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(orgCapabilityOf(OWNER_MEMBER)).toEqual({ capability: 'owner' })
  })

  it('still allows an admin to affect a PEER admin — the guard is about rank inversion, not peers', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(PEER_ADMIN, {
      action: 'revoke',
      scope_type: 'org',
    }), env)

    expect(res.status).toBe(200)
    expect(orgCapabilityOf(PEER_ADMIN)).toBeUndefined()
  })

  it('refuses an admin SUSPENDING the org owner — #1330 made that lockout immediate', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${OWNER_MEMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // Re-read the row: the response body is not the evidence.
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(OWNER_MEMBER))
      .toEqual({ status: 'active' })
  })

  it('still allows an admin to suspend a PEER admin', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${PEER_ADMIN}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(200)
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(PEER_ADMIN))
      .toEqual({ status: 'suspended' })
  })

  it('refuses an admin MINTING A TOKEN for the org owner — a token authenticates AS that member, so this is rank ESCALATION', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${OWNER_MEMBER}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'escalation attempt' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // No credential row may exist for the owner.
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(OWNER_MEMBER)).toEqual({ n: 0 })
  })

  it('still allows an admin to mint a token for a PEER admin', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${PEER_ADMIN}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ordinary' }),
    }), env)

    expect(res.status).toBe(201)
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(PEER_ADMIN)).toEqual({ n: 1 })
  })
})

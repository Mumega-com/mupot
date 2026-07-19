import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { makeReadyRoutineFixture } from './helpers/routine-actions'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { routinesApp } = await import('../src/routines/routes')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-1', 'squad-1', 'worker', 'Worker', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'Project One', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-1', 'write');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a' } as Env
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'member-1', memberId: 'member-1', email: null, role: 'owner', tenant: 'tenant-a',
    ...overrides,
  }
}

function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: 'https://pot.test' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const policy = {
  name: 'Keep momentum', objective: 'Choose one accountable next action', trigger_kind: 'manual',
  timezone: 'UTC', responsible_squad_id: 'squad-1', budget_micro_usd: 250_000, max_occurrences: null,
}

describe('routine REST routes', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('fails closed, hides unreadable resources, and marks every response no-store', async () => {
    harness = makeHarness()
    const unauthenticated = await routinesApp.fetch(request('/projects/project-1/routines'), envFor(harness))
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store')

    authState.current = actor({ tenant: 'other-tenant' })
    const hidden = await routinesApp.fetch(request('/projects/project-1/routines'), envFor(harness))
    expect(hidden.status).toBe(404)
    expect(hidden.headers.get('cache-control')).toBe('no-store')
  })

  it('validates bounded JSON before policy services and never exposes run policy or proposals', async () => {
    harness = makeHarness()
    authState.current = actor()
    const unknown = await routinesApp.fetch(
      request('/projects/project-1/routines', 'POST', { ...policy, project_id: 'forged', agent_id: 'agent-1' }), envFor(harness),
    )
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toEqual({ error: 'unknown_field' })

    const array = await routinesApp.fetch(request('/projects/project-1/routines', 'POST', []), envFor(harness))
    expect(array.status).toBe(400)
    await expect(array.json()).resolves.toEqual({ error: 'invalid_body' })

    const tooLarge = await routinesApp.fetch(new Request('https://pot.test/projects/project-1/routines', {
      method: 'POST', headers: { Origin: 'https://pot.test', 'content-type': 'application/json' }, body: 'x'.repeat(8193),
    }), envFor(harness))
    expect(tooLarge.status).toBe(413)

    const created = await routinesApp.fetch(request('/projects/project-1/routines', 'POST', policy), envFor(harness))
    expect(created.status).toBe(201)
    const routine = (await created.json() as { routine: { id: string } }).routine
    expect(routine).not.toHaveProperty('tenant')

    const enabled = await routinesApp.fetch(request(`/projects/project-1/routines/${routine.id}/enable`, 'POST', {}), envFor(harness))
    expect(enabled.status).toBe(200)
    const missingKey = await routinesApp.fetch(request(`/projects/project-1/routines/${routine.id}/run`, 'POST', {}), envFor(harness))
    expect(missingKey.status).toBe(400)
    await expect(missingKey.json()).resolves.toEqual({ error: 'invalid_idempotency_key' })

    const first = await routinesApp.fetch(request(`/projects/project-1/routines/${routine.id}/run`, 'POST', {}, { 'idempotency-key': 'run-1' }), envFor(harness))
    expect(first.status).toBe(201)
    const firstBody = await first.json() as { run: { id: string; policy_json?: string; proposal_json?: string }; duplicate: boolean }
    expect(firstBody).toMatchObject({ duplicate: false })
    expect(firstBody.run).not.toHaveProperty('policy_json')
    expect(firstBody.run).not.toHaveProperty('proposal_json')

    const replay = await routinesApp.fetch(request(`/projects/project-1/routines/${routine.id}/run`, 'POST', {}, { 'idempotency-key': 'run-1' }), envFor(harness))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ duplicate: true, run: { id: firstBody.run.id } })

    authState.current = actor({ boundAgentId: 'agent-1' })
    const agentCancel = await routinesApp.fetch(request(`/routine-runs/${firstBody.run.id}/cancel`, 'POST', {}), envFor(harness))
    expect(agentCancel.status).toBe(403)
    authState.current = actor()
    const cancelled = await routinesApp.fetch(request(`/routine-runs/${firstBody.run.id}/cancel`, 'POST', {}), envFor(harness))
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toEqual({ ok: true, run_id: firstBody.run.id, duplicate: false })
  })

  it('submits a proposal only from the auth-welded assigned agent and never accepts an agent field', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const proposal = fixture.proposal({ key: 'route-no-action', kind: 'no_action', input: { reason: 'No further action.' } })
    authState.current = actor({
      tenant: 'tenant-a', role: 'member', memberId: 'member-1', boundAgentId: 'agent-2',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    })
    const denied = await routinesApp.fetch(
      request('/routine-runs/run-1/proposal', 'POST', proposal, { 'idempotency-key': 'route-no-action' }), fixture.env,
    )
    expect(denied.status).toBe(400)
    await expect(denied.json()).resolves.toEqual({ error: 'assigned_agent_mismatch' })

    authState.current = actor({
      tenant: 'tenant-a', role: 'member', memberId: 'member-1', boundAgentId: 'agent-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    })
    const forged = await routinesApp.fetch(
      request('/routine-runs/run-1/proposal', 'POST', { ...proposal, agent_id: 'agent-1' }, { 'idempotency-key': 'route-no-action' }), fixture.env,
    )
    expect(forged.status).toBe(400)
    await expect(forged.json()).resolves.toEqual({ error: 'unknown_field' })
    const mismatchedKey = await routinesApp.fetch(
      request('/routine-runs/run-1/proposal', 'POST', proposal, { 'idempotency-key': 'different-key' }), fixture.env,
    )
    expect(mismatchedKey.status).toBe(400)
    await expect(mismatchedKey.json()).resolves.toEqual({ error: 'idempotency_key_mismatch' })
    const accepted = await routinesApp.fetch(
      request('/routine-runs/run-1/proposal', 'POST', proposal, { 'idempotency-key': 'route-no-action' }), fixture.env,
    )
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, status: 'succeeded', run_id: 'run-1' })
  })

  it('enforces same-origin CSRF for browser mutations and strict list cursors', async () => {
    harness = makeHarness()
    authState.current = actor()
    const csrf = await routinesApp.fetch(new Request('https://pot.test/projects/project-1/routines', {
      method: 'POST', headers: { Cookie: 'mupot_session=session-1', Origin: 'https://attacker.test', 'content-type': 'application/json' }, body: JSON.stringify(policy),
    }), envFor(harness))
    expect(csrf.status).toBe(403)

    const badLimit = await routinesApp.fetch(request('/projects/project-1/routines?limit=101'), envFor(harness))
    expect(badLimit.status).toBe(400)
    await expect(badLimit.json()).resolves.toEqual({ error: 'invalid_pagination' })
    const badCursor = await routinesApp.fetch(request('/projects/project-1/routines?cursor=not%20a%20cursor'), envFor(harness))
    expect(badCursor.status).toBe(400)
  })
})

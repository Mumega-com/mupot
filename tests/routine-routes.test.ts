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
    return next()
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
    expect(Object.keys(firstBody.run).sort()).toEqual([
      'assigned_agent_id', 'attempt', 'cost_micro_usd', 'created_at', 'finished_at', 'flight_id', 'id', 'project_id',
      'result_summary', 'routine_id', 'routine_revision', 'scheduled_for', 'started_at', 'status', 'task_id',
      'trigger_kind', 'updated_at', 'waiting_reason',
    ])

    const replay = await routinesApp.fetch(request(`/projects/project-1/routines/${routine.id}/run`, 'POST', {}, { 'idempotency-key': 'run-1' }), envFor(harness))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ duplicate: true, run: { id: firstBody.run.id } })
    const listedRuns = await routinesApp.fetch(request(`/projects/project-1/routine-runs?routine_id=${routine.id}&limit=1`), envFor(harness))
    expect(listedRuns.status).toBe(200)
    const listedRun = (await listedRuns.json() as { runs: Array<Record<string, unknown>> }).runs[0]
    expect(Object.keys(listedRun).sort()).toEqual(Object.keys(firstBody.run).sort())
    const fetchedRun = await routinesApp.fetch(request(`/routine-runs/${firstBody.run.id}`), envFor(harness))
    expect(fetchedRun.status).toBe(200)
    expect(Object.keys((await fetchedRun.json() as { run: Record<string, unknown> }).run).sort()).toEqual(Object.keys(firstBody.run).sort())

    authState.current = actor({ boundAgentId: 'agent-1' })
    const agentCancel = await routinesApp.fetch(request(`/routine-runs/${firstBody.run.id}/cancel`, 'POST', {}), envFor(harness))
    expect(agentCancel.status).toBe(403)
    authState.current = actor()
    const cancelled = await routinesApp.fetch(request(`/routine-runs/${firstBody.run.id}/cancel`, 'POST', {}), envFor(harness))
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toEqual({ ok: true, run_id: firstBody.run.id, duplicate: false, outcome: 'confirmed' })
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

  it('accepts a scoped human answer and queues the same run for a fresh attempt', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const proposal = fixture.proposal({
      key: 'route-question', kind: 'ask_human',
      input: { question: 'Which outcome is authoritative?', choices: ['Booked', 'Paid'], references: [] },
    })
    authState.current = actor({
      role: 'member', boundAgentId: 'agent-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    })
    const asked = await routinesApp.fetch(
      request('/routine-runs/run-1/proposal', 'POST', proposal, { 'idempotency-key': 'route-question' }), fixture.env,
    )
    expect(asked.status).toBe(200)
    await expect(asked.json()).resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'answer' })

    authState.current = actor({
      role: 'member', boundAgentId: undefined,
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    })
    const invalid = await routinesApp.fetch(request('/routine-runs/run-1/answer', 'POST', { answer: 'Unknown' }), fixture.env)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_answer' })

    const answered = await routinesApp.fetch(request('/routine-runs/run-1/answer', 'POST', { answer: 'Paid' }), fixture.env)
    expect(answered.status).toBe(200)
    await expect(answered.json()).resolves.toEqual({ ok: true, run_id: 'run-1', duplicate: false })
    expect(fixture.harness.sqlite.prepare("SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'").get()).toEqual({
      status: 'queued', result_summary: 'human_answered',
    })
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

  it('rejects malformed UTF-8 and measures raw multibyte request bytes before parsing', async () => {
    harness = makeHarness()
    authState.current = actor()
    const encoded = new TextEncoder().encode(JSON.stringify(policy))
    const nameOffset = new TextDecoder().decode(encoded).indexOf('Keep momentum')
    const malformed = new Uint8Array([...encoded.slice(0, nameOffset), 0xc3, 0x28, ...encoded.slice(nameOffset + 2)])
    const malformedResponse = await routinesApp.fetch(new Request('https://pot.test/projects/project-1/routines', {
      method: 'POST', headers: { Origin: 'https://pot.test', 'content-type': 'application/json' }, body: malformed,
    }), envFor(harness))
    expect(malformedResponse.status).toBe(400)
    await expect(malformedResponse.json()).resolves.toEqual({ error: 'invalid_body' })

    const exact = `{"x":"${'é'.repeat(4092)}"}`
    expect(new TextEncoder().encode(exact).byteLength).toBe(8192)
    const exactResponse = await routinesApp.fetch(new Request('https://pot.test/projects/project-1/routines', {
      method: 'POST', headers: { Origin: 'https://pot.test', 'content-type': 'application/json' }, body: exact,
    }), envFor(harness))
    expect(exactResponse.status).toBe(400)
    await expect(exactResponse.json()).resolves.toEqual({ error: 'unknown_field' })
    const over = `${exact.slice(0, -2)}a"}`
    expect(new TextEncoder().encode(over).byteLength).toBe(8193)
    const overResponse = await routinesApp.fetch(new Request('https://pot.test/projects/project-1/routines', {
      method: 'POST', headers: { Origin: 'https://pot.test', 'content-type': 'application/json' }, body: over,
    }), envFor(harness))
    expect(overResponse.status).toBe(413)
  })

  it('covers GET/PATCH/pause/archive and rejects a Routine under the wrong Project path', async () => {
    harness = makeHarness()
    authState.current = actor()
    const created = await routinesApp.fetch(request('/projects/project-1/routines', 'POST', policy), envFor(harness))
    const id = (await created.json() as { routine: { id: string } }).routine.id
    expect((await routinesApp.fetch(request(`/projects/project-1/routines/${id}`), envFor(harness))).status).toBe(200)
    const patched = await routinesApp.fetch(request(`/projects/project-1/routines/${id}`, 'PATCH', { name: 'Keep moving' }), envFor(harness))
    await expect(patched.json()).resolves.toMatchObject({ routine: { name: 'Keep moving' } })
    expect((await routinesApp.fetch(request(`/projects/not-project/routines/${id}`), envFor(harness))).status).toBe(404)
    expect((await routinesApp.fetch(request(`/projects/project-1/routines/${id}/enable`, 'POST', {}), envFor(harness))).status).toBe(200)
    expect((await routinesApp.fetch(request(`/projects/project-1/routines/${id}/pause`, 'POST', {}), envFor(harness))).status).toBe(200)
    const paused = await routinesApp.fetch(request('/projects/project-1/routines?status=paused&limit=1'), envFor(harness))
    await expect(paused.json()).resolves.toMatchObject({ routines: [{ id, status: 'paused' }] })
    expect((await routinesApp.fetch(request(`/projects/project-1/routines/${id}/archive`, 'POST', {}), envFor(harness))).status).toBe(200)
  })
})

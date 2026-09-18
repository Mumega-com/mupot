import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverAvailableAdapters,
  getHarnessAdapter,
  listHarnessAdapters,
  requireHarnessAdapter,
  resolveHarnessAdapter,
} from '../src/harness/registry'
import {
  claimAttachLease,
  computeRequestDigest,
  getReservation,
  getReservationByIdempotency,
  insertReservation,
  markReconciled,
  markReservationFailed,
} from '../src/harness/reservations'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { grokCliAdapter } from '../src/harness/adapters/grok'
import {
  attachCursorCloudExecution,
  reserveCursorCloudWork,
} from '../src/cursor/dispatch'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TOKEN = 'cursor-test-token-harness'
const AGENT_ID = 'bc-11111111-2222-3333-4444-555555555555'
const RUN_ID = 'run-11111111-2222-3333-4444-555555555555'
const AGENT_URL = `https://cursor.com/agents/${AGENT_ID}`

const SAMPLE_AGENT = {
  id: AGENT_ID,
  name: 'Test Agent',
  status: 'ACTIVE',
  url: AGENT_URL,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  latestRunId: RUN_ID,
  repos: [{ url: 'https://github.com/mumega/mupot' }],
}

const SAMPLE_RUN = {
  id: RUN_ID,
  agentId: AGENT_ID,
  status: 'CREATING',
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-builder', 'squad-core', 'agent-builder', 'Agent Builder', 'builder', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-builder', 'builder@test.com', 'Builder Member', 'active', 'mumega');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-builder', 'member-builder', 'squad', 'squad-core', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('mumega', 'agent-builder', 'member-builder', datetime('now'));
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    CURSOR_API_TOKEN: TOKEN,
    BUS: { send: async () => {} },
  } as unknown as Env
}

function authContext(): AuthContext {
  return {
    userId: 'member-builder',
    memberId: 'member-builder',
    email: 'builder@test.com',
    role: 'member',
    tenant: 'mumega',
    channel: 'workspace',
    boundAgentId: 'agent-builder',
    capabilities: [
      { member_id: 'member-builder', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' },
    ],
  }
}

describe('Harness Adapter Registry & SPI', () => {
  it('registers built-in adapters and supports discovery', () => {
    const adapters = listHarnessAdapters()
    expect(adapters.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['cursor-cloud', 'grok-cli']),
    )

    const cursor = getHarnessAdapter('cursor-cloud')
    expect(cursor).toBeDefined()
    expect(cursor?.capabilities().asyncAttach).toBe(true)

    const grok = requireHarnessAdapter('grok-cli')
    expect(grok.kind).toBe('grok-cli')
    expect(grok.capabilities().requiresApiToken).toBe(false)

    expect(() => requireHarnessAdapter('codex-cli' as any)).toThrow(/harness_adapter_not_found/)
  })

  it('resolves availability based on environment credentials', () => {
    const harness = makeHarness()
    const envWithToken = envFor(harness)
    const envNoToken = { ...envWithToken, CURSOR_API_TOKEN: undefined } as any

    const resolvedWithToken = resolveHarnessAdapter('cursor-cloud', envWithToken)
    expect(resolvedWithToken.ok).toBe(true)

    const resolvedNoToken = resolveHarnessAdapter('cursor-cloud', envNoToken)
    expect(resolvedNoToken.ok).toBe(false)
    if (!resolvedNoToken.ok) {
      expect(resolvedNoToken.error).toBe('harness_unavailable')
    }

    const available = discoverAvailableAdapters(envWithToken)
    expect(available.map((a) => a.kind)).toContain('cursor-cloud')
    expect(available.map((a) => a.kind)).toContain('grok-cli')
  })
})

describe('Pre-dispatch Reservation & Idempotency', () => {
  it('reserves Task and Flight in D1 without calling vendor HTTP', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const reserved = await reserveCursorCloudWork(env, {
      name: 'Implement Redis Cache',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Write cache layer',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member', id: 'member-builder' },
      idempotencyKey: 'redis-cache-v1',
    })

    expect(reserved.reservationId).toBeDefined()
    expect(reserved.replay).toBe(false)
    expect(reserved.state).toBe('reserved')
    expect(fetchMock).not.toHaveBeenCalled()

    const reservationRow = await getReservation(env, reserved.reservationId)
    expect(reservationRow).toBeDefined()
    expect(reservationRow?.state).toBe('reserved')
    expect(reservationRow?.vendor_agent_id).toBeNull()

    const tasks = harness.sqlite.prepare('SELECT id, title, status, body FROM tasks').all()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'Implement Redis Cache',
      status: 'in_progress',
    })
    expect(String(tasks[0]?.body)).toContain('reservation: ' + reserved.reservationId)

    const flights = harness.sqlite.prepare('SELECT id, goal, status FROM flights').all()
    expect(flights).toHaveLength(1)
    expect(flights[0]).toMatchObject({
      goal: 'Implement Redis Cache',
      status: 'running',
    })
  })

  it('attaches vendor execution and updates task body and reservation row', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const fetchMock = vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN }))
    vi.stubGlobal('fetch', fetchMock)

    const reserved = await reserveCursorCloudWork(env, {
      name: 'Add Docs',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Add API documentation',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member', id: 'member-builder' },
      idempotencyKey: 'docs-task-01',
    })

    const attachResult = await attachCursorCloudExecution(env, reserved.reservationId)
    expect(attachResult.state).toBe('attached')
    expect(attachResult.cursor?.agentId).toBe(AGENT_ID)
    expect(attachResult.cursor?.runId).toBe(RUN_ID)
    expect(fetchMock).toHaveBeenCalledOnce()

    const row = await getReservation(env, reserved.reservationId)
    expect(row?.state).toBe('attached')
    expect(row?.vendor_agent_id).toBe(AGENT_ID)
    expect(row?.vendor_run_id).toBe(RUN_ID)

    const task = harness.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(reserved.task.id) as { body: string }
    expect(task.body).toContain(`cursor_agent: ${AGENT_ID}`)
    expect(task.body).toContain(`cursor_run: ${RUN_ID}`)
    expect(task.body).toContain(`cursor_url: ${AGENT_URL}`)
  })

  it('idempotency key replay returns existing record without duplicate vendor launch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const fetchMock = vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN }))
    vi.stubGlobal('fetch', fetchMock)

    const req = {
      name: 'Replay Task',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Do replay test',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member' as const, id: 'member-builder' },
      idempotencyKey: 'fixed-idempotency-key',
    }

    const first = await cursorCloudAdapter.dispatch(env, req)
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    expect(first.replay).toBe(false)
    expect(first.vendorAgentId).toBe(AGENT_ID)

    const second = await cursorCloudAdapter.dispatch(env, req)
    expect(second.accepted).toBe(true)
    if (!second.accepted) return
    expect(second.replay).toBe(true)
    expect(second.reservationId).toBe(first.reservationId)
    expect(second.vendorAgentId).toBe(AGENT_ID)
    expect(fetchMock).toHaveBeenCalledOnce() // Only one HTTP call across both attempts!
  })

  it('rejects idempotency conflict when same key is sent with different prompt', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN })))

    const key = 'conflict-key-test'
    const first = await cursorCloudAdapter.dispatch(env, {
      name: 'Initial Task',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Original prompt',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member', id: 'member-builder' },
      idempotencyKey: key,
    })
    expect(first.accepted).toBe(true)

    const second = await cursorCloudAdapter.dispatch(env, {
      name: 'Initial Task',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Divergent prompt with altered requirements',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member', id: 'member-builder' },
      idempotencyKey: key,
    })
    expect(second.accepted).toBe(false)
    if (!second.accepted) {
      expect(second.error).toBe('idempotency_key_conflict')
    }
  })

  it('supports async attach via waitUntil in MCP cursor_dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const backgroundPromises: Promise<unknown>[] = []
    const waitUntilMock = vi.fn((p: Promise<unknown>) => {
      backgroundPromises.push(p)
    })

    const fetchMock = vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await invokeTool(
      authContext(),
      env,
      'cursor_dispatch',
      {
        name: 'Async Cloud Agent',
        repo_url: 'https://github.com/mumega/mupot',
        prompt: 'Work in background',
        idempotency_key: 'async-key-01',
      },
      { waitUntil: waitUntilMock },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({
      ok: true,
      accepted: true,
      state: 'reserved',
      idempotency_key: 'async-key-01',
    })
    expect(waitUntilMock).toHaveBeenCalled()

    // Before background promise finishes: D1 reservation is already stored and attaching
    const reservationBefore = await getReservationByIdempotency(env, 'cursor-cloud', 'async-key-01')
    expect(['reserved', 'attaching']).toContain(reservationBefore?.state)

    // Now resolve background tasks
    await Promise.all(backgroundPromises)

    // After background attach finishes: vendor IDs are bound
    const reservationAfter = await getReservationByIdempotency(env, 'cursor-cloud', 'async-key-01')
    expect(reservationAfter?.state).toBe('attached')
    expect(reservationAfter?.vendor_agent_id).toBe(AGENT_ID)
  })

  it('supports async attach via waitUntil in MCP cursor_dispatch WITHOUT client idempotency_key', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const backgroundPromises: Promise<unknown>[] = []
    const waitUntilMock = vi.fn((p: Promise<unknown>) => {
      backgroundPromises.push(p)
    })

    const fetchMock = vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await invokeTool(
      authContext(),
      env,
      'cursor_dispatch',
      {
        name: 'No Key Cloud Agent',
        repo_url: 'https://github.com/mumega/mupot',
        prompt: 'Work with server-generated key',
      },
      { waitUntil: waitUntilMock },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({
      ok: true,
      accepted: true,
      state: 'reserved',
      reservation_id: expect.any(String),
      task_id: expect.any(String),
      flight_id: expect.any(String),
      idempotency_key: expect.any(String),
      agent_id: null,
      run_id: null,
      agent_url: null,
    })
    expect(waitUntilMock).toHaveBeenCalled()

    await Promise.all(backgroundPromises)

    const resId = (outcome.result as any).reservation_id
    const row = await getReservation(env, resId)
    expect(row?.state).toBe('attached')
    expect(row?.vendor_agent_id).toBe(AGENT_ID)
  })

  it('concurrent reservation race handles unique constraint collision cleanly', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const req = {
      name: 'Concurrent Race',
      repoUrl: 'https://github.com/mumega/mupot',
      prompt: 'Simulate concurrent race condition',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member' as const, id: 'member-builder' },
      idempotencyKey: 'race-key-01',
    }

    const [first, second] = await Promise.all([
      reserveCursorCloudWork(env, req),
      reserveCursorCloudWork(env, req),
    ])

    expect(first.task.id).toBeDefined()
    expect(second.task.id).toBeDefined()
    // Both callers agree on the canonical reservation ID (no orphan local UUID)
    expect(first.reservationId).toBe(second.reservationId)
    expect(first.flight.id).toBe(second.flight.id)
    const exactlyOneReplay = (first.replay && !second.replay) || (!first.replay && second.replay)
    expect(exactlyOneReplay).toBe(true)
  })
})

describe('Grokbot Harness Adapter', () => {
  it('dispatches work via native Mupot reservation without vendor API token', async () => {
    const harness = makeHarness()
    const env = { ...envFor(harness), CURSOR_API_TOKEN: undefined } as any

    const outcome = await grokCliAdapter.dispatch(env, {
      name: 'Grok Review PR',
      prompt: 'Review PR 1425 with adversarial probes',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member', id: 'member-builder' },
      idempotencyKey: 'grok-review-01',
    })

    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.adapter).toBe('grok-cli')
    expect(outcome.state).toBe('attached')
    expect(outcome.vendorUrl).toContain('mupot:inbox')

    const row = await getReservation(env, outcome.reservationId)
    expect(row?.adapter).toBe('grok-cli')
    expect(row?.state).toBe('attached')

    const task = harness.sqlite.prepare('SELECT title, body FROM tasks WHERE id = ?').get(outcome.taskId) as {
      title: string
      body: string
    }
    expect(task.title).toBe('Grok Review PR')
    expect(task.body).toContain('harness: grok-cli')
  })
})

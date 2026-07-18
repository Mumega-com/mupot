import { describe, expect, it } from 'vitest'
import { mcpApp, TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'
import { flushFlightEventOutbox } from '../src/flight/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const MEMBER_ID = 'member-product'
const AGENT_ID = 'agent-product'
const SQUAD_ID = 'squad-mmhq'
const OTHER_SQUAD_ID = 'squad-other'
const PRODUCT_TOKEN = 'mupot-product-flight-token'

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function authenticatedTool(env: Env, tool: string, args: Record<string, unknown>) {
  const response = await mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PRODUCT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool, args }),
    },
    env,
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json() as Promise<{ ok: boolean; result: Record<string, unknown> }>
}

const signals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 999_000_000,
  budgetEstimateMicroUsd: 999_000_000,
  recentProgress: 0.9,
  progressPerStep: 0.8,
  wastePerStep: 0.1,
  stepSeconds: 10,
}

const meta = {
  schema: 'mupot.flight.meta/v1',
  goal_id: 'mumega-tenant-zero',
  objective_id: 'm000-constitution-census',
  squad_ids: [SQUAD_ID],
  task_ids: ['task-m000'],
  done_when: ['the census hash verifies'],
  artifact_refs: [],
  receipt_refs: [],
  confidentiality: 'internal',
  publication_target: 'none',
  parent_flight_id: null,
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

function makeEnv(agentStatus: 'active' | 'paused' | null = 'active') {
  const rows = new Map<string, FlightRow>()
  const cursors = new Map<string, string>()
  let beforeFlightLand: (() => void) | null = null
  const tasks = new Map<string, { id: string; squad_id: string; status: 'in_progress' | 'review' | 'approved' | 'done'; gate_owner: string | null }>([
    ['task-m000', { id: 'task-m000', squad_id: SQUAD_ID, status: 'in_progress', gate_owner: 'gate:m0-census' }],
    ['task-other', { id: 'task-other', squad_id: OTHER_SQUAD_ID, status: 'in_progress', gate_owner: null }],
  ])
  const verdicts = new Map<string, 'approved' | 'rejected'>()
  const events: unknown[] = []
  const outbox = new Map<string, {
    id: string; tenant: string; flight_id: string; event_type: 'flight.landed'; actor_kind: 'member' | 'agent';
    actor_id: string; payload: string; created_at: string; delivered_at: string | null; consumed_at: string | null;
    attempts: number; last_error: string | null
  }>()
  let busFailure = false
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'mmhq', name: 'Mumega HQ', charter: null, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'other', name: 'Other', charter: null, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' }],
  ])
  const agents = new Map<string, { id: string; squad_id: string; slug: string; name: string; role: null; model: null; status: 'active' | 'paused'; created_at: string }>()
  if (agentStatus) {
    agents.set(AGENT_ID, { id: AGENT_ID, squad_id: SQUAD_ID, slug: 'product', name: 'Product', role: null, model: null, status: agentStatus, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' } as never)
  }
  const env = {
    TENANT_SLUG: TENANT,
    SESSIONS: {
      async get(key: string, type?: string) {
        const value = cursors.get(key) ?? null
        return type === 'json' && value ? JSON.parse(value) : value
      },
      async put(key: string, value: string) {
        cursors.set(key, value)
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM agents WHERE id = ?1')) return (agents.get(args[0] as string) ?? null) as T | null
                if (sql.includes('FROM squads WHERE id = ?1')) return (squads.get(args[0] as string) ?? null) as T | null
                if (sql.includes('SELECT department_id FROM squads')) {
                  const squad = squads.get(args[0] as string)
                  return (squad ? { department_id: squad.department_id } : null) as T | null
                }
                if (sql.includes('SELECT id, squad_id FROM tasks')) return (tasks.get(args[0] as string) ?? null) as T | null
                if (sql.includes('SELECT * FROM flights WHERE id=')) {
                  const row = rows.get(args[0] as string)
                  return (row?.tenant === args[1] ? row : null) as T | null
                }
                if (sql.includes('FROM flight_event_outbox')) {
                  return ([...outbox.values()].find((row) => (
                    row.tenant === args[0] && row.flight_id === args[1] && row.delivered_at === null
                  )) ?? null) as T | null
                }
                return null
              },
              async run() {
                let changes = 0
                if (sql.includes('INSERT INTO flights (')) {
                  const [id, tenant, agent, goal, trigger, budget, rawMeta] = args as [string, string, string, string, FlightRow['trigger_source'], number | null, string]
                  rows.set(id, {
                    id, tenant, agent, goal, trigger_source: trigger, budget_micro_usd: budget,
                    status: 'preflight', gate_verdict: null, gate_reason: '', score: null,
                    cost_micro_usd: 0, next_run_at: null, created_at: Date.now(), started_at: null,
                    ended_at: null, meta: rawMeta,
                  })
                  changes = 1
                } else if (sql.includes("status='running', gate_verdict='go'")) {
                  const row = rows.get(args[0] as string)
                  if (row && row.tenant === args[1] && row.status === 'preflight') {
                    row.status = 'running'
                    row.gate_verdict = 'go'
                    row.score = args[2] as number
                    row.started_at = args[3] as number
                    changes = 1
                  }
                } else if (sql.includes("UPDATE flights SET status='landed'")) {
                  beforeFlightLand?.()
                  beforeFlightLand = null
                  const row = rows.get(args[0] as string)
                  const governed = sql.includes('json_each(flights.meta')
                  const governedTasksComplete = !governed || (() => {
                    if (!row) return false
                    const taskIds = (JSON.parse(row.meta) as { task_ids: string[] }).task_ids
                    return taskIds.every((taskId) => {
                      const task = tasks.get(taskId)
                      return task?.status === 'done' && (!task.gate_owner || verdicts.get(taskId) === 'approved')
                    })
                  })()
                  const expectedAgent = governed ? args[2] as string | null : null
                  const costIndex = governed ? 3 : 2
                  const scoreIndex = governed ? 4 : 3
                  const endedIndex = governed ? 5 : 4
                  const governedBudgetValid = !governed || (
                    typeof row?.budget_micro_usd === 'number' && (args[costIndex] as number) <= row.budget_micro_usd
                  )
                  if (
                    row && row.tenant === args[1]
                    && (!expectedAgent || row.agent === expectedAgent)
                    && ['running', 'waiting', 'sleeping'].includes(row.status)
                    && governedTasksComplete && governedBudgetValid
                  ) {
                    row.status = 'landed'
                    row.cost_micro_usd = args[costIndex] as number
                    row.score = (args[scoreIndex] as number | null) ?? row.score
                    row.ended_at = args[endedIndex] as number
                    changes = 1
                  }
                } else if (sql.includes('INSERT INTO flight_event_outbox')) {
                  const [id, tenant, flightId, actorKind, actorId, payload, createdAt, endedAt] = args as [
                    string, string, string, 'member' | 'agent', string, string, string, number,
                  ]
                  const flight = rows.get(flightId)
                  if (flight?.tenant === tenant && flight.status === 'landed' && flight.ended_at === endedAt) {
                    const eventPayload = JSON.parse(payload) as Record<string, unknown>
                    eventPayload.score = flight.score
                    eventPayload.cost_micro_usd = flight.cost_micro_usd
                    outbox.set(flightId, {
                      id, tenant, flight_id: flightId, event_type: 'flight.landed', actor_kind: actorKind,
                      actor_id: actorId, payload: JSON.stringify(eventPayload), created_at: createdAt,
                      delivered_at: null, consumed_at: null, attempts: 0, last_error: null,
                    })
                    changes = 1
                  }
                } else if (sql.includes('delivered_at = ?3')) {
                  const row = outbox.get(args[1] as string)
                  if (row?.tenant === args[0] && row.delivered_at === null) {
                    row.delivered_at = args[2] as string
                    row.attempts += 1
                    changes = 1
                  }
                } else if (sql.includes('last_error = ?3')) {
                  const row = outbox.get(args[1] as string)
                  if (row?.tenant === args[0] && row.delivered_at === null) {
                    row.last_error = args[2] as string
                    row.attempts += 1
                    changes = 1
                  }
                }
                return { meta: { changes } }
              },
              async all<T>() {
                if (sql.includes('FROM flight_event_outbox')) {
                  const limit = args[1] as number
                  return { results: [...outbox.values()].filter((row) => (
                    row.tenant === args[0] && row.delivered_at === null
                  )).slice(0, limit) as T[] }
                }
                if (sql.includes('FROM squads WHERE id IN')) {
                  return { results: args.flatMap((id) => {
                    const squad = squads.get(id as string)
                    return squad ? [squad] : []
                  }) as T[] }
                }
                if (sql.includes('SELECT id, squad_id FROM tasks WHERE id IN')) {
                  return { results: args.flatMap((id) => {
                    const task = tasks.get(id as string)
                    return task ? [task] : []
                  }) as T[] }
                }
                if (sql.includes('SELECT id, status') && sql.includes('FROM tasks WHERE id IN')) {
                  return { results: args.flatMap((id) => {
                    const task = tasks.get(id as string)
                    return task ? [{
                      id: task.id,
                      status: task.status,
                      gate_owner: task.gate_owner,
                      latest_verdict: verdicts.get(task.id) ?? null,
                    }] : []
                  }) as T[] }
                }
                if (sql.includes('json_each')) {
                  const [tenant, squadId, beforeAt, , beforeId, limit] = args as [string, string, number, number, string, number]
                  const flights = [...rows.values()]
                    .filter((row) => row.tenant === tenant)
                    .filter((row) => {
                      try {
                        return (JSON.parse(row.meta) as { squad_ids?: string[] }).squad_ids?.includes(squadId) ?? false
                      } catch {
                        return false
                      }
                    })
                    .filter((row) => row.created_at < beforeAt || (row.created_at === beforeAt && row.id < beforeId))
                    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
                    .slice(0, limit)
                  return { results: flights as T[] }
                }
                return { results: [...rows.values()] as T[] }
              },
            }
          },
        }
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()))
      },
    },
    BUS: {
      async send(event: unknown) {
        if (busFailure) throw new Error('queue unavailable')
        events.push(event)
      },
    },
  } as unknown as Env
  return {
    env,
    rows,
    tasks,
    verdicts,
    events,
    outbox,
    setBusFailure(value: boolean) { busFailure = value },
    beforeNextFlightLand(hook: () => void) { beforeFlightLand = hook },
  }
}

const dispatchArgs = {
  squad_id: SQUAD_ID,
  goal: 'Run the Mumega tenant-zero census',
  budget_micro_usd: 0,
  meta_json: JSON.stringify(meta),
  signals_json: JSON.stringify(signals),
}

describe('MCP flight tools', () => {
  it('advertises scoped flight lifecycle tools', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(['flight_dispatch', 'flight_get', 'flight_list', 'flight_land']))
  })

  it('dispatches as the server-bound agent and persists v1 metadata', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')

    expect(out.ok, JSON.stringify(out)).toBe(true)
    const result = out.result as { flight: FlightRow & { meta: typeof meta } }
    expect(result.flight.agent).toBe(AGENT_ID)
    expect(result.flight.status).toBe('running')
    expect(result.flight.meta).toEqual(meta)
  })

  it('requires a stable bound agent identity', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth({ boundAgentId: null }), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('agent_binding_required')
  })

  it('refuses a missing or paused bound agent', async () => {
    const missing = await invokeTool(auth(), makeEnv(null).env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('agent_binding_invalid')

    const paused = await invokeTool(auth(), makeEnv('paused').env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    expect(paused.ok).toBe(false)
    expect(paused.error).toBe('agent_binding_inactive')
  })

  it('refuses dispatch into a squad outside the caller grant', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      meta_json: JSON.stringify({ ...meta, squad_ids: [SQUAD_ID, OTHER_SQUAD_ID] }),
    }, 'https://pot.example')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('forbidden')
  })

  it('requires lead authority for positive budget and enforces the server cap', async () => {
    const { env } = makeEnv()
    const positiveBudget = {
      ...dispatchArgs,
      budget_micro_usd: 500_000,
    }
    const member = await invokeTool(auth(), env, 'flight_dispatch', positiveBudget, 'https://pot.example')
    expect(member.ok).toBe(false)
    expect(member.error).toBe('flight_budget_forbidden')

    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const withinCap = await invokeTool(leadAuth, env, 'flight_dispatch', positiveBudget, 'https://pot.example')
    expect(withinCap.ok).toBe(true)

    const overCap = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...positiveBudget,
      budget_micro_usd: 1_000_001,
    }, 'https://pot.example')
    expect(overCap.ok).toBe(false)
    expect(overCap.error).toBe('flight_budget_exceeds_cap')
  })

  it('refuses metadata that claims a missing task', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      meta_json: JSON.stringify({ ...meta, task_ids: ['task-does-not-exist'] }),
    }, 'https://pot.example')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('flight_task_not_found')
  })

  it('does not reveal a missing squad or a task outside declared squads', async () => {
    const { env } = makeEnv()
    const missingSquad = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      meta_json: JSON.stringify({ ...meta, squad_ids: [SQUAD_ID, 'squad-missing'] }),
    }, 'https://pot.example')
    expect(missingSquad).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

    const crossSquadTask = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      meta_json: JSON.stringify({ ...meta, task_ids: ['task-other'] }),
    }, 'https://pot.example')
    expect(crossSquadTask).toMatchObject({ ok: false, status: 404, error: 'flight_task_not_found' })
  })

  it('does not distinguish missing primary squads from unauthorized squads', async () => {
    const { env } = makeEnv()
    const existingDispatch = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      squad_id: OTHER_SQUAD_ID,
      meta_json: JSON.stringify({ ...meta, squad_ids: [SQUAD_ID, OTHER_SQUAD_ID] }),
    }, 'https://pot.example')
    const missingDispatch = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      squad_id: 'squad-missing',
      meta_json: JSON.stringify({ ...meta, squad_ids: [SQUAD_ID, 'squad-missing'] }),
    }, 'https://pot.example')
    expect(existingDispatch).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(missingDispatch).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

    const existingList = await invokeTool(auth(), env, 'flight_list', { squad_id: OTHER_SQUAD_ID }, 'https://pot.example')
    const missingList = await invokeTool(auth(), env, 'flight_list', { squad_id: 'squad-missing' }, 'https://pot.example')
    expect(existingList).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(missingList).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('returns a visible flight with parsed metadata', async () => {
    const { env } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = ((dispatched.result as { flight: FlightRow }).flight).id

    const out = await invokeTool(auth(), env, 'flight_get', { flight_id: id }, 'https://pot.example')
    expect(out.ok).toBe(true)
    expect((out.result as { flight: FlightRow & { meta: typeof meta } }).flight.meta).toEqual(meta)
  })

  it('lands the bound agent own flight after every referenced task is done', async () => {
    const { env, tasks, verdicts, events } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id,
      cost_micro_usd: 0,
      score: 0.97,
    }, 'https://pot.example')

    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect((out.result as { flight: FlightRow }).flight).toMatchObject({
      id,
      agent: AGENT_ID,
      status: 'landed',
      cost_micro_usd: 0,
      score: 0.97,
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'flight.landed', tenant: TENANT, squad_id: SQUAD_ID, agent_id: AGENT_ID,
      actor: { kind: 'agent', id: AGENT_ID },
    }))
  })

  it('persists a retryable terminal event when the Queue is unavailable', async () => {
    const { env, rows, tasks, verdicts, events, outbox, setBusFailure } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    const expectedScore = rows.get(id)!.score
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')
    setBusFailure(true)

    const landed = await invokeTool(auth(), env, 'flight_land', { flight_id: id, cost_micro_usd: 0 }, 'https://pot.example')
    expect(landed.ok, JSON.stringify(landed)).toBe(true)
    expect(outbox.get(id)).toMatchObject({ delivered_at: null, attempts: 1 })
    expect(events).toEqual([])

    outbox.get(id)!.created_at = '2026-07-12T02:00:00.000Z'
    setBusFailure(false)
    await flushFlightEventOutbox(env)
    expect(outbox.get(id)).toMatchObject({ attempts: 2 })
    expect(outbox.get(id)?.delivered_at).not.toBeNull()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'flight.landed', agent_id: AGENT_ID, ts: '2026-07-12T02:00:00.000Z',
      payload: expect.objectContaining({ score: expectedScore }),
    }))
  })

  it('returns conflict when another terminal transition wins after the precheck', async () => {
    const { env, rows, tasks, verdicts, beforeNextFlightLand } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')
    beforeNextFlightLand(() => { rows.get(id)!.status = 'landed' })

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id, cost_micro_usd: 0,
    }, 'https://pot.example')

    expect(out).toMatchObject({ ok: false, status: 409, error: 'flight_transition_conflict' })
  })

  it('refuses landing when a referenced task reopens at the transition', async () => {
    const { env, rows, tasks, verdicts, beforeNextFlightLand } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')
    beforeNextFlightLand(() => { tasks.get('task-m000')!.status = 'in_progress' })

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id, cost_micro_usd: 0,
    }, 'https://pot.example')

    expect(out).toMatchObject({
      ok: false,
      status: 409,
      error: 'flight_tasks_incomplete',
      detail: { task_ids: ['task-m000'] },
    })
    expect(rows.get(id)!.status).toBe('running')
  })

  it('does not treat rejected gated work marked done as successful completion', async () => {
    const { env, tasks, verdicts } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'rejected')

    const out = await invokeTool(auth(), env, 'flight_land', { flight_id: id, cost_micro_usd: 0 }, 'https://pot.example')
    expect(out).toMatchObject({
      ok: false, status: 409, error: 'flight_tasks_incomplete', detail: { task_ids: ['task-m000'] },
    })
  })

  it('requires member write authority on every referenced flight squad', async () => {
    const { env, tasks, verdicts } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')
    const observerOnly = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'observer' },
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: OTHER_SQUAD_ID, capability: 'member' },
      ],
    })

    const out = await invokeTool(observerOnly, env, 'flight_land', { flight_id: id, cost_micro_usd: 0 }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('requires a bound active agent to land a flight', async () => {
    const { env } = makeEnv()
    const unbound = await invokeTool(auth({ boundAgentId: null }), env, 'flight_land', {
      flight_id: 'flight-id', cost_micro_usd: 0,
    }, 'https://pot.example')
    expect(unbound).toMatchObject({ ok: false, status: 409, error: 'agent_binding_required' })

    const paused = await invokeTool(auth(), makeEnv('paused').env, 'flight_land', {
      flight_id: 'flight-id', cost_micro_usd: 0,
    }, 'https://pot.example')
    expect(paused).toMatchObject({ ok: false, status: 409, error: 'agent_binding_inactive' })
  })

  it('does not reveal another agent flight through landing', async () => {
    const { env, rows } = makeEnv()
    rows.set('other-flight', {
      id: 'other-flight', tenant: TENANT, agent: 'agent-other', goal: 'other', status: 'running',
      trigger_source: 'api', gate_verdict: 'go', gate_reason: '', score: 1,
      budget_micro_usd: 0, cost_micro_usd: 0, next_run_at: null, created_at: 1,
      started_at: 1, ended_at: null, meta: JSON.stringify(meta),
    })
    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: 'other-flight', cost_micro_usd: 0,
    }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 404, error: 'flight_not_found' })
  })

  it('refuses landing before every referenced task is done', async () => {
    const { env } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id, cost_micro_usd: 0,
    }, 'https://pot.example')
    expect(out).toMatchObject({
      ok: false,
      status: 409,
      error: 'flight_tasks_incomplete',
      detail: { task_ids: ['task-m000'] },
    })
  })

  it('refuses cost above the declared flight budget', async () => {
    const { env, tasks, verdicts } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id, cost_micro_usd: 1,
    }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 409, error: 'flight_budget_exceeded' })
  })

  it('refuses landing a flight outside an in-air state', async () => {
    const { env, rows, tasks, verdicts } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = (dispatched.result as { flight: FlightRow }).flight.id
    tasks.get('task-m000')!.status = 'done'
    verdicts.set('task-m000', 'approved')
    rows.get(id)!.status = 'landed'

    const out = await invokeTool(auth(), env, 'flight_land', {
      flight_id: id, cost_micro_usd: 0,
    }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 409, error: 'flight_not_in_air' })
  })

  it('requires read authority on every squad referenced by a flight', async () => {
    const { env } = makeEnv()
    const bothSquads = [
      { member_id: MEMBER_ID, scope_type: 'squad' as const, scope_id: SQUAD_ID, capability: 'member' as const },
      { member_id: MEMBER_ID, scope_type: 'squad' as const, scope_id: OTHER_SQUAD_ID, capability: 'member' as const },
    ]
    const dispatched = await invokeTool(auth({ capabilities: bothSquads }), env, 'flight_dispatch', {
      ...dispatchArgs,
      meta_json: JSON.stringify({ ...meta, squad_ids: [SQUAD_ID, OTHER_SQUAD_ID] }),
    }, 'https://pot.example')
    expect(dispatched.ok).toBe(true)
    const id = (dispatched.result as { flight: FlightRow }).flight.id

    const get = await invokeTool(auth(), env, 'flight_get', { flight_id: id }, 'https://pot.example')
    expect(get.ok).toBe(false)
    expect(get).toMatchObject({ status: 404, error: 'flight_not_found' })

    const list = await invokeTool(auth(), env, 'flight_list', { squad_id: SQUAD_ID }, 'https://pot.example')
    expect(list.ok).toBe(true)
    expect((list.result as { flights: FlightRow[] }).flights).toEqual([])
  })

  it('does not reveal whether a probed flight has legacy metadata', async () => {
    const { env, rows } = makeEnv()
    rows.set('legacy-flight', {
      id: 'legacy-flight', tenant: TENANT, agent: AGENT_ID, goal: 'legacy', status: 'landed',
      trigger_source: 'manual', gate_verdict: 'go', gate_reason: '', score: 1,
      budget_micro_usd: null, cost_micro_usd: 0, next_run_at: null, created_at: 1,
      started_at: 1, ended_at: 2, meta: '{}',
    })
    const legacy = await invokeTool(auth(), env, 'flight_get', { flight_id: 'legacy-flight' }, 'https://pot.example')
    const absent = await invokeTool(auth(), env, 'flight_get', { flight_id: 'absent-flight' }, 'https://pot.example')
    expect(legacy).toMatchObject({ ok: false, status: 404, error: 'flight_not_found' })
    expect(absent).toMatchObject({ ok: false, status: 404, error: 'flight_not_found' })
  })

  it('paginates past newer flights hidden by multi-squad visibility', async () => {
    const { env, rows } = makeEnv()
    const makeRow = (id: string, createdAt: number, rowMeta: unknown): FlightRow => ({
      id, tenant: TENANT, agent: AGENT_ID, goal: id, status: 'running', trigger_source: 'api',
      gate_verdict: 'go', gate_reason: '', score: 1, budget_micro_usd: 0, cost_micro_usd: 0,
      next_run_at: null, created_at: createdAt, started_at: createdAt, ended_at: null,
      meta: JSON.stringify(rowMeta),
    })
    rows.set('visible-old', makeRow('visible-old', 1, meta))
    for (let index = 0; index < 501; index += 1) {
      rows.set(`hidden-${index}`, makeRow(`hidden-${index}`, index + 2, {
        ...meta,
        squad_ids: [SQUAD_ID, OTHER_SQUAD_ID],
      }))
    }

    const first = await invokeTool(auth(), env, 'flight_list', { squad_id: SQUAD_ID, limit: 1 }, 'https://pot.example')
    expect(first.ok).toBe(true)
    const firstResult = first.result as { flights: FlightRow[]; cursor: string; has_more: boolean }
    expect(firstResult.flights).toEqual([])
    expect(firstResult.has_more).toBe(true)
    expect(firstResult.cursor).not.toContain('hidden')
    expect(firstResult.cursor).not.toContain(':')

    const second = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      limit: 1,
      cursor: firstResult.cursor,
    }, 'https://pot.example')
    expect(second.ok).toBe(true)
    expect((second.result as { flights: FlightRow[] }).flights.map((flight) => flight.id)).toEqual(['visible-old'])
  })
})

describe('MCP granted multi-squad flight lifecycle', () => {
  it('re-authenticates the same Product bearer through assignment, dispatch, read, task completion, and landing', async () => {
    const harness = createSqliteD1()
    const events: unknown[] = []
    try {
      const productTokenHash = await sha256Hex(PRODUCT_TOKEN)
      harness.sqlite.exec(`
        CREATE TABLE departments (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
        CREATE TABLE squads (
          id TEXT PRIMARY KEY, department_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
          charter TEXT, budget_cap_cents INTEGER, budget_window TEXT NOT NULL DEFAULT 'day',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agents (
          id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member', model TEXT NOT NULL DEFAULT 'test',
          status TEXT NOT NULL DEFAULT 'active', budget_cap_cents INTEGER,
          budget_window TEXT NOT NULL DEFAULT 'day', created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE members (
          id TEXT PRIMARY KEY, email TEXT, display_name TEXT NOT NULL, telegram_chat_id TEXT,
          status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')),
          tenant TEXT NOT NULL
        );
        CREATE TABLE member_tokens (
          id TEXT PRIMARY KEY, member_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT 'workspace',
          created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT,
          agent_id TEXT, tenant TEXT NOT NULL
        );
        CREATE TABLE capabilities (
          id TEXT PRIMARY KEY, member_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
          capability TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (member_id, scope_type, scope_id)
        );
        CREATE TABLE channel_capability_grants (
          id TEXT PRIMARY KEY, member_id TEXT NOT NULL, squad_id TEXT NOT NULL, capability TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          done_when TEXT NOT NULL, status TEXT NOT NULL, assignee_agent_id TEXT, github_issue_url TEXT,
          result TEXT, completed_at TEXT, gate_owner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE task_verdicts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT,
          decided_by TEXT NOT NULL, decided_at TEXT NOT NULL
        );
        CREATE TABLE flights (
          id TEXT PRIMARY KEY, tenant TEXT NOT NULL, agent TEXT NOT NULL, goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'preflight', trigger_source TEXT NOT NULL DEFAULT 'manual',
          gate_verdict TEXT, gate_reason TEXT NOT NULL DEFAULT '', score REAL, budget_micro_usd INTEGER,
          cost_micro_usd INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), started_at INTEGER,
          ended_at INTEGER, meta TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE flight_event_outbox (
          id TEXT PRIMARY KEY, tenant TEXT NOT NULL, flight_id TEXT NOT NULL, event_type TEXT NOT NULL,
          actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
          delivered_at TEXT, consumed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
          UNIQUE (tenant, flight_id, event_type)
        );

        INSERT INTO departments VALUES ('dept-home', 'home', 'Home');
        INSERT INTO departments VALUES ('dept-other', 'other', 'Other');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-home', 'mmhq', 'Mumega HQ');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('${OTHER_SQUAD_ID}', 'dept-other', 'other', 'Other');
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'product', 'Product');
        INSERT INTO members (id, display_name, status, tenant)
        VALUES ('${MEMBER_ID}', 'Product', 'active', '${TENANT}');
        INSERT INTO members (id, display_name, status, tenant)
        VALUES ('member-operator', 'Operator', 'active', '${TENANT}');
        INSERT INTO member_tokens (id, member_id, token_hash, revoked_at, agent_id, tenant)
        VALUES ('token-product', '${MEMBER_ID}', '${productTokenHash}', NULL, '${AGENT_ID}', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-home', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
        INSERT INTO tasks
          (id, squad_id, title, body, done_when, status, assignee_agent_id, github_issue_url,
           result, completed_at, gate_owner, created_at, updated_at)
        VALUES
          ('task-m000', '${OTHER_SQUAD_ID}', 'Cross-squad census', '', 'the census hash verifies',
           'in_progress', NULL, NULL, NULL, NULL, NULL,
           '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
      `)
      const env = {
        TENANT_SLUG: TENANT,
        DB: harness.db,
        BUS: { send: async (event: unknown) => { events.push(event) } },
      } as unknown as Env
      const operatorAuth = auth({
        userId: 'member-operator',
        memberId: 'member-operator',
        boundAgentId: null,
        role: 'admin',
        capabilities: [{
          member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin',
        }],
      })

      const granted = await invokeTool(operatorAuth, env, 'grant_agent_capability', {
        agent: AGENT_ID,
        squad: OTHER_SQUAD_ID,
        capability: 'member',
      }, 'https://pot.example')
      expect(granted).toMatchObject({ ok: true, result: { result: 'created' } })

      const assigned = await authenticatedTool(env, 'task_update', {
        squad_id: OTHER_SQUAD_ID,
        task_id: 'task-m000',
        assignee_agent_id: AGENT_ID,
      })
      expect(assigned).toMatchObject({
        ok: true,
        result: { task: { assignee_agent_id: AGENT_ID } },
      })

      const lifecycleMeta = { ...meta, squad_ids: [SQUAD_ID, OTHER_SQUAD_ID] }
      const dispatched = await authenticatedTool(env, 'flight_dispatch', {
        ...dispatchArgs,
        meta_json: JSON.stringify(lifecycleMeta),
      })
      expect(dispatched.ok).toBe(true)
      const flightId = (dispatched.result.flight as FlightRow).id

      const read = await authenticatedTool(env, 'flight_get', { flight_id: flightId })
      expect(read).toMatchObject({ ok: true, result: { flight: { id: flightId, status: 'running' } } })

      const completed = await authenticatedTool(env, 'task_update', {
        squad_id: OTHER_SQUAD_ID,
        task_id: 'task-m000',
        status: 'done',
      })
      expect(completed).toMatchObject({ ok: true, result: { task: { id: 'task-m000', status: 'done' } } })
      expect(harness.sqlite.prepare("SELECT assignee_agent_id, status FROM tasks WHERE id = 'task-m000'").get()).toEqual({
        assignee_agent_id: AGENT_ID,
        status: 'done',
      })

      const landed = await authenticatedTool(env, 'flight_land', {
        flight_id: flightId,
        cost_micro_usd: 0,
      })
      expect(landed).toMatchObject({ ok: true, result: { flight: { id: flightId, status: 'landed' } } })
      expect(events).toContainEqual(expect.objectContaining({ type: 'flight.landed', agent_id: AGENT_ID }))
    } finally {
      harness.close()
    }
  })
})

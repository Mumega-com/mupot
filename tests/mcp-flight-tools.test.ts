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

function makeEnv(
  agentStatus: 'active' | 'paused' | null = 'active',
  inboxFull = false,
  extraAgents: Array<{ id: string; squad_id: string; status: 'active' | 'paused'; budget_cap_cents: number | null }> = [],
) {
  const rows = new Map<string, FlightRow>()
  const cursors = new Map<string, string>()
  let beforeFlightLand: (() => void) | null = null
  const tasks = new Map<string, { id: string; squad_id: string; project_id: string | null; status: 'in_progress' | 'review' | 'approved' | 'done'; gate_owner: string | null }>([
    ['task-m000', { id: 'task-m000', squad_id: SQUAD_ID, project_id: null, status: 'in_progress', gate_owner: 'gate:m0-census' }],
    ['task-other', { id: 'task-other', squad_id: OTHER_SQUAD_ID, project_id: null, status: 'in_progress', gate_owner: null }],
  ])
  const verdicts = new Map<string, 'approved' | 'rejected'>()
  const events: unknown[] = []
  const outbox = new Map<string, {
    id: string; tenant: string; flight_id: string; event_type: 'flight.landed'; actor_kind: 'member' | 'agent';
    actor_id: string; payload: string; created_at: string; delivered_at: string | null; consumed_at: string | null;
    attempts: number; last_error: string | null
  }>()
  let busFailure = false
  // flight_dispatch now sends a flight.dispatch/v1 envelope (#860). The unread cap is
  // enforced inside the INSERT, so a mock that does not model agent_messages reports
  // 0 changes and the sender reads that as inbox_full.
  const delivered: { toAgent: string; body: string; kind: string; requestId: string | null }[] = []
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'mmhq', name: 'Mumega HQ', charter: null, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'other', name: 'Other', charter: null, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' }],
  ])
  const agents = new Map<string, { id: string; squad_id: string; slug: string; name: string; role: null; model: null; status: 'active' | 'paused'; created_at: string }>()
  if (agentStatus) {
    agents.set(AGENT_ID, { id: AGENT_ID, squad_id: SQUAD_ID, slug: 'product', name: 'Product', role: null, model: null, status: agentStatus, budget_cap_cents: 100, budget_window: 'day', created_at: 'now' } as never)
  }
  for (const extra of extraAgents) {
    agents.set(extra.id, {
      id: extra.id, squad_id: extra.squad_id, slug: extra.id, name: extra.id, role: null, model: null,
      status: extra.status, budget_cap_cents: extra.budget_cap_cents, budget_window: 'day', created_at: 'now',
    } as never)
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
                if (sql.includes('SELECT id, squad_id') && sql.includes('FROM tasks')) return (tasks.get(args[0] as string) ?? null) as T | null
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
                if (sql.includes('INSERT INTO agent_messages')) {
                  delivered.push({
                    toAgent: String(args[2] ?? ''),
                    body: String(args[6] ?? ''),
                    kind: String(args[5] ?? ''),
                    requestId: args[7] == null ? null : String(args[7]),
                  })
                  return { meta: { changes: inboxFull ? 0 : 1 } }
                }
                if (sql.includes('INSERT INTO flights (')) {
                  const [id, tenant, projectId, agent, dispatchedBy, goal, trigger, budget, rawMeta] = args as [string, string, string | null, string, string, string, FlightRow['trigger_source'], number | null, string]
                  rows.set(id, {
                    id, tenant, project_id: projectId, agent, dispatched_by_agent_id: dispatchedBy, goal, trigger_source: trigger, budget_micro_usd: budget,
                    status: 'preflight', gate_verdict: null, gate_reason: '', score: null,
                    cost_micro_usd: 0, next_run_at: null, created_at: Date.now(), started_at: null,
                    ended_at: null, meta: rawMeta,
                  })
                  changes = 1
                } else if (sql.includes("status='held', gate_verdict='no_go'")) {
                  const row = rows.get(args[0] as string)
                  if (row && row.tenant === args[1] && row.status === 'preflight') {
                    row.status = 'held'
                    row.gate_verdict = 'no_go'
                    row.gate_reason = args[2] as string
                    row.score = args[3] as number
                    row.ended_at = args[4] as number
                    changes = 1
                  }
                } else if (sql.includes("status='failed'")) {
                  const row = rows.get(args[0] as string)
                  if (row && row.tenant === args[1] && ['preflight', 'running', 'waiting', 'sleeping'].includes(row.status)) {
                    row.status = 'failed'
                    row.gate_reason = args[2] as string
                    row.ended_at = args[3] as number
                    changes = 1
                  }
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
                  // #916: the receipt INSERT no longer re-reads the flights row it was
                  // just written by, so it no longer binds ended_at as an 8th arg and no
                  // longer re-derives score/cost from the row — the caller bakes the
                  // landed values into the payload before inserting. This double models
                  // the new contract; the correlation it used to enforce via ended_at is
                  // now enforced by control flow, because the insert only runs after the
                  // transition has been confirmed to have changed exactly one row.
                  // [mupot#919, RETRACTED] This used to justify dropping the second read
                  // by asserting "that read is exactly what production D1 could not see
                  // inside a batch" as settled fact — that mechanism is unconfirmed; see
                  // the retraction note in tests/flight-land-receipt-916.test.ts.
                  const [id, tenant, flightId, actorKind, actorId, payload, createdAt] = args as [
                    string, string, string, 'member' | 'agent', string, string, string,
                  ]
                  const flight = rows.get(flightId)
                  if (flight?.tenant === tenant && flight.status === 'landed' && !outbox.has(flightId)) {
                    const eventPayload = JSON.parse(payload) as Record<string, unknown>
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
                // #916: the landing transition now carries `RETURNING score,
                // cost_micro_usd`, so it is issued through all() rather than run(). Reuse
                // run()'s mutation and hand back the landed row — the caller needs the
                // FINAL score, which survives COALESCE when no score was supplied.
                if (sql.includes("UPDATE flights SET status='landed'")) {
                  const ran = await this.run() as { meta: { changes: number } }
                  const row = rows.get(args[0] as string)
                  return {
                    results: (ran.meta.changes === 1 && row
                      ? [{ score: row.score, cost_micro_usd: row.cost_micro_usd }]
                      : []) as T[],
                    meta: ran.meta,
                  }
                }
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
                if (sql.includes('SELECT id, squad_id') && sql.includes('FROM tasks WHERE id IN')) {
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
    squads,
    delivered,
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

  // #860: the tool is named flight_dispatch and it did not dispatch. It created the
  // row, scored it, returned — and the assigned seat's inbox stayed empty, so the
  // flight sat in `running` with nobody told. Proven live on flight 9f5e0147, which
  // passed preflight (go, 0.967) while inbox(peek) returned {"messages":[]}.
  it('sends a flight.dispatch/v1 envelope to the flight\'s own agent', async () => {
    const { env, delivered } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')

    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect((out.result as { delivered: boolean }).delivered).toBe(true)

    expect(delivered).toHaveLength(1)
    const sent = delivered[0]!
    expect(sent.toAgent).toBe(AGENT_ID)
    expect(sent.kind).toBe('request')

    const envelope = JSON.parse(sent.body) as Record<string, unknown>
    // NOT routine.run/v1: that envelope carries run_id, project_id, routine_revision
    // and situation_digest. An API flight has none, and forging them would make it
    // impersonate a routine run no scheduler owns.
    expect(envelope.version).toBe('flight.dispatch/v1')
    expect(envelope.flight_id).toBe((out.result as { flight: FlightRow }).flight.id)
    expect(envelope.done_when).toEqual(meta.done_when)
    expect(envelope.task_ids).toEqual(meta.task_ids)
    expect(envelope.land_with).toBe('flight_land')
    expect(sent.requestId).toBe(`flight.${(out.result as { flight: FlightRow }).flight.id}`)
  })

  it('does not send when preflight holds the flight — the gate precedes the send', async () => {
    // The other half of #861: the routine path sends first and then stamps go/1.
    // Ordering is the guarantee, so an empty-signals dispatch must reach nobody.
    const { env, delivered } = makeEnv()
    const out = await invokeTool(
      auth(),
      env,
      'flight_dispatch',
      { ...dispatchArgs, signals_json: JSON.stringify({ ...signals, contextComplete: false, toolsReachable: false }) },
      'https://pot.example',
    )

    expect(out.ok, JSON.stringify(out)).toBe(true)
    const result = out.result as { flight: FlightRow; delivered: boolean; preflight: { go: boolean; reasons: string[] } }
    expect(result.preflight.go).toBe(false)
    expect(result.preflight.reasons).toEqual(expect.arrayContaining(['context_incomplete', 'tools_unreachable']))
    expect(result.flight.status).toBe('held')
    expect(result.delivered).toBe(false)
    expect(delivered).toHaveLength(0)
  })

  it('fails the flight when delivery fails, so `running` never means nobody was told', async () => {
    // A flight left running with an empty recipient inbox is indistinguishable from a
    // stalled one — the exact shape of the six phantom flights on this board.
    const { env, rows } = makeEnv('active', true)
    const out = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')

    expect(out.ok).toBe(false)
    expect(out.error).toBe('flight_dispatch_delivery_failed')
    const detail = out.detail as { flight_id: string; reason: string }
    expect(detail.reason).toBe('inbox_full')

    const row = rows.get(detail.flight_id)
    expect(row?.status).not.toBe('running')
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

  // ── executor delegation (flight_dispatch executor-delegation defect) ─────────
  // Delegating a flight to another agent's seat causes work to appear under that
  // agent's identity and consume their budget — gated exactly like wake_agent
  // gates "make another agent act": lead+ on the EXECUTOR's own squad, no
  // executor consent sought or required (matching wake_agent's posture).
  const DELEGATE_AGENT_ID = 'agent-delegate'

  it('omitting executor_agent_id dispatches under the caller\'s own seat, byte-identical to pre-delegation behaviour', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const flight = (out.result as { flight: FlightRow }).flight
    expect(flight.agent).toBe(AGENT_ID)
    expect(flight.dispatched_by_agent_id).toBe(AGENT_ID)
  })

  it('refuses to delegate a flight to another agent without lead on the executor\'s squad', async () => {
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: 100 },
    ])
    // auth() only grants 'member' on SQUAD_ID — sufficient to dispatch under one's
    // own seat, NOT sufficient to make agent-delegate fly instead.
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
    }, 'https://pot.example')
    expect(out).toMatchObject({
      ok: false, status: 403, error: 'flight_delegation_forbidden',
      detail: { need: 'lead', scope: 'squad', squad_id: SQUAD_ID },
    })
  })

  it('allows delegation with lead on the executor\'s squad — BOTH executor and dispatcher stay recoverable, neither overwrites the other', async () => {
    const { env, delivered } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: 100 },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const out = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
    }, 'https://pot.example')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const flight = (out.result as { flight: FlightRow }).flight
    // flight.agent is NEVER overwritten to hide who dispatched — it stays the
    // EXECUTOR. dispatched_by_agent_id independently carries the dispatcher.
    expect(flight.agent).toBe(DELEGATE_AGENT_ID)
    expect(flight.dispatched_by_agent_id).toBe(AGENT_ID)
    // No executor consent was sought: agent-delegate had no chance to accept or
    // refuse, matching wake_agent's posture — the work envelope is sent straight
    // to the executor's inbox.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.toAgent).toBe(DELEGATE_AGENT_ID)
  })

  it('refuses delegation to a paused or unknown executor agent', async () => {
    const { env: pausedEnv } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'paused', budget_cap_cents: 100 },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const paused = await invokeTool(leadAuth, pausedEnv, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
    }, 'https://pot.example')
    expect(paused).toMatchObject({ ok: false, status: 409, error: 'executor_agent_inactive' })

    const { env: bareEnv } = makeEnv()
    const unknown = await invokeTool(leadAuth, bareEnv, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: 'agent-does-not-exist',
    }, 'https://pot.example')
    expect(unknown).toMatchObject({ ok: false, status: 404, error: 'executor_agent_not_found' })
  })

  it('a delegated flight\'s budget ceiling is governed by the EXECUTOR\'s cap, not the dispatcher\'s', async () => {
    // execute.ts's meter (checkAndReserve) enforces agents.budget_cap_cents keyed
    // to whichever agent's Durable Object actually runs the cycle — the executor.
    // agent-delegate's cap (50) is lower than AGENT_ID's (100) and the squad's
    // (100); a ceiling that (wrongly) used the dispatcher's cap would compute
    // min(100,100)=100 -> 1,000,000 microUSD and ADMIT 600,000. The fix computes
    // min(50,100)=50 -> 500,000 microUSD and REFUSES it.
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: 50 },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const overExecutorCap = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
      budget_micro_usd: 600_000,
    }, 'https://pot.example')
    expect(overExecutorCap).toMatchObject({
      ok: false, status: 409, error: 'flight_budget_exceeds_cap', detail: { cap_micro_usd: 500_000 },
    })

    const withinExecutorCap = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
      budget_micro_usd: 500_000,
    }, 'https://pot.example')
    expect(withinExecutorCap.ok, JSON.stringify(withinExecutorCap)).toBe(true)
  })

  // ── an unset budget cap means UNLIMITED (mupot#1148) ─────────────────────────
  // meter.ts:151-156 already resolves null/<=0 to "no dollar cap". The dispatch
  // gate used to resolve the SAME value to "refuse the flight" — one predicate,
  // two copies, opposite meanings. Since budget_cap_cents is nullable with no
  // default on both agents and squads (0009_work_unit.sql) and the create paths
  // leave it null whenever omitted, admission refused nearly every budgeted
  // flight that enforcement would have allowed. Dara's FLIGHT-06 saw 4000000,
  // 400000 and 1 fail identically — the amount was never the variable.

  it('dispatches when the executor agent has no cap, and reports it as uncapped', async () => {
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: null },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
      budget_micro_usd: 500_000,
    }, 'https://pot.example')

    expect(result.ok, JSON.stringify(result)).toBe(true)
    // Uncapped must be an OBSERVABLE state, not an absence — otherwise a flight
    // running with no dollar ceiling is indistinguishable from a capped one.
    expect((result as { result: { budget_uncapped: unknown[] } }).result.budget_uncapped).toEqual([
      { kind: 'agent', id: DELEGATE_AGENT_ID, slug: DELEGATE_AGENT_ID },
    ])
  })

  it('a squad with no cap does not block the flight, and is named as uncapped', async () => {
    const { env, squads } = makeEnv()
    squads.set(SQUAD_ID, { ...squads.get(SQUAD_ID)!, budget_cap_cents: null as never })
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      budget_micro_usd: 500_000,
    }, 'https://pot.example')

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect((result as { result: { budget_uncapped: unknown[] } }).result.budget_uncapped).toEqual([
      { kind: 'squad', id: SQUAD_ID, slug: 'mmhq' },
    ])
  })

  it('names BOTH uncapped rows when neither agent nor squad has a cap', async () => {
    const { env, squads } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: null },
    ])
    squads.set(SQUAD_ID, { ...squads.get(SQUAD_ID)!, budget_cap_cents: null as never })
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
      budget_micro_usd: 500_000,
    }, 'https://pot.example')

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect((result as { result: { budget_uncapped: unknown[] } }).result.budget_uncapped).toEqual([
      { kind: 'agent', id: DELEGATE_AGENT_ID, slug: DELEGATE_AGENT_ID },
      { kind: 'squad', id: SQUAD_ID, slug: 'mmhq' },
    ])
  })

  it('an UNCAPPED row never becomes the binding minimum — the configured one governs', async () => {
    // This is the case a naive "treat null as 0" fix gets wrong: the executor is
    // uncapped and the squad is capped at 100 (= 1_000_000 microUSD). Unlimited
    // must not collapse to zero and refuse, and it must not be picked as the
    // lowest either. The squad's 100 governs, so 1_000_001 is refused and named.
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: null },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const within = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs, executor_agent_id: DELEGATE_AGENT_ID, budget_micro_usd: 1_000_000,
    }, 'https://pot.example')
    expect(within.ok, JSON.stringify(within)).toBe(true)

    const over = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs, executor_agent_id: DELEGATE_AGENT_ID, budget_micro_usd: 1_000_001,
    }, 'https://pot.example')
    expect(over).toMatchObject({
      ok: false,
      status: 409,
      error: 'flight_budget_exceeds_cap',
      detail: { cap_micro_usd: 1_000_000, binding: { kind: 'squad', id: SQUAD_ID, slug: 'mmhq' } },
    })
  })

  it('a zero or negative cap reads as unlimited, matching meter.ts — not as a cap of zero', async () => {
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: 0 },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs, executor_agent_id: DELEGATE_AGENT_ID, budget_micro_usd: 1,
    }, 'https://pot.example')

    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect((result as { result: { budget_uncapped: Array<{ kind: string }> } }).result.budget_uncapped)
      .toEqual([{ kind: 'agent', id: DELEGATE_AGENT_ID, slug: DELEGATE_AGENT_ID }])
  })

  it('an uncapped flight carries its REQUESTED budget as remaining, not zero', async () => {
    // budgetCeilingMicroUsd is written into signals.budgetRemainingMicroUsd, which
    // preflight turns into budgetHeadroom (remaining >= estimate). If "unlimited"
    // collapsed the ceiling to 0, the executing agent would be handed a signal
    // saying it has NOTHING left — an uncapped flight reported as broke. Estimate
    // is set below the request so the two cases are distinguishable.
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: null },
    ])
    const { env: squadEnv, squads } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: null },
    ])
    squads.set(SQUAD_ID, { ...squads.get(SQUAD_ID)!, budget_cap_cents: null as never })
    void env
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, squadEnv, 'flight_dispatch', {
      ...dispatchArgs,
      executor_agent_id: DELEGATE_AGENT_ID,
      budget_micro_usd: 500_000,
      signals_json: JSON.stringify({ ...signals, budgetEstimateMicroUsd: 400_000 }),
    }, 'https://pot.example')

    expect(result.ok, JSON.stringify(result)).toBe(true)
    const preflight = (result as {
      result: { preflight: { go: boolean; reasons: string[] } }
    }).result.preflight
    // Collapsing the uncapped ceiling to 0 makes headroom fail, which preflight
    // reports as 'insufficient_budget' and which holds the flight at the gate.
    expect(preflight.reasons).not.toContain('insufficient_budget')
    expect(preflight.go).toBe(true)
  })

  it('flight_budget_exceeds_cap names WHICH row is the binding constraint', async () => {
    // cap_micro_usd alone gives the number but not whose it is. Executor at 50,
    // squad at 100 -> ceiling 500_000, and the row to raise is the AGENT.
    const { env } = makeEnv('active', false, [
      { id: DELEGATE_AGENT_ID, squad_id: SQUAD_ID, status: 'active', budget_cap_cents: 50 },
    ])
    const leadAuth = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
    })
    const result = await invokeTool(leadAuth, env, 'flight_dispatch', {
      ...dispatchArgs, executor_agent_id: DELEGATE_AGENT_ID, budget_micro_usd: 600_000,
    }, 'https://pot.example')

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'flight_budget_exceeds_cap',
      detail: {
        cap_micro_usd: 500_000,
        binding: { kind: 'agent', id: DELEGATE_AGENT_ID, slug: DELEGATE_AGENT_ID },
      },
    })
  })

  // ── signals_json casing (mupot#940) ───────────────────────────────────────────
  // meta_json in the SAME call uses snake_case, and the tool never documented
  // signals_json's shape — so snake_case was the natural guess, and it was
  // silently wrong: an unrecognised key read as undefined, coerced falsy, and
  // the gate scored the MISSING input as CHECKED-AND-FAILED ('tools_unreachable'
  // when the truth was "you never told me"). MEASURED: snake_case -> held/no_go,
  // score 0.005080218046913022 (the FLOOR-driven signature, not a real score);
  // camelCase -> running/go, score 0.9673638414148399.
  const snakeCaseSignals = {
    context_complete: true,
    tools_reachable: true,
    budget_remaining_micro_usd: 999_000_000,
    budget_estimate_micro_usd: 999_000_000,
    recent_progress: 0.9,
    progress_per_step: 0.8,
    waste_per_step: 0.1,
    step_seconds: 10,
  }

  it('accepts snake_case signals_json (the previously-silent-wrong casing)', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      signals_json: JSON.stringify(snakeCaseSignals),
    }, 'https://pot.example')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const result = out.result as { flight: FlightRow; preflight: { go: boolean; score: number } }
    expect(result.preflight.go).toBe(true)
    expect(result.flight.status).toBe('running')
  })

  it('still accepts camelCase signals_json (the documented canonical form)', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      signals_json: JSON.stringify(signals),
    }, 'https://pot.example')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const result = out.result as { flight: FlightRow; preflight: { go: boolean } }
    expect(result.preflight.go).toBe(true)
    expect(result.flight.status).toBe('running')
  })

  it('refuses an unrecognised key in signals_json loudly instead of silently scoring it as absent', async () => {
    const { env, rows } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      signals_json: JSON.stringify({ ...signals, contextCompete: true }), // typo'd key, real one still present
    }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 400, error: 'signals_unknown_key', detail: { key: 'contextCompete' } })
    expect(rows.size).toBe(0) // never created — refused before a flight row exists
  })

  it('refuses a missing signal field as signals_missing_fields, and NEVER reports it as tools_unreachable/context_incomplete', async () => {
    // The general lesson (mupot#940, item 4): a computed refusal reason must mean
    // "I checked and it failed", never "you didn't tell me". Deleting the two keys
    // the readiness gate reads directly (contextComplete/toolsReachable) is exactly
    // the shape that used to fabricate 'context_incomplete'/'tools_unreachable'.
    const { env, rows } = makeEnv()
    const incomplete = { ...signals } as Partial<typeof signals>
    delete incomplete.contextComplete
    delete incomplete.toolsReachable
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      signals_json: JSON.stringify(incomplete),
    }, 'https://pot.example')
    expect(out).toMatchObject({
      ok: false, status: 400, error: 'signals_missing_fields',
      detail: { missing: expect.arrayContaining(['contextComplete', 'toolsReachable']) },
    })
    expect(out.error).not.toBe('tools_unreachable')
    expect(out.error).not.toBe('context_incomplete')
    expect(rows.size).toBe(0) // never created — refused before a flight row (and its gate reasons) exist
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
    // mumega-com#970: flight_dispatch's own sendAgentMessage call (delivering the
    // flight.dispatch/v1 envelope to the bound agent's inbox) lands a message.created
    // event HERE, on the healthy Queue, BEFORE the outage below begins. That is correct
    // and unrelated to what this test is actually about — flight_land's own
    // flight.landed delivery during an outage — so pin it explicitly rather than let a
    // stale `toEqual([])` (written before message.created existed) hide it.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.created', tenant: TENANT })
    setBusFailure(true)

    const landed = await invokeTool(auth(), env, 'flight_land', { flight_id: id, cost_micro_usd: 0 }, 'https://pot.example')
    expect(landed.ok, JSON.stringify(landed)).toBe(true)
    expect(outbox.get(id)).toMatchObject({ delivered_at: null, attempts: 1 })
    // The invariant under test: a Queue outage during landing does NOT fail the landing
    // (asserted above) and does NOT put flight.landed on the bus (it goes to the outbox
    // instead, asserted above) — but it also must NOT retroactively un-land the message
    // that already went out cleanly before the outage started. `events` still holds
    // exactly that one pre-outage message.created and nothing else — no flight.landed
    // slipped onto the bus despite the failure.
    expect(events).toHaveLength(1)
    expect(events.some((e) => (e as { type: string }).type === 'flight.landed')).toBe(false)

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
      id: 'other-flight', tenant: TENANT, project_id: null, agent: 'agent-other', goal: 'other', status: 'running',
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
      id: 'legacy-flight', tenant: TENANT, project_id: null, agent: AGENT_ID, goal: 'legacy', status: 'landed',
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
      id, tenant: TENANT, project_id: null, agent: AGENT_ID, goal: id, status: 'running', trigger_source: 'api',
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
          -- migrations/0099: the bearer lookup now references these. Hand-written here
          -- because this fixture predates the real-migration harness. That is exactly
          -- why it broke: a transcribed schema is a second source of truth, and it
          -- drifts silently — the query referenced a column this table never had and
          -- every authenticated call in the file returned 500. Prefer the migration
          -- harness (tests/token-lifecycle-real-schema.test.ts) for anything new.
          expires_at TEXT, last_used_at TEXT,
          agent_id TEXT, tenant TEXT NOT NULL
        );
        CREATE TABLE agent_member_bindings (
          tenant TEXT NOT NULL, agent_id TEXT NOT NULL, member_id TEXT NOT NULL,
          created_at TEXT NOT NULL, PRIMARY KEY (tenant, agent_id), UNIQUE (tenant, member_id)
        );
        CREATE TABLE memberships (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, squad_id TEXT NOT NULL,
          capability TEXT NOT NULL, UNIQUE (agent_id, squad_id)
        );
        CREATE TABLE capabilities (
          id TEXT PRIMARY KEY, member_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
          capability TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (member_id, scope_type, scope_id)
        );
        CREATE TABLE channel_capability_grants (
          id TEXT PRIMARY KEY, member_id TEXT NOT NULL, squad_id TEXT NOT NULL, capability TEXT NOT NULL
        );
        -- NOTE (migrations/0079): priority + parent_task_id added here by hand, because this
        -- fixture hand-writes tasks instead of applying the committed migration chain.
        -- That is why this file broke on a purely-additive column: persistTaskUpdate writes
        -- every column it owns, and this schema is a SUBSET of production's. It is one of the
        -- 13 hand-written-schema tests tracked in #703, and this is the second time its
        -- fixture has blocked a feature rather than caught a bug. Fixed properly by #703;
        -- patched minimally here so a task-management change is not gated on that conversion.
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          done_when TEXT NOT NULL, status TEXT NOT NULL, priority TEXT, parent_task_id TEXT,
          assignee_agent_id TEXT, github_issue_url TEXT,
          result TEXT, completed_at TEXT, gate_owner TEXT, source_pot TEXT, external_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE task_verdicts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT,
          decided_by TEXT NOT NULL, decided_at TEXT NOT NULL
        );
        CREATE TABLE flights (
          id TEXT PRIMARY KEY, tenant TEXT NOT NULL, project_id TEXT, agent TEXT NOT NULL,
          dispatched_by_agent_id TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'preflight', trigger_source TEXT NOT NULL DEFAULT 'manual',
          gate_verdict TEXT, gate_reason TEXT NOT NULL DEFAULT '', score REAL, budget_micro_usd INTEGER,
          cost_micro_usd INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000), started_at INTEGER,
          ended_at INTEGER, meta TEXT NOT NULL DEFAULT '{}'
        );
        -- flight_dispatch delivers a flight.dispatch/v1 envelope (#860), so this
        -- lifecycle test now needs the table the send writes to. Mirrors 0032.
        CREATE TABLE agent_messages (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          id           TEXT NOT NULL UNIQUE,
          tenant       TEXT NOT NULL,
          to_agent     TEXT NOT NULL,
          from_agent   TEXT NOT NULL,
          from_member  TEXT NOT NULL,
          kind         TEXT NOT NULL DEFAULT 'message',
          body         TEXT NOT NULL,
          request_id   TEXT,
          in_reply_to  TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          read_at      TEXT,
          project_id   TEXT
        );
        CREATE TABLE agent_inbox_fences (
          tenant TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1, key_fingerprint TEXT,
          updated_by_member_id TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT NOT NULL,
          PRIMARY KEY (tenant, agent_id)
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
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-07-24T00:00:00.000Z');
        INSERT INTO member_tokens (id, member_id, token_hash, revoked_at, agent_id, tenant)
        VALUES ('token-product', '${MEMBER_ID}', '${productTokenHash}', NULL, '${AGENT_ID}', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-home', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
        INSERT INTO tasks
          (id, squad_id, title, body, done_when, status, assignee_agent_id, github_issue_url,
           result, completed_at, gate_owner, created_at, updated_at)
        VALUES
          ('task-m000', '${OTHER_SQUAD_ID}', 'Cross-squad census', '', 'the census hash verifies',
           'in_progress', NULL, NULL,
           'Census verified.
Artifact: /tmp/fixture-marker.txt
SHA256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           NULL, NULL,
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

      // NO SELF-CLOSE (fake-green guard, 2026-07-20 re-gate on PR #417): the
      // Product bearer IS the task's own assignee (agent-bound token, agent_id
      // = AGENT_ID = assignee_agent_id) — it dispatched this task and executed
      // the flight itself, so it may not ALSO be the one who marks its own
      // in_progress task 'done' with no different-principal check. That is
      // exactly the fake-green shape this guard closes. The operator (a
      // genuinely different, non-assignee principal — already used above for
      // grant_agent_capability) verifies + closes it instead. This expects a
      // non-200 (409), so it drives the real HTTP path directly rather than
      // through authenticatedTool (which asserts 200).
      const selfCloseResponse = await mcpApp.request(
        'https://pot.example/',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${PRODUCT_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool: 'task_update', args: { task_id: 'task-m000', status: 'done' } }),
        },
        env,
      )
      expect(selfCloseResponse.status).toBe(409)
      const selfCloseBody = await selfCloseResponse.json() as { ok: boolean; error?: string }
      expect(selfCloseBody).toMatchObject({ ok: false, error: 'assignee_cannot_self_close' })

      const completed = await invokeTool(operatorAuth, env, 'task_update', {
        task_id: 'task-m000',
        status: 'done',
      }, 'https://pot.example')
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

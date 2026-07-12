import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'

const TENANT = 'mumega'
const MEMBER_ID = 'member-product'
const AGENT_ID = 'agent-product'
const SQUAD_ID = 'squad-mmhq'
const OTHER_SQUAD_ID = 'squad-other'

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
  const tasks = new Map([
    ['task-m000', { id: 'task-m000', squad_id: SQUAD_ID }],
    ['task-other', { id: 'task-other', squad_id: OTHER_SQUAD_ID }],
  ])
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
                return null
              },
              async run() {
                if (sql.includes('INSERT INTO flights')) {
                  const [id, tenant, agent, goal, trigger, budget, rawMeta] = args as [string, string, string, string, FlightRow['trigger_source'], number | null, string]
                  rows.set(id, {
                    id, tenant, agent, goal, trigger_source: trigger, budget_micro_usd: budget,
                    status: 'preflight', gate_verdict: null, gate_reason: '', score: null,
                    cost_micro_usd: 0, next_run_at: null, created_at: Date.now(), started_at: null,
                    ended_at: null, meta: rawMeta,
                  })
                } else if (sql.includes("status='running', gate_verdict='go'")) {
                  const row = rows.get(args[0] as string)
                  if (row && row.tenant === args[1] && row.status === 'preflight') {
                    row.status = 'running'
                    row.gate_verdict = 'go'
                    row.score = args[2] as number
                    row.started_at = args[3] as number
                  }
                }
                return { meta: { changes: 1 } }
              },
              async all<T>() {
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
    },
  } as unknown as Env
  return { env, rows }
}

const dispatchArgs = {
  squad_id: SQUAD_ID,
  goal: 'Run the Mumega tenant-zero census',
  budget_micro_usd: 0,
  meta_json: JSON.stringify(meta),
  signals_json: JSON.stringify(signals),
}

describe('MCP flight tools', () => {
  it('advertises scoped flight dispatch and read tools', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(['flight_dispatch', 'flight_get', 'flight_list']))
  })

  it('dispatches as the server-bound agent and persists v1 metadata', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')

    expect(out.ok).toBe(true)
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
    expect(get.error).toBe('forbidden')

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

    const out = await invokeTool(auth(), env, 'flight_list', { squad_id: SQUAD_ID, limit: 1 }, 'https://pot.example')
    expect(out.ok).toBe(true)
    expect((out.result as { flights: FlightRow[] }).flights.map((flight) => flight.id)).toEqual(['visible-old'])
  })
})

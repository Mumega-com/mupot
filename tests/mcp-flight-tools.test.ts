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
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 100_000,
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

function makeEnv() {
  const rows = new Map<string, FlightRow>()
  const tasks = new Map([
    ['task-m000', { id: 'task-m000', squad_id: SQUAD_ID }],
  ])
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'mmhq', name: 'Mumega HQ', charter: null, created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'other', name: 'Other', charter: null, created_at: 'now' }],
  ])
  const env = {
    TENANT_SLUG: TENANT,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
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
  budget_micro_usd: 200_000,
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

  it('refuses dispatch into a squad outside the caller grant', async () => {
    const { env } = makeEnv()
    const out = await invokeTool(auth(), env, 'flight_dispatch', {
      ...dispatchArgs,
      squad_id: OTHER_SQUAD_ID,
      meta_json: JSON.stringify({ ...meta, squad_ids: [OTHER_SQUAD_ID] }),
    }, 'https://pot.example')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('forbidden')
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

  it('returns a visible flight with parsed metadata', async () => {
    const { env } = makeEnv()
    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', dispatchArgs, 'https://pot.example')
    const id = ((dispatched.result as { flight: FlightRow }).flight).id

    const out = await invokeTool(auth(), env, 'flight_get', { flight_id: id }, 'https://pot.example')
    expect(out.ok).toBe(true)
    expect((out.result as { flight: FlightRow & { meta: typeof meta } }).flight.meta).toEqual(meta)
  })
})

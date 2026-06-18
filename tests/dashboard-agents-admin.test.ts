import { describe, it, expect } from 'vitest'
import { loadAllAgents, loadSquadOptions } from '../src/dashboard/agents-admin'
import {
  createAgent,
  setAgentStatus,
  deleteAgent,
} from '../src/org/service'
import type { Env } from '../src/types'

// ── D1 mock ───────────────────────────────────────────────────────────────────
// Records every prepare() call (sql + binds) and returns configured rows.
// Supports multiple calls in sequence via a queue; falls back to [] rows.

interface PreparedCall {
  sql: string
  binds: unknown[]
  changes?: number // for UPDATE/DELETE meta.changes
}

function makeEnv(
  rows: unknown[][] | unknown[] = [],
  changeCounts: number[] = [],
) {
  const calls: PreparedCall[] = []
  let callIndex = 0
  let changeIndex = 0

  // Normalise: if rows is a flat array of non-arrays, treat it as a single batch.
  const batches: unknown[][] = Array.isArray(rows[0]) || rows.length === 0
    ? (rows as unknown[][])
    : [rows as unknown[]]

  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        const call: PreparedCall = { sql, binds: [] }
        calls.push(call)
        const thisIndex = callIndex++
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async all() {
            const batch = batches[thisIndex] ?? []
            return { results: batch }
          },
          // S6: createAgent now reads a COUNT(*) and billing_state via .first().
          // null → COUNT resolves to 0 and tier resolves to 'free' (count 0 < 2 → allowed),
          // so these model-default tests exercise createAgent past the entitlement gate.
          async first() {
            return null
          },
          async run() {
            const changes = changeCounts[changeIndex++] ?? 1
            call.changes = changes
            return { meta: { changes } }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, calls }
}

// ── loadAllAgents ─────────────────────────────────────────────────────────────

describe('loadAllAgents', () => {
  it('returns mapped rows from D1 with correct field shape', async () => {
    const row = {
      id: 'a1',
      slug: 'scout',
      name: 'Scout',
      role: 'member',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      squad_id: 's1',
      squad_name: 'Alpha',
      dept_name: 'Engineering',
      task_count: 5,
      open_count: 2,
      in_flight_count: 2,
    }
    const { env, calls } = makeEnv([[row]])
    const out = await loadAllAgents(env)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'a1', name: 'Scout', squad_name: 'Alpha', dept_name: 'Engineering' })
    // SQL must join agents → squads → departments + LEFT JOIN tasks
    expect(calls[0].sql).toContain('FROM agents a')
    expect(calls[0].sql).toContain('JOIN squads s')
    expect(calls[0].sql).toContain('LEFT JOIN departments d')
    expect(calls[0].sql).toContain('LEFT JOIN tasks t')
    // ordered by squad then name
    expect(calls[0].sql).toContain('s.name ASC')
    expect(calls[0].sql).toContain('a.name ASC')
  })

  it('includes task_count and open_count aggregates', async () => {
    const row = {
      id: 'a2', slug: 'planner', name: 'Planner', role: 'lead',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      status: 'paused', created_at: '2026-01-02T00:00:00Z',
      squad_id: 's2', squad_name: 'Beta', dept_name: null,
      task_count: 10, open_count: 3, in_flight_count: 3,
    }
    const { env } = makeEnv([[row]])
    const out = await loadAllAgents(env)
    expect(out[0].task_count).toBe(10)
    expect(out[0].open_count).toBe(3)
  })

  it('returns empty array when no agents exist', async () => {
    const { env } = makeEnv([[]])
    const out = await loadAllAgents(env)
    expect(out).toEqual([])
  })

  it('SQL selects status field so active/paused badge renders', async () => {
    const { env, calls } = makeEnv([[]])
    await loadAllAgents(env)
    expect(calls[0].sql).toContain('a.status')
  })
})

// ── loadSquadOptions ──────────────────────────────────────────────────────────

describe('loadSquadOptions', () => {
  it('returns id, name, dept_name for each squad', async () => {
    const row = { id: 's1', name: 'Alpha', dept_name: 'Engineering' }
    const { env, calls } = makeEnv([[row]])
    const out = await loadSquadOptions(env)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 's1', name: 'Alpha', dept_name: 'Engineering' })
    // LEFT JOIN so squads without a department are included
    expect(calls[0].sql).toContain('LEFT JOIN departments d')
    expect(calls[0].sql).toContain('ORDER BY')
  })

  it('returns empty array when no squads exist', async () => {
    const { env } = makeEnv([[]])
    const out = await loadSquadOptions(env)
    expect(out).toEqual([])
  })
})

// ── setAgentStatus ────────────────────────────────────────────────────────────

describe('setAgentStatus', () => {
  it('returns ok:true when changes=1 (agent found + updated)', async () => {
    const { env, calls } = makeEnv([], [1])
    const result = await setAgentStatus(env, 'agent-abc', 'paused')
    expect(result).toEqual({ ok: true })
    expect(calls[0].sql).toContain('UPDATE agents SET status')
    expect(calls[0].binds).toEqual(['paused', 'agent-abc'])
  })

  it('returns ok:false + not_found when changes=0 (agent not in DB)', async () => {
    const { env } = makeEnv([], [0])
    const result = await setAgentStatus(env, 'missing-id', 'active')
    expect(result).toEqual({ ok: false, error: 'not_found' })
  })

  it('pause → active round-trip binds correct status values', async () => {
    const { env, calls } = makeEnv([], [1, 1])
    await setAgentStatus(env, 'x', 'paused')
    await setAgentStatus(env, 'x', 'active')
    expect(calls[0].binds[0]).toBe('paused')
    expect(calls[1].binds[0]).toBe('active')
  })
})

// ── deleteAgent ───────────────────────────────────────────────────────────────

describe('deleteAgent', () => {
  it('nulls task assignees then deletes the row', async () => {
    const { env, calls } = makeEnv([], [2, 1]) // 2 tasks nulled, 1 agent deleted
    const result = await deleteAgent(env, 'agent-xyz')
    expect(result).toEqual({ ok: true })
    // First call must null out task assignees
    expect(calls[0].sql).toContain('UPDATE tasks SET assignee_agent_id = NULL')
    expect(calls[0].binds).toEqual(['agent-xyz'])
    // Second call deletes the agent
    expect(calls[1].sql).toContain('DELETE FROM agents WHERE id')
    expect(calls[1].binds).toEqual(['agent-xyz'])
  })

  it('returns ok:false + not_found when agent row does not exist', async () => {
    const { env } = makeEnv([], [0, 0]) // 0 tasks, 0 agent rows deleted
    const result = await deleteAgent(env, 'ghost-id')
    expect(result).toEqual({ ok: false, error: 'not_found' })
  })

  it('still returns ok:true when there are no task references to null (0 tasks)', async () => {
    // changeCounts[0]=0 means no tasks were nulled (none assigned); changeCounts[1]=1 = agent deleted
    const { env, calls } = makeEnv([], [0, 1])
    const result = await deleteAgent(env, 'fresh-agent')
    expect(result).toEqual({ ok: true })
    // Both SQL statements were issued
    expect(calls).toHaveLength(2)
  })
})

// ── createAgent default model ─────────────────────────────────────────────────

describe('createAgent default model', () => {
  it('uses the real Workers AI model id when model is not supplied', async () => {
    const { env, calls } = makeEnv([], [1])
    await createAgent(env, 'squad-1', { slug: 'bot', name: 'Bot' })
    // The INSERT binds include the model string at position 5 (0-indexed: id,squad_id,slug,name,role,model,status,created_at)
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO agents'))
    expect(insertCall).toBeDefined()
    const modelBind = insertCall!.binds.find(
      (b) => typeof b === 'string' && b.startsWith('@cf/'),
    )
    expect(modelBind).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    // The old broken id must NOT appear
    expect(modelBind).not.toBe('@cf/meta/llama-3.3')
  })

  it('respects a caller-supplied model override', async () => {
    const { env, calls } = makeEnv([], [1])
    await createAgent(env, 'squad-1', { slug: 'gpt-bot', name: 'GPT Bot', model: 'gpt-4o' })
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO agents'))!
    const modelBind = insertCall.binds.find(
      (b) => typeof b === 'string' && (b.startsWith('@cf/') || b === 'gpt-4o'),
    )
    expect(modelBind).toBe('gpt-4o')
  })
})

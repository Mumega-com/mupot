// tests/work-unit.test.ts — work-unit schema: guards, service mutations, helpers.
// Covers #25: Effort / Autonomy / BudgetWindow type guards + createAgent +
// createSquad unit-field defaults/overrides + updateUnitConfig per-field
// validation + autonomyImpliesGate matrix.

import { describe, it, expect } from 'vitest'
import {
  isEffort,
  isAutonomy,
  isBudgetWindow,
} from '../src/types'
import {
  createAgent,
  createSquad,
  updateUnitConfig,
  autonomyImpliesGate,
} from '../src/org/service'
import type { Env } from '../src/types'

// ── D1 mock ───────────────────────────────────────────────────────────────────
// Minimal stub: records every prepare() call; supports configurable change
// counts for UPDATE paths and captures INSERT binds.

interface PrepCall {
  sql: string
  binds: unknown[]
}

function makeEnv(changeCounts: number[] = [1]) {
  const calls: PrepCall[] = []
  let changeIndex = 0

  const env = {
    TENANT_SLUG: 'test',
    DB: {
      prepare(sql: string) {
        const call: PrepCall = { sql, binds: [] }
        calls.push(call)
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async run() {
            const changes = changeCounts[changeIndex++] ?? 1
            return { meta: { changes } }
          },
          async all() {
            return { results: [] }
          },
          async first() {
            return null
          },
        }
        return stmt
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        const out = []
        for (const s of statements) out.push(await s.run())
        return out
      },
    },
  } as unknown as Env

  return { env, calls }
}

// ── isEffort ──────────────────────────────────────────────────────────────────

describe('isEffort', () => {
  it.each(['low', 'standard', 'high', 'sprint'])('accepts %s', (v) => {
    expect(isEffort(v)).toBe(true)
  })

  it.each(['', 'extreme', 'STANDARD', 'Low', 0, null, undefined, {}, []])(
    'rejects %s',
    (v) => {
      expect(isEffort(v)).toBe(false)
    },
  )
})

// ── isAutonomy ────────────────────────────────────────────────────────────────

describe('isAutonomy', () => {
  it.each(['suggest', 'draft', 'execute', 'execute_with_approval'])('accepts %s', (v) => {
    expect(isAutonomy(v)).toBe(true)
  })

  it.each(['', 'approve', 'Execute', 'DRAFT', 0, null, undefined, {}, []])(
    'rejects %s',
    (v) => {
      expect(isAutonomy(v)).toBe(false)
    },
  )
})

// ── isBudgetWindow ────────────────────────────────────────────────────────────

describe('isBudgetWindow', () => {
  it.each(['day', 'week'])('accepts %s', (v) => {
    expect(isBudgetWindow(v)).toBe(true)
  })

  it.each(['', 'month', 'DAY', 'Week', 0, null, undefined])(
    'rejects %s',
    (v) => {
      expect(isBudgetWindow(v)).toBe(false)
    },
  )
})

// ── autonomyImpliesGate ───────────────────────────────────────────────────────

describe('autonomyImpliesGate', () => {
  it('returns true only for execute_with_approval', () => {
    expect(autonomyImpliesGate('execute_with_approval')).toBe(true)
  })

  it.each(['suggest', 'draft', 'execute'] as const)(
    'returns false for %s',
    (a) => {
      expect(autonomyImpliesGate(a)).toBe(false)
    },
  )
})

// ── createAgent — unit-field defaults ─────────────────────────────────────────

describe('createAgent — work-unit defaults', () => {
  it('defaults effort=standard autonomy=draft budget_window=week kpi_progress=0', async () => {
    const { env, calls } = makeEnv([1])
    const result = await createAgent(env, 'squad-1', { slug: 'bot', name: 'Bot' })
    expect(result.ok).toBe(true)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO agents'))!
    expect(insert).toBeDefined()
    // binds order: id, squad_id, slug, name, role, model, status,
    //              okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window, created_at
    const b = insert.binds
    const effortIdx = b.indexOf('standard')
    expect(effortIdx).toBeGreaterThan(-1)
    expect(b[effortIdx]).toBe('standard')

    const autonomyIdx = b.indexOf('draft')
    expect(autonomyIdx).toBeGreaterThan(-1)

    const budgetWindowIdx = b.indexOf('week')
    expect(budgetWindowIdx).toBeGreaterThan(-1)

    // kpi_progress = 0
    expect(b).toContain(0)

    // okr and kpi_target default to null
    const nullCount = b.filter((x) => x === null).length
    expect(nullCount).toBeGreaterThanOrEqual(2) // at least okr + kpi_target + budget_cap_cents
  })

  it('accepts caller-supplied effort/autonomy/budget overrides', async () => {
    const { env, calls } = makeEnv([1])
    const result = await createAgent(env, 'squad-1', {
      slug: 'exec-bot',
      name: 'Exec Bot',
      effort: 'sprint',
      autonomy: 'execute_with_approval',
      budget_cap_cents: 5000,
      budget_window: 'day',
      okr: 'Ship 10 tasks/week',
      kpi_target: '10 tasks',
    })
    expect(result.ok).toBe(true)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO agents'))!
    const b = insert.binds
    expect(b).toContain('sprint')
    expect(b).toContain('execute_with_approval')
    expect(b).toContain(5000)
    expect(b).toContain('day')
    expect(b).toContain('Ship 10 tasks/week')
    expect(b).toContain('10 tasks')
  })

  it('rejects invalid effort value', async () => {
    const { env } = makeEnv([0])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      effort: 'turbo',
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_effort' })
  })

  it('rejects invalid autonomy value', async () => {
    const { env } = makeEnv([0])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      autonomy: 'fire_and_forget',
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_autonomy' })
  })

  it('rejects non-integer budget_cap_cents', async () => {
    const { env } = makeEnv([0])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      budget_cap_cents: 9.99,
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_budget_cap_cents' })
  })

  it('rejects invalid budget_window', async () => {
    const { env } = makeEnv([0])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      budget_window: 'month',
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_budget_window' })
  })

  it('accepts null okr and kpi_target (explicit nulls)', async () => {
    const { env } = makeEnv([1])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      okr: null,
      kpi_target: null,
    })
    expect(result.ok).toBe(true)
  })

  it('accepts null budget_cap_cents (no budget cap)', async () => {
    const { env } = makeEnv([1])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      budget_cap_cents: null,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects non-string okr (type guard)', async () => {
    const { env } = makeEnv([0])
    const result = await createAgent(env, 'squad-1', {
      slug: 'bot',
      name: 'Bot',
      okr: 42,
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_okr' })
  })
})

// ── createSquad — unit-field defaults ─────────────────────────────────────────

describe('createSquad — work-unit defaults', () => {
  it('defaults effort=standard autonomy=draft budget_window=week role=null', async () => {
    const { env, calls } = makeEnv([1])
    const result = await createSquad(env, 'dept-1', { slug: 'alpha', name: 'Alpha' })
    expect(result.ok).toBe(true)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO squads'))!
    expect(insert).toBeDefined()
    const b = insert.binds
    expect(b).toContain('standard')
    expect(b).toContain('draft')
    expect(b).toContain('week')
    expect(b).toContain(0) // kpi_progress
    // role defaults null for squads
    expect(b).toContain(null)
  })

  it('accepts a squad role override', async () => {
    const { env, calls } = makeEnv([1])
    const result = await createSquad(env, 'dept-1', {
      slug: 'alpha',
      name: 'Alpha',
      role: 'engineering',
    })
    expect(result.ok).toBe(true)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO squads'))!
    expect(insert.binds).toContain('engineering')
  })

  it('rejects invalid effort', async () => {
    const { env } = makeEnv([0])
    const result = await createSquad(env, 'dept-1', {
      slug: 'alpha',
      name: 'Alpha',
      effort: 'extreme',
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: 'invalid_effort' })
  })

  it('accepts sprint autonomy override', async () => {
    const { env, calls } = makeEnv([1])
    const result = await createSquad(env, 'dept-1', {
      slug: 'alpha',
      name: 'Alpha',
      autonomy: 'execute',
    })
    expect(result.ok).toBe(true)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO squads'))!
    expect(insert.binds).toContain('execute')
  })
})

// ── updateUnitConfig ──────────────────────────────────────────────────────────

describe('updateUnitConfig', () => {
  it('patches effort on an agent', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'agent-1', { effort: 'sprint' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].sql).toContain('UPDATE agents SET')
    expect(calls[0].sql).toContain('effort = ?')
    expect(calls[0].binds).toContain('sprint')
    expect(calls[0].binds).toContain('agent-1')
  })

  it('patches autonomy on a squad', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'squad', 'squad-1', { autonomy: 'execute_with_approval' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].sql).toContain('UPDATE squads SET')
    expect(calls[0].binds).toContain('execute_with_approval')
  })

  it('patches okr (non-null string)', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { okr: 'Ship 20 PRs' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain('Ship 20 PRs')
  })

  it('patches okr to null (clear OKR)', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { okr: null })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain(null)
  })

  it('patches kpi_target', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { kpi_target: '20 PRs/week' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain('20 PRs/week')
  })

  it('patches budget_cap_cents to an integer', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { budget_cap_cents: 1000 })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain(1000)
  })

  it('patches budget_cap_cents to null (remove cap)', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { budget_cap_cents: null })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain(null)
  })

  it('patches budget_window', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'squad', 's1', { budget_window: 'day' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain('day')
  })

  it('patches role on a squad (null is allowed — accountability line is optional)', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'squad', 's1', { role: null })
    expect(result).toEqual({ ok: true })
    expect(calls[0].sql).toContain('UPDATE squads')
    expect(calls[0].binds).toContain(null)
  })

  it('patches role on an agent (non-null string required)', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', { role: 'tech-lead' })
    expect(result).toEqual({ ok: true })
    expect(calls[0].binds).toContain('tech-lead')
  })

  it('rejects null role on agent (agents must have a role string)', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { role: null })
    expect(result).toMatchObject({ ok: false, error: 'invalid_role' })
  })

  it('returns not_found when changes=0 (id does not exist)', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'ghost', { effort: 'low' })
    expect(result).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('rejects invalid effort value', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { effort: 'turbo' })
    expect(result).toMatchObject({ ok: false, error: 'invalid_effort' })
  })

  it('rejects invalid autonomy value', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { autonomy: 'fire_and_forget' })
    expect(result).toMatchObject({ ok: false, error: 'invalid_autonomy' })
  })

  it('rejects non-integer budget_cap_cents (float)', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { budget_cap_cents: 9.99 })
    expect(result).toMatchObject({ ok: false, error: 'invalid_budget_cap_cents' })
  })

  it('rejects invalid budget_window', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { budget_window: 'month' })
    expect(result).toMatchObject({ ok: false, error: 'invalid_budget_window' })
  })

  it('rejects non-string okr (type guard)', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { okr: 42 })
    expect(result).toMatchObject({ ok: false, error: 'invalid_okr' })
  })

  it('rejects non-string kpi_target', async () => {
    const { env } = makeEnv([0])
    const result = await updateUnitConfig(env, 'agent', 'a1', { kpi_target: true })
    expect(result).toMatchObject({ ok: false, error: 'invalid_kpi_target' })
  })

  it('builds a multi-field SET clause when multiple fields are patched', async () => {
    const { env, calls } = makeEnv([1])
    const result = await updateUnitConfig(env, 'agent', 'a1', {
      effort: 'high',
      autonomy: 'execute',
      budget_cap_cents: 2000,
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0].sql).toContain('effort = ?')
    expect(calls[0].sql).toContain('autonomy = ?')
    expect(calls[0].sql).toContain('budget_cap_cents = ?')
    expect(calls[0].binds).toContain('high')
    expect(calls[0].binds).toContain('execute')
    expect(calls[0].binds).toContain(2000)
    // id must be the last bind
    expect(calls[0].binds[calls[0].binds.length - 1]).toBe('a1')
  })

  it('is a no-op (ok:true) when patch is empty — no SQL issued', async () => {
    const { env, calls } = makeEnv([])
    const result = await updateUnitConfig(env, 'agent', 'a1', {})
    expect(result).toEqual({ ok: true })
    // No DB call should have been made
    expect(calls).toHaveLength(0)
  })
})

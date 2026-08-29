import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runTaskExecution } from '../src/agents/execute'
import { runGoalCycle } from '../src/agents/loop'
import {
  checkAndReserve,
  MAX_DISPATCHES_PER_DAY,
  MAX_TOKENS_PER_DAY,
} from '../src/agents/meter'
import { TOOLS, invokeTool } from '../src/mcp'
import type { LoopManifest } from '../src/loops/manifest'
import { runLoopCycle } from '../src/loops/runtime'
import type { Agent, AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'meter-test'
const DEPARTMENT = 'department-a'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

function grant(
  memberId: string,
  capability: CapabilityGrant['capability'],
  scopeId: string | null,
): CapabilityGrant {
  return {
    member_id: memberId,
    scope_type: scopeId === null ? 'org' : 'squad',
    scope_id: scopeId,
    capability,
  }
}

function ambientCapabilities(memberId: string): CapabilityGrant[] {
  switch (memberId) {
    case 'member-a': return [grant(memberId, 'member', SQUAD_A)]
    case 'lead-a': return [grant(memberId, 'lead', SQUAD_A)]
    case 'lead-b': return [grant(memberId, 'lead', SQUAD_B)]
    case 'org-admin': return [grant(memberId, 'admin', null)]
    default: return []
  }
}

function auth(memberId: string, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: ambientCapabilities(memberId),
    boundAgentId: null,
    ...overrides,
  }
}

function utcDay(offset = 0): string {
  const day = new Date()
  day.setUTCDate(day.getUTCDate() - offset)
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`
}

function windowKey(agentId: string, offset = 0): string {
  return `${TENANT}:${agentId}:${utcDay(offset)}`
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPARTMENT}', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A}', '${DEPARTMENT}', 'squad-a', 'Squad A'),
      ('${SQUAD_B}', '${DEPARTMENT}', 'squad-b', 'Squad B');
    INSERT INTO agents (
      id, squad_id, slug, name, status, okr, kpi_target, effort, autonomy,
      budget_cap_cents, budget_window
    ) VALUES
      ('${AGENT_A}', '${SQUAD_A}', 'agent-a', 'Agent A', 'active', 'Ship safely', '1 task', 'standard', 'execute', 100, 'day'),
      ('${AGENT_B}', '${SQUAD_B}', 'agent-b', 'Agent B', 'active', 'Ship safely', '1 task', 'standard', 'execute', 200, 'week');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-a', '${AGENT_A}', '${SQUAD_A}', 'member'),
      ('membership-b', '${AGENT_B}', '${SQUAD_B}', 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-a', 'member-a@example.test', 'Member A', 'active', '${TENANT}'),
      ('lead-a', 'lead-a@example.test', 'Lead A', 'active', '${TENANT}'),
      ('lead-b', 'lead-b@example.test', 'Lead B', 'active', '${TENANT}'),
      ('agent-a-member', 'agent-a@example.test', 'Agent A Member', 'active', '${TENANT}'),
      ('org-admin', 'org-admin@example.test', 'Org Admin', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_A}', 'agent-a-member', '2026-08-29T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('member-a-squad-a', 'member-a', 'squad', '${SQUAD_A}', 'member'),
      ('lead-a-squad-a', 'lead-a', 'squad', '${SQUAD_A}', 'lead'),
      ('lead-b-squad-b', 'lead-b', 'squad', '${SQUAD_B}', 'lead'),
      ('org-admin-org', 'org-admin', 'org', NULL, 'admin');
    INSERT INTO execution_meter (
      id, window_key, count, tokens, window_start, cost_micro_usd
    ) VALUES
      ('meter-a-today', '${windowKey(AGENT_A)}', 3, 120, '${utcDay()}T00:00:00.000Z', 700),
      ('meter-b-today', '${windowKey(AGENT_B)}', 5, 240, '${utcDay()}T00:00:00.000Z', 900),
      ('meter-b-yesterday', '${windowKey(AGENT_B, 1)}', 1, 60, '${utcDay(1)}T00:00:00.000Z', 400);
  `)
}

function trackedEnv(harness: SqliteD1Harness): {
  env: Env
  meterReads: { value: number }
} {
  const meterReads = { value: 0 }
  const db = {
    prepare(sql: string) {
      if (/\bFROM\s+execution_meter\b/i.test(sql)) meterReads.value += 1
      return harness.db.prepare(sql)
    },
  }
  return {
    env: {
      DB: db,
      TENANT_SLUG: TENANT,
      EXEC_MAX_DISPATCH_DAY: '17',
      EXEC_MAX_TOKENS_DAY: '34000',
    } as unknown as Env,
    meterReads,
  }
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_A,
    squad_id: SQUAD_A,
    slug: 'agent-a',
    name: 'Agent A',
    role: 'member',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    kind: 'work',
    okr: 'Ship safely',
    kpi_target: '1 task',
    kpi_progress: 0,
    effort: 'standard',
    autonomy: 'execute',
    budget_cap_cents: 100,
    budget_window: 'day',
    created_at: '2026-08-29T00:00:00.000Z',
    purpose: null,
    owner: null,
    model_fallback: null,
    capabilities: null,
    skills: null,
    parent_agent_id: null,
    qnft_ref: null,
    death_condition: null,
    ...overrides,
  }
}

async function status(env: Env, authContext: AuthContext, args: Record<string, unknown> = {}) {
  return invokeTool(authContext, env, 'execution_meter_status', args, 'https://pot.example')
}

describe('public meter status authorization', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('reads the canonical bound agent when agent_id is omitted', async () => {
    const { env } = trackedEnv(harness)

    const outcome = await status(env, auth('agent-a-member', { boundAgentId: AGENT_A }))

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        agent_id: AGENT_A,
        squad_id: SQUAD_A,
        window_key: windowKey(AGENT_A),
        dispatches_day: 3,
        tokens_day: 120,
        cost_micro_usd_day: 700,
        cost_micro_usd_week: 700,
      },
    })
  })

  it('denies an unbound member choosing an arbitrary agent before any meter read', async () => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await status(env, auth('member-a'), { agent_id: AGENT_A })

    expect(outcome).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(meterReads.value).toBe(0)
  })

  it('denies an unbound member with no target before any meter read', async () => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await status(env, auth('member-a'))

    expect(outcome).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(meterReads.value).toBe(0)
  })

  it('allows a same-squad lead to read the target agent meter', async () => {
    const { env } = trackedEnv(harness)

    const outcome = await status(env, auth('lead-a'), { agent_id: AGENT_A })

    expect(outcome).toMatchObject({
      ok: true,
      result: { agent_id: AGENT_A, dispatches_day: 3, cost_micro_usd_day: 700 },
    })
  })

  it('denies a cross-squad lead before spend or counts are queried', async () => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await status(env, auth('lead-a'), { agent_id: AGENT_B })

    expect(outcome).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(meterReads.value).toBe(0)
  })

  it('allows an org admin to read a tenant agent and reports its weekly spend', async () => {
    const { env } = trackedEnv(harness)

    const outcome = await status(env, auth('org-admin'), { agent_id: AGENT_B })

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        agent_id: AGENT_B,
        squad_id: SQUAD_B,
        dispatches_day: 5,
        tokens_day: 240,
        cost_micro_usd_day: 900,
        cost_micro_usd_week: 1300,
      },
    })
  })

  it('keeps a bound agent confined to self even when it names another agent', async () => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await status(
      env,
      auth('agent-a-member', { boundAgentId: AGENT_A }),
      { agent_id: AGENT_B },
    )

    expect(outcome).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(meterReads.value).toBe(0)
  })
})

describe('public reservation boundary', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('registers status but no public execution_meter_check tool', () => {
    expect(TOOLS.map((tool) => tool.name)).toContain('execution_meter_status')
    expect(TOOLS.map((tool) => tool.name)).not.toContain('execution_meter_check')
  })

  it.each([
    ['max_dispatch_day', 1],
    ['max_tokens_day', 1],
    ['max_cost_micro_usd', 1],
    ['cost_window', 'day'],
    ['estimate_micro_usd', 1],
  ])('rejects caller reservation field %s before any meter read', async (field, value) => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await status(
      env,
      auth('agent-a-member', { boundAgentId: AGENT_A }),
      { [field]: value },
    )

    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(meterReads.value).toBe(0)
  })

  it('does not dispatch an unknown public execution_meter_check request', async () => {
    const { env, meterReads } = trackedEnv(harness)

    const outcome = await invokeTool(
      auth('org-admin'),
      env,
      'execution_meter_check',
      { agent_id: AGENT_A, max_tokens_day: 1 },
      'https://pot.example',
    )

    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'unknown_tool' })
    expect(meterReads.value).toBe(0)
  })
})

describe('internal authorized reservation', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('uses the server-authorized agent and preserves the atomic count reservation', async () => {
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

    const outcome = await checkAndReserve(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: MAX_DISPATCHES_PER_DAY,
      maxTokensDay: MAX_TOKENS_PER_DAY,
      maxCostMicroUsd: 1_000_000,
      costWindow: 'day',
      estimateMicroUsd: 1_000,
    })

    expect(outcome).toMatchObject({ ok: true, windowKey: windowKey(AGENT_A), count: 4 })
    const row = harness.sqlite.prepare(
      'SELECT count FROM execution_meter WHERE window_key = ?',
    ).get(windowKey(AGENT_A)) as { count: number }
    expect(row.count).toBe(4)
  })

  it('preserves prospective enforcement for a daily cost window', async () => {
    harness.sqlite.prepare(
      'UPDATE execution_meter SET cost_micro_usd = ? WHERE window_key = ?',
    ).run(950_000, windowKey(AGENT_A))
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

    const outcome = await checkAndReserve(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: 200,
      maxTokensDay: 200_000,
      maxCostMicroUsd: 1_000_000,
      costWindow: 'day',
      estimateMicroUsd: 100_000,
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'budget_cap_exceeded' })
  })

  it('preserves prospective enforcement for a weekly cost window', async () => {
    harness.sqlite.prepare(
      'UPDATE execution_meter SET cost_micro_usd = ? WHERE window_key = ?',
    ).run(950_000, windowKey(AGENT_B, 1))
    harness.sqlite.prepare(
      'UPDATE execution_meter SET cost_micro_usd = 0 WHERE window_key = ?',
    ).run(windowKey(AGENT_B))
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

    const outcome = await checkAndReserve(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_B,
      squadId: SQUAD_B,
      projectId: null,
      maxDispatchDay: 200,
      maxTokensDay: 200_000,
      maxCostMicroUsd: 1_000_000,
      costWindow: 'week',
      estimateMicroUsd: 100_000,
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'budget_cap_exceeded' })
  })

  it('runTaskExecution builds caps and attribution only from server state', async () => {
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id)
       VALUES (?, ?, 'Execute safely', '', 'review receipt exists', 'open', ?)`,
    ).run('task-a', SQUAD_A, AGENT_A)
    const { env } = trackedEnv(harness)
    const reserve = vi.fn(async () => ({
      ok: false as const,
      reason: 'rate_limited' as const,
      windowKey: windowKey(AGENT_A),
      count: 17,
      tokens: 0,
      retryAfterSec: 60,
    }))

    await runTaskExecution(env, agent(), 'task-a', {
      model: { chat: vi.fn(async () => 'must not run') },
      emit: async () => undefined,
      remember: async () => 'unused',
      meter: { checkAndReserve: reserve, recordTokens: vi.fn(async () => undefined) },
    })

    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledWith(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: 17,
      maxTokensDay: 34_000,
      maxCostMicroUsd: 1_000_000,
      costWindow: 'day',
      estimateMicroUsd: expect.any(Number),
    })
  })

  it('runGoalCycle builds the same server-owned policy for loop reservation', async () => {
    const { env } = trackedEnv(harness)
    const reserve = vi.fn(async () => ({
      ok: false as const,
      reason: 'budget_cap_exceeded' as const,
      windowKey: windowKey(AGENT_A),
      count: 0,
      tokens: 0,
      retryAfterSec: 60,
    }))

    await runGoalCycle(env, agent(), {
      meterCheck: reserve,
      buildSensorium: vi.fn(async () => { throw new Error('sensorium unavailable') }),
      recentEpisodes: async () => [],
      observe: vi.fn(async () => null as never),
      recordEpisode: async () => undefined,
    })

    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledWith(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: 17,
      maxTokensDay: 34_000,
      maxCostMicroUsd: 1_000_000,
      costWindow: 'day',
      estimateMicroUsd: expect.any(Number),
    })
  })

  it('manifest loop resolves its agent squad and preserves its persisted micro-USD policy', async () => {
    const { env } = trackedEnv(harness)
    const reserve = vi.fn(async () => ({
      ok: false as const,
      reason: 'budget_cap_exceeded' as const,
      windowKey: windowKey(AGENT_A),
      count: 0,
      tokens: 0,
      retryAfterSec: 60,
    }))
    const loop: LoopManifest = {
      id: 'loop-a',
      tenant: TENANT,
      squad_id: null,
      agent_id: AGENT_A,
      status: 'active',
      okr: 'Ship safely',
      kpi: { signal: 'done_tasks', target: 1 },
      sources: [],
      channels: [],
      gate: { require_approval: false },
      budget: { cap_micro_usd: 5_000, window: 'week', effort: 'standard' },
      cadence: { heartbeat: true },
      stop: {},
      created_at: '2026-08-29T00:00:00.000Z',
    }

    await runLoopCycle(env, loop, {
      meterCheck: reserve,
      observeKpi: async () => 0,
      appendDecision: async () => undefined,
    })

    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledWith(env, {
      tenant: TENANT,
      meterSubjectId: AGENT_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: 17,
      maxTokensDay: 34_000,
      maxCostMicroUsd: 5_000,
      costWindow: 'week',
      estimateMicroUsd: expect.any(Number),
    })
  })

  it('manifest loop preserves a canonical squad-owned meter subject', async () => {
    const { env } = trackedEnv(harness)
    const reserve = vi.fn(async () => ({
      ok: false as const,
      reason: 'rate_limited' as const,
      windowKey: windowKey(SQUAD_A),
      count: 17,
      tokens: 0,
      retryAfterSec: 60,
    }))
    const loop: LoopManifest = {
      id: 'loop-squad-a',
      tenant: TENANT,
      squad_id: SQUAD_A,
      agent_id: null,
      status: 'active',
      okr: 'Ship safely',
      kpi: { signal: 'done_tasks', target: 1 },
      sources: [],
      channels: [],
      gate: { require_approval: false },
      budget: { cap_micro_usd: 5_000, window: 'day', effort: 'standard' },
      cadence: { heartbeat: true },
      stop: {},
      created_at: '2026-08-29T00:00:00.000Z',
    }

    await runLoopCycle(env, loop, {
      meterCheck: reserve,
      observeKpi: async () => 0,
      appendDecision: async () => undefined,
    })

    expect(reserve).toHaveBeenCalledWith(env, {
      tenant: TENANT,
      meterSubjectId: SQUAD_A,
      squadId: SQUAD_A,
      projectId: null,
      maxDispatchDay: 17,
      maxTokensDay: 34_000,
      maxCostMicroUsd: 5_000,
      costWindow: 'day',
      estimateMicroUsd: expect.any(Number),
    })
  })

  it.each([
    ['missing agent', { agent_id: 'missing-agent', squad_id: null }],
    ['inactive agent', { agent_id: AGENT_A, squad_id: null }],
    ['missing squad', { agent_id: null, squad_id: 'missing-squad' }],
  ])('manifest loop fails closed for a %s before reservation', async (_label, owner) => {
    if (owner.agent_id === AGENT_A) {
      harness.sqlite.prepare('UPDATE agents SET status = ? WHERE id = ?').run('paused', AGENT_A)
    }
    const { env } = trackedEnv(harness)
    const reserve = vi.fn(async () => ({
      ok: true as const,
      windowKey: 'must-not-reserve',
      count: 1,
      tokens: 0,
    }))
    const loop: LoopManifest = {
      id: 'loop-invalid-owner',
      tenant: TENANT,
      squad_id: owner.squad_id,
      agent_id: owner.agent_id,
      status: 'active',
      okr: 'Ship safely',
      kpi: { signal: 'done_tasks', target: 1 },
      sources: [],
      channels: [],
      gate: { require_approval: false },
      budget: { cap_micro_usd: 5_000, window: 'week', effort: 'standard' },
      cadence: { heartbeat: true },
      stop: {},
      created_at: '2026-08-29T00:00:00.000Z',
    }

    const outcome = await runLoopCycle(env, loop, {
      meterCheck: reserve,
      observeKpi: async () => 0,
      appendDecision: async () => undefined,
    })

    expect(outcome).toMatchObject({ ok: false, decided: 'inactive', error: 'loop_owner_unavailable' })
    expect(reserve).not.toHaveBeenCalled()
  })
})

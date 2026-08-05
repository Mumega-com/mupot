// tests/backlog-provenance-sqlite.test.ts — C10: the backpressure governor is provenance-aware.
//
// WHY THIS TEST IS DRIVEN BY REAL SQL AND NOT BY A REGEX ON THE QUERY STRING
//
// tests/sane-brain-s3.test.ts already asserts the backlog SQL by matching source text
// (`expect(backlogSql).toMatch(/assignee_agent_id\s+IS\s+NULL/i)`). That style of test
// passed continuously while the defect below was live, because the defect was not a
// missing clause in the string — it was the MEANING of the clause that was present.
// A mechanism-pinned test cannot fail on a semantics bug; it only pins the mechanism
// that has the bug in it. So this file inserts real rows into a real sqlite database
// and asserts on the OUTCOME of runGoalCycle, which is the property that actually
// matters: does the loop keep producing work, or does it stop?
//
// THE DEFECT (C10, found by an independent audit lens 2026-08-03)
// countOpenBacklog counted `assignee IS NULL AND squad_id = ?` as "backlog this agent's
// loop produced and left for pickup". An externally-imported task (cross-pot source_pot,
// or an integration import via migrations/0077 external_source) lands open + unassigned
// in a squad and matched that shape exactly. So MAX_OPEN_TASKS worth of imported issues
// pinned the governor at its cap and the agent's loop stopped producing — reachable by
// anyone who can write to a connected external board, through the integration's normal
// intended use, with no credential compromise and no log line that looks like an attack.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGoalCycle, MAX_OPEN_TASKS } from '../src/agents/loop'
import { SENSORIUM_VERSION } from '../src/agents/sensorium'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { LoopDeps } from '../src/agents/loop'
import type { Sensorium } from '../src/agents/sensorium'
import type { Agent, Env, Task } from '../src/types'

const AGENT_ID = 'agent-c10'
const SQUAD_ID = 'squad-c10'

let harness: SqliteD1Harness

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  // Only the columns countOpenBacklog reads. external_source arrives in migrations/0077.
  sqlite.exec(`

  `)
}

interface SeedRow {
  readonly assignee?: string | null
  readonly sourcePot?: string | null
  readonly externalSource?: string | null
  readonly status?: string
  readonly squad?: string
}

function seed(count: number, row: SeedRow, idPrefix: string): void {
  for (let i = 0; i < count; i += 1) {
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id, source_pot, external_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${idPrefix}-${i}`,
      row.squad ?? SQUAD_ID,
      `task ${idPrefix} ${i}`,
      row.status ?? 'open',
      row.assignee ?? null,
      row.sourcePot ?? null,
      row.externalSource ?? null,
      '2026-08-03T00:00:00Z',
    )
  }
}

function makeAgent(): Agent {
  return {
    id: AGENT_ID,
    squad_id: SQUAD_ID,
    slug: 'agent-c10',
    name: 'C10 Test Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship features',
    kpi_target: '10 tasks',
    kpi_progress: 30,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
  } as Agent
}

function makeSensorium(): Sensorium {
  return {
    version: SENSORIUM_VERSION,
    clock: { now: '2026-08-03T10:00:00Z', agent_age_days: 10, cycles: 5, last_woke_at: null },
    situation: { agent_name: 'C10 Test Agent', agent_role: 'engineer', autonomy: 'draft', effort: 'standard', wake_reason: null },
    schedule: { counts: { open: 0, in_progress: 0, done: 5, blocked: 0 }, overdue: 0, oldest_open_tasks: [] },
    vitals: { kpi_progress: 30, kpi_target: '10 tasks', budget_remaining_micro_usd: null, budget_window: 'week' },
    delegations: [],
    tasks: [],
  } as unknown as Sensorium
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    meterCheck: vi.fn().mockResolvedValue({ ok: true, windowKey: 'w', count: 1, tokens: 0 }),
    model: { chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 'plan', tasks: [{ title: 'T', body: 'b' }] })) },
    recall: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockImplementation(async (_e: Env, input: { squad_id: string; title: string }) => ({
      id: 'new-' + input.title, squad_id: input.squad_id, title: input.title, body: '',
      done_when: '(set via task update)', status: 'open', assignee_agent_id: null,
      github_issue_url: null, result: null, completed_at: null, gate_owner: null,
      created_at: '2026-08-03T00:00:00Z', updated_at: '2026-08-03T00:00:00Z',
    } as unknown as Task)),
    writeProgress: vi.fn().mockResolvedValue(undefined),
    remember: vi.fn().mockResolvedValue('engram-id'),
    buildSensorium: vi.fn().mockResolvedValue(makeSensorium()),
    computeDecisionFp: vi.fn().mockResolvedValue('fp-c10'),
    reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
    observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    ...over,
  } as unknown as LoopDeps
}

function env(): Env {
  return { TENANT_SLUG: 'tenant-c10', DB: harness.db } as unknown as Env
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  createSchema(harness.sqlite)
})

afterEach(() => {
  harness.close()
})

describe('backpressure governor — provenance on the unassigned branch (C10)', () => {
  it('CONTROL: first-party unassigned tasks at the cap DO stop the loop', async () => {
    // Establishes that the governor works at all. Without this, the test below could
    // pass because the guard is dead rather than because it is provenance-aware.
    seed(MAX_OPEN_TASKS, {}, 'firstparty')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('backpressure')
    expect(result.spawned).toBe(0)
  })

  it('THE DEFECT: external-integration imports at the cap must NOT stop the loop', async () => {
    // Pre-fix this returned 'backpressure' — denial of work by importing issues.
    seed(MAX_OPEN_TASKS, { externalSource: 'linear' }, 'linear')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
  })

  it('THE DEFECT: cross-pot imports at the cap must NOT stop the loop', async () => {
    seed(MAX_OPEN_TASKS, { sourcePot: 'remote-pot-a' }, 'crosspot')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
  })

  it('external rows cannot TOP UP a first-party backlog to the cap', async () => {
    // The arithmetic case: one short of the cap, padded with imports. If externals
    // contribute at all, this trips. This is the form the attack actually takes —
    // you do not need to supply all MAX_OPEN_TASKS rows, only the last one.
    seed(MAX_OPEN_TASKS - 1, {}, 'firstparty')
    seed(5, { externalSource: 'linear' }, 'linear')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
  })

  it('ASSIGNED external work still counts — an admin decided it is this agent\'s job', async () => {
    // The guard's boundary is "nobody has decided this is mine yet", NOT "external is
    // untrusted". Once an admin takes the explicit task_update/PATCH step, an external
    // task is real backlog and MUST exert backpressure — otherwise this fix would
    // create an unbounded-work hole in the other direction.
    seed(MAX_OPEN_TASKS, { assignee: AGENT_ID, externalSource: 'linear' }, 'assigned')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('backpressure')
  })

  // ── Empty-string provenance ─────────────────────────────────────────────────
  //
  // Adversarial review raised the empty string against this PR, answering the exact
  // question it asked for: a row shape where the tests are green and the property is
  // false. The concern was that `external_source = ''` is NOT NULL, so an importer
  // stamping empty instead of null would be read as first-party and the denial-of-work
  // would return.
  //
  // Checking it showed the polarity is the other way round, and it is worth stating
  // precisely because the intuition is easy to get backwards. `IS NULL` is the
  // condition for COUNTING a row as this agent's own backlog. An empty string FAILS
  // `IS NULL`, so the row falls out of the first-party branch and is not counted —
  // which is the safe direction. `IS NULL` is strict: only an exactly-NULL stamp
  // qualifies as first-party, and every other value, empty string included, is
  // treated as external.
  //
  // The proposed remedy, `COALESCE(col,'') = ''`, would have INTRODUCED the bug it
  // was meant to prevent, by making empty-string count as first-party. That was
  // caught by writing these two cases and running them against both versions rather
  // than reasoning about it — the change failed them, the original passed.
  //
  // They stay because they lock the safe behaviour against exactly that regression.

  it('EMPTY-STRING external_source is treated as external, not first-party', async () => {
    seed(MAX_OPEN_TASKS, { externalSource: '' }, 'emptystamp')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
  })

  it('EMPTY-STRING source_pot is treated as external too', async () => {
    seed(MAX_OPEN_TASKS, { sourcePot: '' }, 'emptypot')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
  })

  it('another squad\'s first-party unassigned backlog is still not counted', async () => {
    // Guards against a fix that widened the branch instead of narrowing it.
    seed(MAX_OPEN_TASKS, { squad: 'squad-other' }, 'othersquad')
    const result = await runGoalCycle(env(), makeAgent(), deps())
    expect(result.decided).toBe('spawned')
  })
})

// tests/agent-escalation-emit.test.ts — task 00fe8477 / PR #1381.
//
// The brain's escalation path carried ZERO tests for four weeks while two TODO
// comments claimed it was unimplemented. It was implemented. Nobody could tell,
// because agent-do.ts imports 'cloudflare:workers' and therefore cannot be
// imported by this pool at all — so "is the emit wired?" was a question only a
// human reading the file could answer, and two humans read it and stopped at the
// comment.
//
// This file closes the second half of that task's done_when: "a test goes red
// when the emit is removed". Four of the five tests below exercise the emit
// itself (now in escalation.ts, extracted precisely so it could be reached); the
// fifth is a source guard, because deleting the CALL in agent-do.ts is a
// deletion no behavioural test in this pool can observe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { emitEscalation, ESCALATION_DONE_WHEN } from '../src/agents/escalation'
import { isPlaceholderDoneWhen, assertCompletableDoneWhen } from '../src/tasks/service'
import { GATE_ESCALATION } from '../src/gates/lanes'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env, Agent } from '../src/types'

const TENANT = 'mumega'
const SQUAD = 'squad-esc'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-stuck',
    squad_id: SQUAD,
    slug: 'stuck-one',
    name: 'Stuck Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: null,
    kpi_target: null,
    kpi_progress: 0,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as unknown as Agent
}

describe('escalation emit — the brain reaching an operator', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-esc', 'dept-esc', 'Escalation Dept');
      INSERT INTO squads (id, department_id, slug, name)
        VALUES ('${SQUAD}', 'dept-esc', 'squad-esc', 'Escalation Squad');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-stuck', '${SQUAD}', 'stuck-one', 'Stuck Agent', 'active');
    `)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { emit: async () => {} },
    } as unknown as Env
  })

  afterEach(() => harness.close())

  async function tasksRows(): Promise<Record<string, unknown>[]> {
    const r = await env.DB.prepare(
      `SELECT id, title, body, done_when, gate_owner, status, squad_id FROM tasks`,
    ).all()
    return (r.results ?? []) as Record<string, unknown>[]
  }

  it('creates one operator-facing task tagged with the escalation gate', async () => {
    const result = await emitEscalation(env, makeAgent(), 'escalate: consecutive_fails=3', 7)

    expect(result.emitted, `emit reported failure: ${result.error ?? ''}`).toBe(true)

    const rows = await tasksRows()
    // Guard against the vacuous pass: if the emit wrote nothing, every field
    // assertion below would be checking a row that does not exist.
    expect(rows.length, 'the emit wrote no task at all').toBe(1)

    expect(rows[0].gate_owner).toBe(GATE_ESCALATION)
    expect(rows[0].squad_id).toBe(SQUAD)
    expect(rows[0].status).toBe('open')
    expect(String(rows[0].title)).toContain('stuck-one')
    expect(String(rows[0].body)).toContain('consecutive_fails=3')
    expect(String(rows[0].body)).toContain('Cycle: 7')
  })

  // WHAT THE SENTINEL IS ACTUALLY FOR.
  //
  // It is tempting to say the registered sentinel is what lets this done_when
  // past task intake. It is not: allowDeferredPredicate skips the sentinel
  // rejection AND the minimum-length floor, so any non-empty string would be
  // accepted at creation. I asserted the opposite in review and it was wrong.
  //
  // The registration buys the EXIT, not the entry. assertCompletableDoneWhen
  // refuses to mark a task done while its done_when is a sentinel, so an
  // escalation cannot be closed until a human replaces the placeholder with a
  // real predicate — exactly right for a task that exists because nothing
  // automatic could resolve the situation.
  it('emits a done_when that is a registered sentinel', () => {
    expect(
      isPlaceholderDoneWhen(ESCALATION_DONE_WHEN),
      'ESCALATION_DONE_WHEN is no longer a registered placeholder sentinel — ' +
        'escalation tasks can now be closed without anyone setting a real predicate',
    ).toBe(true)
  })

  it('refuses to let an escalation be marked done while the placeholder stands', () => {
    expect(() => assertCompletableDoneWhen(ESCALATION_DONE_WHEN)).toThrow(
      /done_when_placeholder/,
    )
  })

  // Positive control. Without it, the test above could pass because
  // assertCompletableDoneWhen throws on everything.
  it('accepts a real predicate in that same position', () => {
    expect(() =>
      assertCompletableDoneWhen('operator acked the escalation and the agent spawned again'),
    ).not.toThrow()
  })

  it('never throws when the write fails — a dead emit must not kill the goal cycle', async () => {
    const brokenEnv = {
      TENANT_SLUG: TENANT,
      DB: {
        prepare() {
          throw new Error('d1 unavailable')
        },
      },
      BUS: { emit: async () => {} },
    } as unknown as Env

    const result = await emitEscalation(brokenEnv, makeAgent(), 'escalate: x', 1)

    expect(result.emitted).toBe(false)
    expect(result.error).toContain('d1 unavailable')
  })

  // SOURCE GUARD — the done_when's literal requirement.
  //
  // Everything above proves the emit WORKS. None of it would notice the emit
  // being deleted from the runtime, because agent-do.ts cannot be imported here
  // ('cloudflare:workers' is resolved upstream of Vite and cannot be aliased —
  // see vitest.composition.config.ts). A text assertion is a weak instrument and
  // is used deliberately: the alternative is no instrument.
  it('AgentDO still calls the emit on the escalate branch', () => {
    const src = readFileSync(new URL('../src/agents/agent-do.ts', import.meta.url), 'utf8')

    expect(src, 'agent-do.ts no longer imports the escalation emit').toContain(
      "from './escalation'",
    )

    const branch = src.indexOf('if (obs?.escalate) {')
    expect(branch, 'the obs?.escalate branch is gone from AgentDO').toBeGreaterThan(-1)

    const afterBranch = src.slice(branch, branch + 900)
    expect(
      afterBranch,
      'the escalate branch no longer calls emitEscalation — the brain detects a ' +
        'stuck agent and tells nobody',
    ).toContain('emitEscalation(')
  })
})

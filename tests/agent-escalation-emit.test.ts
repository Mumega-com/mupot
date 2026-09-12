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
// when the emit is removed". Most of the tests below exercise the emit itself
// (now in escalation.ts, extracted precisely so it could be reached); the last
// is a source-level lint, because deleting the CALL in agent-do.ts is a deletion
// no behavioural test in this pool can observe.
//
// A first version of this file passed six mutations that should have failed it.
// An adversarial gate found them: the emitted done_when was never bound to the
// constant the tests pinned, the payload fields were mostly unasserted, and the
// source lint matched commented-out and dead-branched code. The assertions below
// are the repair; the notes on each say what mutation they exist to kill.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  emitEscalation,
  buildEscalationTaskPlan,
  ESCALATION_DONE_WHEN,
} from '../src/agents/escalation'
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

    // Asserted against LITERALS, not against the constants the emit reads.
    // Comparing row.gate_owner to GATE_ESCALATION only proves the two sides agree
    // — change the constant and both move together, green throughout.
    expect(rows[0].gate_owner).toBe('gate:escalation')
    expect(rows[0].squad_id).toBe(SQUAD)

    // THE ASSERTION THE FIRST VERSION OF THIS FILE FORGOT. done_when was in the
    // SELECT and never checked, so mutating the emitted value off the sentinel
    // left all six tests green — deleting the un-closeable property outright.
    expect(rows[0].done_when).toBe(ESCALATION_DONE_WHEN)
    expect(rows[0].done_when).toBe('(operator resolves — set via task update)')

    // The prefix is the string a human actually filters a GitHub issue list on,
    // given the gate_owner tag is inert.
    expect(String(rows[0].title)).toMatch(/^ESCALATION: /)
    expect(String(rows[0].title)).toContain('stuck-one')
    expect(String(rows[0].body)).toContain('consecutive_fails=3')
    expect(String(rows[0].body)).toContain('Cycle: 7')

    // CHARACTERIZATION, NOT A CONTRACT. 'open' is precisely why this task reaches
    // no gate surface: needs_you_list and the approvals queue both filter to
    // 'review', and the gate-owner wake fires only on entry to 'review'. The fix
    // may well be to create escalations in a different state — when it lands,
    // this line SHOULD go red, and updating it is the intended outcome, not a
    // regression. It is here so the current, broken value is stated out loud
    // rather than assumed.
    expect(rows[0].status).toBe('open')
  })

  // Payload assertions that do not round-trip through D1. These kill the class of
  // mutation where a field is changed at the source and no SELECT happens to look
  // at it.
  it('builds a payload whose every field the emit depends on is pinned', () => {
    const plan = buildEscalationTaskPlan(
      makeAgent({ id: 'agent-x', slug: 'slug-x', squad_id: 'squad-x' }),
      'escalate: consecutive_fails=9',
      42,
    )

    expect(plan.input.squad_id).toBe('squad-x')
    expect(plan.input.gate_owner).toBe('gate:escalation')
    expect(plan.input.done_when).toBe('(operator resolves — set via task update)')
    expect(plan.input.title).toBe('ESCALATION: agent slug-x stuck')
    expect(plan.input.body).toContain('agent-x')
    expect(plan.input.body).toContain('Cycle: 42')

    // Provenance: the escalation is attributed to the stuck agent, which is what
    // task.created carries to the bus.
    expect(plan.options.actor).toEqual({ kind: 'agent', id: 'agent-x' })
    expect(plan.options.allowDeferredPredicate).toBe(true)

    // skipMirror MUST stay absent. createTask mirrors to a GitHub issue unless it
    // is set, and on a tenant with GITHUB_REPO configured that issue is the only
    // surface that reaches a person. Setting it here would silence escalations
    // while every other test stayed green.
    expect(plan.options).not.toHaveProperty('skipMirror')
  })

  it('falls back to "unknown" when the observer gave no reason', () => {
    expect(buildEscalationTaskPlan(makeAgent(), null, 1).input.body).toContain('Reason: unknown')
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

  // SOURCE LINT — the done_when's literal requirement, and its honest limits.
  //
  // Everything above proves the emit WORKS. None of it notices the emit being
  // deleted from the runtime, because agent-do.ts cannot be imported here
  // ('cloudflare:workers' is resolved upstream of Vite and cannot be aliased —
  // see vitest.composition.config.ts).
  //
  // This is a LINT, not a test, and the distinction is not pedantic: a text
  // match cannot prove the call is reachable. An adversarial gate defeated the
  // first version by commenting the call out and by dead-branching it
  // (`false ? await emitEscalation(...) : ...`). Slicing to the branch's own
  // closing brace and dropping comment lines closes those two; a determined
  // edit can still defeat it. The runtime-reachability half is covered instead
  // by the observer-seam assertions in tests/sane-brain-s3.test.ts.
  it('AgentDO still calls the emit inside the escalate branch (source lint)', () => {
    const src = readFileSync(new URL('../src/agents/agent-do.ts', import.meta.url), 'utf8')

    expect(src, 'agent-do.ts no longer imports the escalation emit').toContain(
      "from './escalation'",
    )

    const branchStart = src.indexOf('if (obs?.escalate) {')
    expect(branchStart, 'the obs?.escalate branch is gone from AgentDO').toBeGreaterThan(-1)

    // Slice to the branch's OWN closing brace. The first version used a fixed
    // 900-char window; the branch closes at 607, so it read ~293 chars past the
    // block and would have matched an occurrence in the return statement below.
    const tail = src.slice(branchStart)
    let depth = 0
    let end = -1
    for (let i = 0; i < tail.length; i += 1) {
      if (tail[i] === '{') depth += 1
      else if (tail[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end, 'could not find the end of the escalate branch').toBeGreaterThan(-1)

    const branch = tail
      .slice(0, end)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

    expect(
      branch,
      'the escalate branch no longer calls emitEscalation — the brain detects a ' +
        'stuck agent and tells nobody',
    ).toContain('emitEscalation(')
  })

  // The one bind between gates/lanes.ts and the emit that is worth pinning: the
  // lane constant and the wire value must not drift apart silently.
  it('GATE_ESCALATION is the wire value the emit writes', () => {
    expect(GATE_ESCALATION).toBe('gate:escalation')
  })
})

// flight status writers — the guard that keeps the code's status vocabulary equal to
// what production can actually produce (mupot#913).
//
// Why this file exists
// --------------------
// 0017_flights.sql sketched a seven-state lifecycle. Two of those states, 'waiting'
// (a human gate) and 'sleeping' (between legs, waking at next_run_at), were never
// given a writer: no code path in src/ ever issued `status='waiting'`, and the single
// `status='sleeping'` writer (sleepFlight) was reachable only from its own unit test.
// Three separate consumers nevertheless branched on them for months — a board phase
// nothing could reach, a "next departure" countdown nothing could schedule, and
// land/fail guards admitting states no row could hold. Nothing failed, which is
// exactly the problem: dead states cost reading time on every pass over the spine and
// each one is a plausible-looking branch that a reader must disprove by hand.
//
// So this suite asserts the invariant directly, in the only form that stays true as
// the code changes: the FlightStatus union must equal the set of statuses some writer
// in src/ can actually emit, and the two "live" sets must be derived from that same
// union. Add a writer for a new state and this file goes red until the union and the
// live sets learn about it. Add a state to the union with no writer and it goes red
// too. That is the whole point — the previous drift was silent in both directions.
//
// Deliberately NOT asserted: the DB CHECK constraint. It still allows all seven names
// and flights.next_run_at still exists. Narrowing either on D1 is a table rewrite, and
// `flights` carries a partial unique index (idx_marketing_recommendation_flight_dedup,
// 0054/0064) plus the marketing fence triggers that reference it; a rewrite would drop
// them silently. A CHECK wider than the code emits constrains without obliging, so the
// schema half is safe to defer. The test below pins that asymmetry so it stays a known,
// intentional gap rather than a rediscovered surprise.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildBoard } from '../src/flight/board'
import { detectFlightCollisions } from '../src/flight/clearance'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import type { FlightMetaV1 } from '../src/flight/meta'

const SRC = join(__dirname, '..', 'src')
const SERVICE = join(SRC, 'flight', 'service.ts')

// Every status the code can put into the flights table. Kept as a literal (not derived
// from the type — types are erased at runtime) so the assertions below are checking one
// hand-written list against the source, not a list against itself.
const PRODUCIBLE: readonly FlightStatus[] = ['preflight', 'held', 'running', 'landed', 'failed']

// The two states 0017 allows that no writer produces. Named so a future reader who
// wonders "why is the CHECK wider than the union?" finds the answer in a test, not in
// a commit message.
const SCHEMA_ONLY = ['waiting', 'sleeping'] as const

function readSrcFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readSrcFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

// Strip `//` line comments so prose ABOUT a removed writer (this repo comments at
// length, and flight/service.ts's header names sleepFlight to explain its absence)
// never reads as the writer itself.
function stripLineComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Statuses some statement in src/ can WRITE onto a FLIGHTS row. Two forms exist:
 *   1. `UPDATE flights SET … status='x' …` — every lifecycle transition.
 *   2. the entry state, which createFlight hardcodes as a bare literal in the column
 *      position of `INSERT INTO flights (… status …) VALUES/SELECT (… 'preflight' …)`.
 *
 * Scoped to statements naming `flights` on purpose: `status` is the most reused column
 * name in this schema (tasks, routines, routine_runs, projects, agents… all have one),
 * so an unscoped scan reports every status in the pot. Reader-side occurrences
 * (`WHERE status IN ('a','b')`) are also deliberately NOT matched — a guard that
 * mentions a status does not mean anything can reach it, and treating readers as
 * writers is precisely the confusion that let the dead states survive this long.
 */
function producedStatuses(): Set<string> {
  const written = new Set<string>()
  for (const file of readSrcFiles(SRC)) {
    const source = stripLineComments(readFileSync(file, 'utf8'))
    // The SET clause runs from `UPDATE flights SET` up to that statement's first WHERE.
    for (const stmt of source.matchAll(/UPDATE\s+flights\s+SET([\s\S]*?)\bWHERE\b/gi)) {
      for (const m of (stmt[1] as string).matchAll(/\bstatus\s*=\s*'([a-z_]+)'/g)) {
        written.add(m[1] as string)
      }
    }
    // The INSERT sits in a template literal, so the statement ends at the backtick.
    // Only real status names are accepted, which keeps unrelated literals in the
    // fenced variant's WHERE ('leased', 'observing') out.
    for (const stmt of source.matchAll(/INSERT INTO flights[^`]*/g)) {
      for (const m of (stmt[0] as string).matchAll(/'(preflight|held|running|landed|failed|waiting|sleeping)'/g)) {
        written.add(m[1] as string)
      }
    }
  }
  return written
}

function metaFor(taskIds: string[]): FlightMetaV1 {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-shared',
    objective_id: 'obj-shared',
    squad_ids: ['squad-a'],
    task_ids: taskIds,
    done_when: ['verified'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  }
}

function row(agent: string, status: FlightStatus, taskIds: string[]): FlightRow {
  return {
    id: crypto.randomUUID(),
    tenant: 'test',
    project_id: null,
    agent,
    goal: 'g',
    status,
    trigger_source: 'manual',
    gate_verdict: null,
    gate_reason: '',
    score: null,
    budget_micro_usd: null,
    cost_micro_usd: 0,
    created_at: 0,
    started_at: null,
    ended_at: null,
    meta: JSON.stringify(metaFor(taskIds)),
  }
}

describe('flight status vocabulary — every state has a writer', () => {
  it('src/ writes exactly the statuses FlightStatus declares', () => {
    expect([...producedStatuses()].sort()).toEqual([...PRODUCIBLE].sort())
  })

  it('no writer exists for the schema-only states (the mupot#913 regression)', () => {
    const produced = producedStatuses()
    for (const dead of SCHEMA_ONLY) {
      expect(produced.has(dead), `something now writes status='${dead}' — give it a phase in board.ts, decide whether it is LIVE in clearance.ts and schedule-state.ts, and add it to FlightStatus`).toBe(false)
    }
  })

  it('no status list anywhere in src/ still enumerates a dead state', () => {
    // The writer scan above does not see READERS, and readers are where the dead states
    // actually hid: a `WHERE status IN (…)` predicate, or an untyped
    // `ReadonlySet<string>` allowlist whose members TypeScript never checks against
    // FlightStatus. src/flight/routes.ts had both and neither the compiler nor the
    // first draft of this suite noticed. So: find every bracketed list of quoted
    // lowercase tokens that is ENTIRELY flight-status names, and require it to be free
    // of the schema-only two.
    //
    // Two filters together decide whether a list is about FLIGHTS. Every token must be
    // a flight status name, which drops routine_runs' ('running','waiting','succeeded',…)
    // and tasks' ('open','in_progress',…). And at least one token must be a name ONLY
    // flights use, because 'running'/'failed'/'waiting' are shared vocabulary across
    // half the schema — src/routines/actions.ts legitimately writes ('running','waiting')
    // about routine runs, and without this second filter that reads as a violation here.
    const ALL_FLIGHT_NAMES = new Set<string>([...PRODUCIBLE, ...SCHEMA_ONLY])
    const FLIGHT_ONLY = new Set<string>(['preflight', 'held', 'landed', 'sleeping'])
    const offenders: string[] = []
    for (const file of readSrcFiles(SRC)) {
      const source = stripLineComments(readFileSync(file, 'utf8'))
      for (const group of source.matchAll(/[[(]((?:\s*'[a-z_]+'\s*,)+\s*'[a-z_]+'\s*)[\])]/g)) {
        const tokens = [...(group[1] as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string)
        if (tokens.length < 2 || !tokens.every((t) => ALL_FLIGHT_NAMES.has(t))) continue
        if (!tokens.some((t) => FLIGHT_ONLY.has(t))) continue
        const dead = tokens.filter((t) => (SCHEMA_ONLY as readonly string[]).includes(t))
        if (dead.length > 0) offenders.push(`${file.slice(SRC.length + 1)}: [${tokens.join(', ')}]`)
      }
    }
    expect(offenders, 'flight status lists still naming a state nothing can produce').toEqual([])
  })

  it('the sleep/wake path stays deleted (no sleepFlight, no next_run_at write)', () => {
    const service = stripLineComments(readFileSync(SERVICE, 'utf8'))
    expect(service).not.toMatch(/sleepFlight/)
    expect(service).not.toMatch(/next_run_at\s*=/)
  })

  it('the DB CHECK is deliberately left WIDER than the code — schema cleanup deferred', () => {
    // Pins the intentional asymmetry: 0017 still permits all seven names. If someone
    // narrows the CHECK later they must do it in a migration that reckons with the
    // partial unique index + triggers on flights (see this file's header).
    const migration = readFileSync(join(__dirname, '..', 'migrations', '0017_flights.sql'), 'utf8')
    const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(migration)
    expect(check, 'flights CHECK constraint not found in 0017').not.toBeNull()
    const allowed = [...(check as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string)
    for (const status of PRODUCIBLE) expect(allowed).toContain(status)
    for (const dead of SCHEMA_ONLY) expect(allowed).toContain(dead)
    // …and the column the sleep path would have used is still there, unwritten.
    expect(migration).toMatch(/next_run_at\s+INTEGER/)
  })
})

describe('the LIVE sets are exactly the non-terminal producible statuses', () => {
  // One statement of truth for both live sets. 'held' is terminal despite sounding
  // in-progress: it is the NO-GO verdict, an ending.
  const LIVE: readonly FlightStatus[] = ['preflight', 'running']
  const TERMINAL: readonly FlightStatus[] = ['held', 'landed', 'failed']

  it('covers every producible status exactly once', () => {
    expect([...LIVE, ...TERMINAL].sort()).toEqual([...PRODUCIBLE].sort())
  })

  it('board.ts: card.live is true for preflight/running and false for the rest', () => {
    const cards = buildBoard(PRODUCIBLE.map((s) => row(s, s, ['t'])), 0)
    const live = cards.filter((c) => c.live).map((c) => c.status).sort()
    expect(live).toEqual([...LIVE].sort())
  })

  it('board.ts: every producible status maps to a phase (no undefined cards)', () => {
    const cards = buildBoard(PRODUCIBLE.map((s) => row(s, s, ['t'])), 0)
    expect(cards.every((c) => typeof c.phase === 'string' && c.phase.length > 0)).toBe(true)
  })

  it('clearance.ts: only preflight/running collide, and its set mirrors board.ts', () => {
    for (const status of PRODUCIBLE) {
      const a = row('a', status, ['shared-task'])
      const b = row('b', 'running', ['shared-task'])
      const collisions = detectFlightCollisions([a, b])
      const shouldCollide = LIVE.includes(status)
      expect(
        collisions.length > 0,
        `status=${status} should ${shouldCollide ? '' : 'NOT '}be treated as live by clearance`,
      ).toBe(shouldCollide)
    }
  })
})

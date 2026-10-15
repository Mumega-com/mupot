// tests/flight-dispatch-teaches-itself.test.ts — Hadi/Athena 2026-10-15: "Mupot itself should teach this flow". The examples printed in the
// flight_dispatch tool description are EXTRACTED here and run through the real parsers, so the documentation cannot rot into an example the
// server would refuse, and the "unknown inputs" guidance stays true to the real scoring.
import { describe, expect, it } from 'vitest'
import { advertisedTools } from '../src/mcp/index'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { parseDispatchBody } from '../src/flight/routes'
import { preflightCheck } from '../src/flight/preflight'

const ENV = { SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' } as never
const args = (): string => String((advertisedTools(ENV).find((t) => t.name === 'flight_dispatch') as unknown as { args: string }).args)

/** The first balanced {...} that starts at the first occurrence of `marker`. */
function jsonAfter(text: string, marker: string): unknown {
  const start = text.indexOf(marker)
  expect(start, `marker ${marker} present`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)) }
  }
  throw new Error('unbalanced example')
}

describe('flight_dispatch description examples are real', () => {
  it('the meta_json example parses as FlightMetaV1 once its placeholders are filled', () => {
    const ex = jsonAfter(args(), '{"schema":"mupot.flight.meta/v1"') as Record<string, unknown>
    const filled = { ...ex, goal_id: 'goal-1', objective_id: 'obj-1', squad_ids: ['squad-core'], task_ids: ['task-1'], done_when: ['the packet is accepted'] }
    expect(parseFlightMetaV1(filled)).not.toBeNull()
    expect(parseFlightMetaV1({ ...filled, extra_key: 1 })).toBeNull() // "unknown keys refused" is true
  })
  it('the signals example is accepted by the real dispatch parser AND passes the preflight gate; the 0/0/0 "no history" case does not', () => {
    const ex = jsonAfter(args(), '{"contextComplete":true') as Record<string, unknown>
    const parsed = parseDispatchBody({ agent: 'a', dispatched_by: 'a', goal: 'g', trigger_source: 'api', budget_micro_usd: 0, meta: parseFlightMetaV1({ schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: ['s'], task_ids: ['t'], done_when: ['d'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null }), signals: ex })
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    if (!parsed.ok) return
    expect(preflightCheck(parsed.value.signals).go).toBe(true)
    const zeros = preflightCheck({ ...parsed.value.signals, recentProgress: 0, progressPerStep: 0, wastePerStep: 0 })
    expect(zeros.go).toBe(false)
    expect(zeros.reasons).toContain('low_readiness')
    expect(zeros.score).toBeGreaterThan(0.1)
    expect(zeros.score).toBeLessThan(0.2) // "~0.13" in the text
  })
  it('the description states there is no "unknown" and that the neutral prior is an assumption', () => {
    expect(args()).toMatch(/NO "unknown"/)
    expect(args()).toMatch(/assumption, not a measurement/)
    expect(args()).toContain('no live-flight collision') // flight_clearance_hold also forces a no-go
    expect(args()).toContain('belong to a listed squad') // flight_task_scope_mismatch
    expect(args()).toContain('lead if budget_micro_usd>0')
    expect(args()).toContain('objective_id is a free label') // an attached chat cannot objective_accept (agent_bound_workspace_credential_required)
  })
  it('the description stays inside a size budget (every tool description ships in tools/list; this one is the largest, do not let it grow)', () => {
    expect(args().length).toBeLessThan(2400)
  })
})

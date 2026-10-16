// tests/ops-kpi-lower-bound-render.test.ts
//
// WHY THIS EXISTS. #1319 added `needsDecisionCountIsLowerBound` so a CAPPED
// approval queue could not be reported as an exact count. The flag was computed,
// carried through OperatorCounts, threaded into OpsHealthData.kpis, and rendered
// with a `+` on the home surface — and then the /ops KPI card rendered
// `String(data.kpis.needsDecision)`, dropping it. Codex flagged it at ad364c44.
//
// A data-parity test (home.flag === health.flag) would NOT have caught this: both
// values were correct. The defect was entirely in the render, so the render is
// what must be asserted. This is the "existence is not enforcement" shape — the
// honest field existed and the display ignored it.

import { describe, expect, it } from 'vitest'
import { opsHealthBody } from '../src/dashboard/index'
import { approvalsCheckPresentation, type OpsHealthData } from '../src/dashboard/health'

function data(needsDecision: number, isLowerBound: boolean): OpsHealthData {
  return {
    generatedAt: '2026-09-05T00:00:00.000Z',
    overallTone: 'ok',
    checks: [],
    kpis: {
      activeAgents: 1,
      runtimeOnline: 1,
      activePresence: 1,
      needsDecision,
      needsDecisionIsLowerBound: isLowerBound,
      allReviewersNeedsDecision: needsDecision,
      allReviewersNeedsDecisionIsLowerBound: isLowerBound,
      blockedOrRejected: 0,
      recentAudit: 0,
    },
    runtimeSignals: [],
    recentFailures: [],
    auditSignals: [],
  }
}

// The card markup is `<div ...>VALUE</div>` next to the label; asserting on the
// rendered string keeps this honest about what an operator actually sees.
function renderedNeedsDecision(d: OpsHealthData): string {
  const html = String(opsHealthBody(d))
  const idx = html.indexOf('Waiting on you')
  expect(idx).toBeGreaterThan(-1)
  // The value sits in the same stat card as the label; take a window around it.
  return html.slice(Math.max(0, idx - 400), idx + 400)
}

describe('/ops "Waiting on you" KPI tells the truth about a capped queue', () => {
  it('renders a bare count when the queue was NOT truncated', () => {
    const window = renderedNeedsDecision(data(2, false))
    expect(window).toContain('>2<')
    expect(window).not.toContain('>2+<')
  })

  it('renders the lower-bound marker when the queue WAS truncated', () => {
    const window = renderedNeedsDecision(data(2, true))
    expect(window).toContain('>2+<')
  })

  it('a truncated zero is still marked — absent is not the same as none', () => {
    // Defensive: if a cap ever produces 0 with more behind it, the operator must
    // not read "nothing waiting" off a truncated read.
    const window = renderedNeedsDecision(data(0, true))
    expect(window).toContain('>0+<')
  })
})

// The KPI card is one of TWO surfaces that report the same number. The health
// check line reported 'clear' / 'No tasks are waiting in review' whenever the
// count was 0, without consulting the lower-bound flag — so a queue whose
// candidate fetch hit APPROVALS_FETCH_CEILING and filtered every row out read as
// an all-clear while an actionable task could sit past the ceiling, unloaded.
// Codex found the symptom; the repair is that an unknown must present as unknown,
// not that the loader should fetch more.
describe('the Approval gates check does not call a TRUNCATED zero "clear"', () => {
  it('an exact zero is clear', () => {
    const r = approvalsCheckPresentation(0, false)
    expect(r.tone).toBe('ok')
    expect(r.state).toBe('clear')
    expect(r.detail).toBe('No tasks are waiting in review.')
  })

  it('a truncated zero is NOT clear — it warns and says the count cannot prove empty', () => {
    const r = approvalsCheckPresentation(0, true)
    expect(r.tone).toBe('warn')
    expect(r.state).toBe('0+ waiting')
    expect(r.detail).toContain('lower bound')
    expect(r.nextAction).toContain('cannot prove it is empty')
  })

  it('a truncated positive count keeps its marker', () => {
    const r = approvalsCheckPresentation(3, true)
    expect(r.tone).toBe('warn')
    expect(r.state).toBe('3+ waiting')
  })

  it('an exact positive count carries no marker', () => {
    expect(approvalsCheckPresentation(3, false).state).toBe('3 waiting')
  })
})

describe('org-wide total is labelled "across all reviewers" and never replaces the own count (#1993)', () => {
  it('Health check: headline is the own count, the all-gate total is a labelled aside', () => {
    const r = approvalsCheckPresentation(1, false, { count: 5, isLowerBound: true })
    expect(r.state).toBe('1 waiting')
    expect(r.detail).toContain('5+ across all reviewers')
  })

  it('Health check: own zero with others waiting says nothing is waiting on you', () => {
    const r = approvalsCheckPresentation(0, false, { count: 4, isLowerBound: false })
    expect(r.state).toBe('clear')
    expect(r.detail).toContain('Nothing is waiting on you.')
    expect(r.detail).toContain('4 across all reviewers')
  })

  it('/ops KPI card renders the aside only when the org total exceeds the own count', () => {
    const d = data(1, false)
    d.kpis.allReviewersNeedsDecision = 6
    expect(String(opsHealthBody(d))).toContain('6 across all reviewers')
    expect(String(opsHealthBody(data(1, false)))).not.toContain('across all reviewers')
  })
})

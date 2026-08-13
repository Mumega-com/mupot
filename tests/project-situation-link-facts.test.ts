// tests/project-situation-link-facts.test.ts — the two pure functions #835 adds.
//
// WHY THIS FILE EXISTS
//
// #835 shipped `projectSituationFactFor` and `projectLinkHealthFromRow` with ZERO tests.
// Both are pure and both carry real branch logic — `projectLinkHealthFromRow` alone has a
// five-way decision (revoked / no-signal / failure-newer-than-success / staleness window /
// healthy) — and neither was exercised by anything in the repo.
//
// That matters more than usual here because `fact.source_pot` is a READ-SIDE DISCLOSURE:
// `loadProjectSituation` feeds src/mcp/projects.ts and src/dashboard/projects.ts, so anyone
// with project-situation read access now learns which remote pots a project is linked to and
// whether those links are failed, stale or revoked. A wrong health verdict does not crash —
// it silently mislabels a dead remote as current, or a healthy one as stale.
//
// Every case below is written against the boundary rather than the middle, because that is
// where this class of function actually fails.

import { describe, expect, it } from 'vitest'
import {
  projectSituationFactFor,
  projectLinkHealthFromRow,
  type ProjectSituationLinkHealth,
} from '../src/projects/situation'

/** A link row with every signal absent; each test sets only what it is about. */
const row = (over: Partial<Parameters<typeof projectLinkHealthFromRow>[0]> = {}) => ({
  state: 'active' as const,
  last_success_at: null,
  last_failure_at: null,
  success_event_at: null,
  failure_event_at: null,
  now_event_at: null,
  stale_after_seconds: 3600,
  ...over,
})

describe('projectLinkHealthFromRow', () => {
  it('revoked wins over every other signal', () => {
    // Ordering matters: a revoked link with a recent success must NOT read healthy. If the
    // revoked check ever moves below the success checks, a revoked remote starts presenting
    // as current on the read surface.
    expect(
      projectLinkHealthFromRow(
        row({
          state: 'revoked',
          last_success_at: '2026-08-13 12:00:00',
          success_event_at: 1_000_000,
          now_event_at: 1_000_100,
        }),
      ),
    ).toBe('revoked')
  })

  it('no success and no failure is unknown, not healthy', () => {
    // The fail-open direction. A link that has never reported anything is not evidence of
    // health, and defaulting it to healthy would label an unverified remote as current.
    expect(projectLinkHealthFromRow(row())).toBe('unknown')
  })

  it('a failure with no success at all is failed', () => {
    expect(
      projectLinkHealthFromRow(row({ last_failure_at: '2026-08-13 12:00:00', failure_event_at: 5 })),
    ).toBe('failed')
  })

  it('failure NEWER than success is failed', () => {
    expect(
      projectLinkHealthFromRow(
        row({
          last_success_at: '2026-08-13 11:00:00',
          last_failure_at: '2026-08-13 12:00:00',
          success_event_at: 100,
          failure_event_at: 200,
          now_event_at: 300,
        }),
      ),
    ).toBe('failed')
  })

  it('failure OLDER than success is not failed — recovery is visible', () => {
    // The mirror of the case above, and the one that decides whether a recovered link ever
    // returns to healthy. Without it, a single historical failure would pin the link failed
    // forever.
    expect(
      projectLinkHealthFromRow(
        row({
          last_success_at: '2026-08-13 12:00:00',
          last_failure_at: '2026-08-13 11:00:00',
          success_event_at: 200,
          failure_event_at: 100,
          now_event_at: 300,
        }),
      ),
    ).toBe('healthy')
  })

  it('staleness is measured in MILLISECONDS against a seconds-valued window', () => {
    // stale_after_seconds is seconds; the event columns are epoch MILLISECONDS, and the
    // comparison multiplies by 1000. Getting that unit wrong by a factor of 1000 does not
    // throw — it just makes everything permanently healthy (or permanently stale). These two
    // cases sit either side of the exact boundary so the multiplier is load-bearing.
    const base = {
      last_success_at: '2026-08-13 12:00:00',
      success_event_at: 0,
      stale_after_seconds: 60,
    }
    // 60_000ms elapsed === the window exactly. Strictly-greater, so this is NOT stale.
    expect(projectLinkHealthFromRow(row({ ...base, now_event_at: 60_000 }))).toBe('healthy')
    // One millisecond past the window.
    expect(projectLinkHealthFromRow(row({ ...base, now_event_at: 60_001 }))).toBe('stale')
  })

  it('a success with no clock reading cannot be stale', () => {
    // now_event_at null means the elapsed time is unknown. Unknown elapsed must not silently
    // become "within the window" by arithmetic on a null.
    expect(
      projectLinkHealthFromRow(
        row({ last_success_at: '2026-08-13 12:00:00', success_event_at: 0, now_event_at: null }),
      ),
    ).toBe('healthy')
  })
})

describe('projectSituationFactFor', () => {
  const health = (h: ProjectSituationLinkHealth) => new Map([['pot-a', h]])

  it('no source pot is local, and carries no pot identity', () => {
    for (const empty of [null, undefined, '']) {
      expect(projectSituationFactFor(empty, new Map())).toEqual({ kind: 'local', source_pot: null })
    }
  })

  it('a healthy link is current_remote', () => {
    expect(projectSituationFactFor('pot-a', health('healthy'))).toEqual({
      kind: 'current_remote',
      source_pot: 'pot-a',
    })
  })

  it('stale, failed and revoked all read as stale_remote', () => {
    // Three different health states collapse to one fact kind on purpose — the read surface
    // distinguishes "trust this" from "do not trust this", not the reason. Pinned so that a
    // future edit adding a fourth degraded state has to decide deliberately.
    for (const h of ['stale', 'failed', 'revoked'] as const) {
      expect(projectSituationFactFor('pot-a', health(h))).toEqual({
        kind: 'stale_remote',
        source_pot: 'pot-a',
      })
    }
  })

  it('a source pot with NO entry in the map is unknown, not local and not current', () => {
    // The gap case: a task claims a source pot that has no link row at all. Falling through
    // to 'local' would erase the remote identity; falling through to 'current_remote' would
    // assert health nobody measured.
    expect(projectSituationFactFor('pot-ghost', new Map())).toEqual({
      kind: 'unknown',
      source_pot: 'pot-ghost',
    })
  })

  it("an explicitly 'unknown' health is also unknown", () => {
    expect(projectSituationFactFor('pot-a', health('unknown'))).toEqual({
      kind: 'unknown',
      source_pot: 'pot-a',
    })
  })
})

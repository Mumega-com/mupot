// tests/instinct.test.ts — pure Port 4 instinct rules (confidence / decay / promote / parse).

import { describe, expect, it } from 'vitest'
import {
  clampInstinctConfidence,
  decayInstinctConfidence,
  filterInstinctsForInject,
  parseInstinctDistillOutput,
  reinforceInstinctConfidence,
  resolveInstinctPrecedence,
  shouldPromoteInstinct,
  type Instinct,
} from '../src/memory/instinct'

function instinct(over: Partial<Instinct> & Pick<Instinct, 'id'>): Instinct {
  return {
    trigger: 'when testing',
    confidence: 0.7,
    domain: 'testing',
    scope: 'project',
    action: 'prefer vitest',
    evidence: ['obs-1'],
    projectId: 'proj-a',
    agentId: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

describe('clampInstinctConfidence', () => {
  it('clamps into [0.3, 0.9]', () => {
    expect(clampInstinctConfidence(0.1)).toBe(0.3)
    expect(clampInstinctConfidence(1.2)).toBe(0.9)
    expect(clampInstinctConfidence(0.55)).toBe(0.55)
  })
})

describe('decayInstinctConfidence', () => {
  it('halves after one half-life and floors at 0.3', () => {
    const half = decayInstinctConfidence(
      0.8,
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      30,
    )
    expect(half).toBeCloseTo(0.4, 5)

    const floored = decayInstinctConfidence(
      0.35,
      '2026-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      30,
    )
    expect(floored).toBe(0.3)
  })
})

describe('reinforceInstinctConfidence', () => {
  it('bumps toward the ceiling', () => {
    expect(reinforceInstinctConfidence(0.85, 0.05)).toBeCloseTo(0.9, 5)
    expect(reinforceInstinctConfidence(0.5, 0.05)).toBeCloseTo(0.55, 5)
  })
})

describe('shouldPromoteInstinct', () => {
  it('requires ≥2 projects and avg confidence ≥ 0.8', () => {
    expect(shouldPromoteInstinct([
      instinct({ id: 'x', projectId: 'p1', confidence: 0.9 }),
    ])).toBe(false)

    expect(shouldPromoteInstinct([
      instinct({ id: 'x', projectId: 'p1', confidence: 0.7 }),
      instinct({ id: 'x', projectId: 'p2', confidence: 0.7 }),
    ])).toBe(false)

    expect(shouldPromoteInstinct([
      instinct({ id: 'x', projectId: 'p1', confidence: 0.85 }),
      instinct({ id: 'x', projectId: 'p2', confidence: 0.85 }),
    ])).toBe(true)
  })
})

describe('resolveInstinctPrecedence', () => {
  it('project shadows global for the same id', () => {
    const resolved = resolveInstinctPrecedence([
      instinct({ id: 'prefer-vitest', scope: 'global', projectId: null, confidence: 0.9, action: 'global' }),
      instinct({ id: 'prefer-vitest', scope: 'project', projectId: 'p1', confidence: 0.6, action: 'project' }),
    ])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].action).toBe('project')
  })
})

describe('filterInstinctsForInject', () => {
  it('applies decay then filters by threshold', () => {
    const injected = filterInstinctsForInject(
      [
        instinct({
          id: 'stale',
          confidence: 0.75,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        instinct({
          id: 'fresh',
          confidence: 0.75,
          updatedAt: '2026-07-20T00:00:00.000Z',
        }),
      ],
      { minConfidence: 0.7, maxInjected: 6 },
      '2026-07-22T00:00:00.000Z',
      30,
    )
    expect(injected.map((i) => i.id)).toEqual(['fresh'])
  })
})

describe('parseInstinctDistillOutput', () => {
  it('parses a JSON array and drops invalid rows', () => {
    const raw = '```json\n[{"id":"prefer-vitest","trigger":"when testing","action":"use vitest","confidence":0.7,"domain":"testing","evidence":["a"]},{"id":"BAD ID","trigger":"x","action":"y","confidence":0.5}]\n```'
    const parsed = parseInstinctDistillOutput(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('prefer-vitest')
  })
})

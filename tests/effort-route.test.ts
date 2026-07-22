// tests/effort-route.test.ts — pure brain effort → idle harness router.
// No I/O. Ladder + capability tags are the contract (kasra GREEN + amendments 2026-07-22).

import { describe, expect, it } from 'vitest'
import {
  classifyTaskRoleEffort,
  effortLadder,
  effectiveHarnessCapabilities,
  harnessHasRoleCapability,
  HARNESS_CAPABILITIES,
  routeByEffort,
  type OnlineHarness,
  type RouteEffort,
  type HarnessRole,
} from '../src/tasks/effort-route'

function online(slugs: readonly string[], capsBySlug: Record<string, readonly string[]> = {}): OnlineHarness[] {
  return slugs.map((slug) => ({
    slug,
    capabilities: capsBySlug[slug] ?? [],
  }))
}

function loadMap(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries))
}

describe('HARNESS_CAPABILITIES — agy is research-only', () => {
  it('agy has research and never build/review', () => {
    expect(HARNESS_CAPABILITIES.agy).toEqual(['research'])
    expect(HARNESS_CAPABILITIES.agy).not.toContain('build')
    expect(HARNESS_CAPABILITIES.agy).not.toContain('review')
  })

  it('presence cannot grant agy build or review', () => {
    const caps = effectiveHarnessCapabilities('agy', ['build', 'review', 'research'])
    expect(caps).toEqual(['research'])
    expect(harnessHasRoleCapability('agy', ['build', 'review'], 'build')).toBe(false)
    expect(harnessHasRoleCapability('agy', ['build', 'review'], 'review')).toBe(false)
    expect(harnessHasRoleCapability('agy', ['research'], 'research')).toBe(true)
  })

  it('codex is review-only; cursor is build-only; kasra has all three', () => {
    expect(HARNESS_CAPABILITIES.codex).toEqual(['review'])
    expect(HARNESS_CAPABILITIES.cursor).toEqual(['build'])
    expect(HARNESS_CAPABILITIES.kasra).toEqual(['build', 'research', 'review'])
  })
})

describe('effortLadder — approved ladders', () => {
  it('research low/standard: agy → kayhermes → kasra', () => {
    expect(effortLadder('research', 'low')).toEqual(['agy', 'kayhermes', 'kasra'])
    expect(effortLadder('research', 'standard')).toEqual(['agy', 'kayhermes', 'kasra'])
  })

  it('research high: kasra → agy', () => {
    expect(effortLadder('research', 'high')).toEqual(['kasra', 'agy'])
  })

  it('build low/standard: cursor → kasra; high: kasra → cursor', () => {
    expect(effortLadder('build', 'low')).toEqual(['cursor', 'kasra'])
    expect(effortLadder('build', 'standard')).toEqual(['cursor', 'kasra'])
    expect(effortLadder('build', 'high')).toEqual(['kasra', 'cursor'])
  })

  it('review any: codex → kasra (agy NOT on the review path)', () => {
    for (const effort of ['low', 'standard', 'high'] as RouteEffort[]) {
      expect(effortLadder('review', effort)).toEqual(['codex', 'kasra'])
      expect(effortLadder('review', effort)).not.toContain('agy')
    }
  })

  it('operate: kasra only', () => {
    expect(effortLadder('operate', 'standard')).toEqual(['kasra'])
  })
})

describe('routeByEffort', () => {
  it('assigns first idle online harness on the ladder', () => {
    const result = routeByEffort({
      role: 'research',
      effort: 'standard',
      online: online(['kayhermes', 'kasra', 'agy']),
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result).toEqual({
      action: 'assign',
      agentSlug: 'agy',
      ladder: ['agy', 'kayhermes', 'kasra'],
    })
  })

  it('skips a busy agent and uses the next in the ladder', () => {
    const result = routeByEffort({
      role: 'build',
      effort: 'standard',
      online: online(['cursor', 'kasra']),
      load: loadMap({ cursor: 2 }),
      maxLoadPerAgent: 2,
    })
    expect(result.action).toBe('assign')
    expect(result.agentSlug).toBe('kasra')
  })

  it('agy is never selected for build even when online and idle', () => {
    const result = routeByEffort({
      role: 'build',
      effort: 'standard',
      online: online(['agy', 'cursor'], { agy: ['build', 'research'] }),
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result.action).toBe('assign')
    expect(result.agentSlug).toBe('cursor')
  })

  it('agy is never selected for review (codex → kasra only)', () => {
    const result = routeByEffort({
      role: 'review',
      effort: 'standard',
      online: online(['agy', 'codex', 'kasra'], { agy: ['review'] }),
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result.agentSlug).toBe('codex')
  })

  it('agy is never selected for operate', () => {
    const result = routeByEffort({
      role: 'operate',
      effort: 'high',
      online: online(['agy', 'cursor', 'kasra']),
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result.agentSlug).toBe('kasra')
  })

  it('empty online → skip (noop)', () => {
    const result = routeByEffort({
      role: 'build',
      effort: 'standard',
      online: [],
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result).toEqual({
      action: 'skip',
      agentSlug: null,
      ladder: ['cursor', 'kasra'],
    })
  })

  it('online but all busy/incapable → escalate', () => {
    const result = routeByEffort({
      role: 'build',
      effort: 'standard',
      online: online(['cursor', 'kasra']),
      load: loadMap({ cursor: 2, kasra: 2 }),
      maxLoadPerAgent: 2,
    })
    expect(result).toEqual({
      action: 'escalate',
      agentSlug: null,
      ladder: ['cursor', 'kasra'],
    })
  })

  it('falls back to a non-ladder online builder that declares build', () => {
    const result = routeByEffort({
      role: 'build',
      effort: 'standard',
      online: online(['builder'], { builder: ['build'] }),
      load: loadMap({}),
      maxLoadPerAgent: 2,
    })
    expect(result.action).toBe('assign')
    expect(result.agentSlug).toBe('builder')
  })

  it('action space is only assign|skip|escalate', () => {
    const actions = new Set(['assign', 'skip', 'escalate'])
    const cases: Array<{ role: HarnessRole; effort: RouteEffort; online: OnlineHarness[]; load: Map<string, number> }> = [
      { role: 'build', effort: 'low', online: [], load: loadMap({}) },
      { role: 'build', effort: 'high', online: online(['kasra']), load: loadMap({}) },
      { role: 'research', effort: 'standard', online: online(['agy']), load: loadMap({ agy: 9 }) },
    ]
    for (const c of cases) {
      const r = routeByEffort({ ...c, maxLoadPerAgent: 2 })
      expect(actions.has(r.action)).toBe(true)
    }
  })
})

describe('classifyTaskRoleEffort', () => {
  it('defaults to build/standard', () => {
    expect(classifyTaskRoleEffort({ title: 'Ship the feature', body: '' })).toEqual({
      role: 'build',
      effort: 'standard',
    })
  })

  it('honors explicit [role:] / [effort:] markers', () => {
    expect(
      classifyTaskRoleEffort({
        title: 'Look into X',
        body: '[role:research] [effort:high]',
      }),
    ).toEqual({ role: 'research', effort: 'high' })
  })

  it('detects review / research keywords', () => {
    expect(classifyTaskRoleEffort({ title: 'Code review PR #12', body: '' }).role).toBe('review')
    expect(classifyTaskRoleEffort({ title: 'Research competitor pricing', body: '' }).role).toBe(
      'research',
    )
  })
})

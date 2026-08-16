// tests/check-operator-counts-source.test.ts — self-test for
// scripts/check-operator-counts-source.mjs (the Flight-008 Slice 1 / mupot#1060
// structural gate). Mirrors tests/test-schema-source.test.mjs's convention: the
// detector logic is pure and imported directly, driven with synthetic file content —
// no throwaway files, no subprocess.
//
// This file exists so the gate itself is proven to fire, not just proven to pass on
// today's clean tree (a checker with no tests of its own is exactly the shape
// check-test-schema-source.mjs's own header warns about).

import { describe, it, expect } from 'vitest'
import { violationsForFile } from '../scripts/check-operator-counts-source.mjs'

describe('check-operator-counts-source: violationsForFile', () => {
  it('flags a reintroduced agents GROUP BY status query outside operator-counts.ts', () => {
    const src = `
      export async function loadOpsHealth(env, nowMs = Date.now()) {
        const agents = await env.DB.prepare('SELECT status, COUNT(*) AS count FROM agents GROUP BY status').all()
      }
    `
    const hits = violationsForFile('health.ts', src)
    expect(hits.map((h) => h.pattern)).toContain('agents-group-by-status')
  })

  it('flags a reintroduced tasks GROUP BY status query outside operator-counts.ts', () => {
    const src = `SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`
    const hits = violationsForFile('health.ts', src)
    expect(hits.map((h) => h.pattern)).toContain('tasks-group-by-status')
  })

  it('flags a hand-rolled live-runtime filter outside operator-counts.ts', () => {
    const src = `const liveRuntimeCount = agents.filter((a) => runtimeStates.get(a.id) === 'live').length`
    const hits = violationsForFile('index.ts', src)
    expect(hits.map((h) => h.pattern)).toContain('inline-live-runtime-filter')
  })

  it('does NOT flag operator-counts.ts itself — it is the canonical home for all three patterns', () => {
    const src = `
      // agents GROUP BY status
      // FROM agents ... GROUP BY status
      // FROM tasks ... GROUP BY status
      if (runtimeStates.get(a.id) === 'live') liveRuntimeCount++
    `
    expect(violationsForFile('operator-counts.ts', src)).toEqual([])
  })

  it('does NOT flag radar.ts\'s documented per-squad live-member tally', () => {
    const src = `const liveMembers = memberIds.filter((id) => runtimeStates.get(id) === 'live').length`
    expect(violationsForFile('radar.ts', src)).toEqual([])
  })

  it('a clean file with neither pattern is not flagged', () => {
    const src = `export function unrelated() { return 1 + 1 }`
    expect(violationsForFile('some-other-file.ts', src)).toEqual([])
  })

  it('a file can trip more than one pattern at once', () => {
    const src = `
      FROM agents GROUP BY status
      FROM tasks GROUP BY status
      runtimeStates.get(a.id) === 'live'
    `
    const hits = violationsForFile('some-surface.ts', src).map((h) => h.pattern)
    expect(hits).toEqual(
      expect.arrayContaining(['agents-group-by-status', 'tasks-group-by-status', 'inline-live-runtime-filter']),
    )
  })
})

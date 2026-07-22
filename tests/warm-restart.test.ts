// Port 4 — warm-restart + instinct-memory (pure logic + post-compaction resume).
// DONE WHEN: post-compaction session resumes warm with no lost fine-grain context.

import { describe, expect, it } from 'vitest'
import {
  buildSessionHandoffDocument,
  buildWarmResumeContext,
  guardStaleReplay,
  handoffPreservesFineGrain,
  selectMatchingHandoff,
  STALE_REPLAY_BEGIN,
  STALE_REPLAY_END,
  type SessionHandoffParts,
  type StoredHandoff,
} from '../src/memory/warm-restart'
import {
  clampInstinctConfidence,
  defaultInstinctInjectOpts,
  filterInstinctsForInject,
  resolveInstinctPrecedence,
  shouldPromoteInstinct,
  summarizeInstinctsForInject,
  type Instinct,
} from '../src/memory/instinct'

function parts(overrides: Partial<SessionHandoffParts> = {}): SessionHandoffParts {
  return {
    sessionId: 'sess-abc12345',
    projectId: 'proj-1',
    worktree: '/home/mumega/mupot-worktrees/cursor-efed841a',
    branch: 'cursor/task-efed841a',
    reason: 'pre_compact',
    userMessages: [
      'Port 4 warm-restart',
      'Keep fine-grain: files + decisions',
    ],
    filesModified: [
      'src/memory/warm-restart.ts',
      'migrations/0070_warm_restart_instinct.sql',
    ],
    toolsUsed: ['Read', 'Write', 'Shell'],
    decisions: [
      'Port ECC memory-persistence into D1, not a parallel client-only store',
      'Stale-replay guard wraps reinjected summary',
    ],
    openThreads: [
      'Wire session_save into Stop hook after merge',
    ],
    summary: 'Building Port 4 warm-restart before compaction.',
    savedAt: '2026-07-22T05:30:00.000Z',
    ...overrides,
  }
}

function stored(overrides: Partial<StoredHandoff> = {}): StoredHandoff {
  const body = buildSessionHandoffDocument(parts())
  return {
    id: 'handoff-1',
    agentId: 'agent-cursor',
    sessionId: 'sess-abc12345',
    projectId: 'proj-1',
    worktree: '/home/mumega/mupot-worktrees/cursor-efed841a',
    branch: 'cursor/task-efed841a',
    reason: 'pre_compact',
    body,
    savedAt: '2026-07-22T05:30:00.000Z',
    ...overrides,
  }
}

function instinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: 'prefer-vitest-first',
    trigger: 'writing tests for a new module',
    confidence: 0.8,
    domain: 'testing',
    scope: 'project',
    action: 'Add a vitest file before wiring MCP.',
    evidence: ['Port 4 TDD'],
    projectId: 'proj-1',
    agentId: null,
    ...overrides,
  }
}

describe('warm-restart handoff', () => {
  it('builds a fine-grain handoff that survives compaction', () => {
    const body = buildSessionHandoffDocument(parts())
    expect(handoffPreservesFineGrain(body)).toBe(true)
    expect(body).toContain('src/memory/warm-restart.ts')
    expect(body).toContain('Stale-replay guard wraps reinjected summary')
    expect(body).toContain('Wire session_save into Stop hook after merge')
    expect(body).toContain('**Reason:** pre_compact')
  })

  it('guards reinjection against stale skill/ARGUMENT replay', () => {
    const body = buildSessionHandoffDocument(parts({
      userMessages: ['/fw-task-new ARGUMENTS=duplicate-me'],
    }))
    const guarded = guardStaleReplay(body)
    expect(guarded).toContain('HISTORICAL REFERENCE ONLY')
    expect(guarded).toContain(STALE_REPLAY_BEGIN)
    expect(guarded).toContain(STALE_REPLAY_END)
    expect(guarded).toContain('STALE-BY-DEFAULT')
    expect(guarded).toContain('/fw-task-new ARGUMENTS=duplicate-me')
    // Idempotent wrap
    expect(guardStaleReplay(guarded)).toBe(guarded)
  })

  it('selects the matching worktree handoff (not a foreign project)', () => {
    const cwd = '/home/mumega/mupot-worktrees/cursor-efed841a'
    const match = selectMatchingHandoff(
      [
        stored({
          id: 'other',
          worktree: '/tmp/other',
          projectId: 'proj-other',
          body: buildSessionHandoffDocument(parts({ worktree: '/tmp/other', projectId: 'proj-other' })),
        }),
        stored({ id: 'mine', worktree: cwd }),
      ],
      { worktree: cwd, projectId: 'proj-1' },
    )
    expect(match?.id).toBe('mine')
  })

  it('post-compaction resume is warm with fine-grain context intact', () => {
    const handoff = stored({ reason: 'pre_compact' })
    const instincts = filterInstinctsForInject(
      [instinct(), instinct({ id: 'low', confidence: 0.4, action: 'skip me' })],
      defaultInstinctInjectOpts(),
    )
    const context = buildWarmResumeContext({
      handoffBody: handoff.body,
      instinctSummary: summarizeInstinctsForInject(instincts),
    })

    expect(context.length).toBeGreaterThan(0)
    expect(context).toContain(STALE_REPLAY_BEGIN)
    expect(handoffPreservesFineGrain(context)).toBe(true)
    expect(context).toContain('src/memory/warm-restart.ts')
    expect(context).toContain('prefer-vitest-first')
    expect(context).not.toContain('skip me')
  })
})

describe('instinct memory', () => {
  it('clamps confidence into the ECC 0.3–0.9 band', () => {
    expect(clampInstinctConfidence(0.1)).toBe(0.3)
    expect(clampInstinctConfidence(1.0)).toBe(0.9)
    expect(clampInstinctConfidence(0.75)).toBe(0.75)
    expect(() => clampInstinctConfidence(Number.NaN)).toThrow(/finite/)
  })

  it('project scope shadows global same-id', () => {
    const resolved = resolveInstinctPrecedence([
      instinct({ scope: 'global', projectId: null, confidence: 0.9, action: 'global action' }),
      instinct({ scope: 'project', projectId: 'proj-1', confidence: 0.7, action: 'project action' }),
    ])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.action).toBe('project action')
  })

  it('promotion gate requires ≥2 projects and avg confidence ≥ 0.8', () => {
    expect(shouldPromoteInstinct([
      instinct({ projectId: 'p1', confidence: 0.85 }),
    ])).toBe(false)
    expect(shouldPromoteInstinct([
      instinct({ projectId: 'p1', confidence: 0.7 }),
      instinct({ projectId: 'p2', confidence: 0.7 }),
    ])).toBe(false)
    expect(shouldPromoteInstinct([
      instinct({ projectId: 'p1', confidence: 0.85 }),
      instinct({ projectId: 'p2', confidence: 0.85 }),
    ])).toBe(true)
  })
})

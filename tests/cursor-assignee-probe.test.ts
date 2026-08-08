import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Assignee probe: lock the cursor-worker trust contract that makes
// probe-assignee tasks safe. Cursor writes + commits in a worktree; the
// driver alone pushes/PRs; verify refuses empty work and requires tsc clean.

const worker = readFileSync('scripts/cursor-worker.py', 'utf8')

describe('cursor assignee probe', () => {
  it('forbids cursor from pushing, opening PRs, merging, or deploying', () => {
    expect(worker).toContain('Do NOT push, do NOT open a PR,')
    expect(worker).toContain('do NOT merge, do NOT deploy')
    expect(worker).toContain('cursor never touches the remote')
  })

  it('requires a real commit plus tsc --noEmit before verify passes', () => {
    expect(worker).toContain('npx tsc --noEmit')
    expect(worker).toContain('no commits — cursor produced no work')
    expect(worker).toContain('cursor must have committed real work + it must compile')
  })

  it('moves completed work to review with a gate_owner, never self-closes', () => {
    expect(worker).toContain("status\": \"review\"")
    expect(worker).toContain('GATE_OWNER')
    expect(worker).toContain('never self-closes a task')
  })
})

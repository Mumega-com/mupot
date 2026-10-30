import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const fixtures: string[] = []
const temporaryRoot = resolve(import.meta.dirname, '../tmp')
const prover = resolve(import.meta.dirname, '../scripts/prove-routine-review-window.mjs')
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=prover-test@example.com',
    '-c', 'user.name=Prover Test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function fixture() {
  mkdirSync(temporaryRoot, { recursive: true })
  const directory = mkdtempSync(resolve(temporaryRoot, 'review-prover-'))
  fixtures.push(directory)
  const primary = resolve(directory, 'primary')
  mkdirSync(resolve(primary, 'scripts'), { recursive: true })
  copyFileSync(prover, resolve(primary, 'scripts/prove-routine-review-window.mjs'))
  git(primary, 'init', '-q')
  git(primary, 'add', '.')
  git(primary, 'commit', '-qm', 'fixture')
  const worktree = resolve(directory, 'review-worktree')
  git(primary, 'worktree', 'add', '--detach', '-q', worktree, 'HEAD')
  return { primary, worktree }
}
const check = (cwd: string) => spawnSync(process.execPath,
  [resolve(cwd, 'scripts/prove-routine-review-window.mjs'), '--check-worktree'], { cwd, encoding: 'utf8' })
afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('review-window prover refuses unsafe checkouts before mutating', () => {
  it('refuses the primary checkout even when clean', () => {
    const { primary } = fixture()
    const result = check(primary)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('dedicated detached worktree')
    expect(git(primary, 'status', '--porcelain')).toBe('')
  })
  it('refuses uncommitted work in a dedicated detached worktree', () => {
    const { worktree } = fixture()
    writeFileSync(resolve(worktree, 'unrelated.txt'), 'preserve this work\n')
    const before = git(worktree, 'status', '--porcelain')
    const result = check(worktree)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('clean tree')
    expect(git(worktree, 'status', '--porcelain')).toBe(before)
  })
  it('accepts a clean dedicated detached worktree for a read-only safety check', () => {
    const { worktree } = fixture()
    const result = check(worktree)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('worktree safety checks passed')
    expect(git(worktree, 'status', '--porcelain')).toBe('')
  })
})

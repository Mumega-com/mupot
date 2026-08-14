// tests/branch-staleness.test.mjs — self-tests for the branch-staleness guard.
//
// The defect this guard exists for (mupot#834) was a CLEAN MERGE that was also a revert, so
// this suite is written against the same standard as the migration-numbering self-tests
// (#729): every case below was reproduced as a MUTATION against
// scripts/check-branch-staleness.mjs before it shipped, and each is here because deleting
// the corresponding line turns it red. A self-test that stays green when you break the thing
// it names certifies the hole rather than closing it.
//
// Two halves:
//   - `evaluate` is pure, so the rules are driven directly with no git at all.
//   - the git-reading half runs the real script against throwaway repos in tmp, because
//     fail-loud-on-unreadable is exactly the branch where a mistake means the guard silently
//     stops guarding, and it cannot be proven any other way.
//
// Hermetic: nothing here touches this repo's git state or origin.
//
// Run: node --test tests/branch-staleness.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate } from '../scripts/check-branch-staleness.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-branch-staleness.mjs')

// ── the rules, driven directly ───────────────────────────────────────────────

test('a modified file that also moved on the target FAILS', () => {
  const v = evaluate(['src/routines/service.ts'], ['src/routines/service.ts'], 244)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'files_moved_under_branch')
  assert.deepEqual(v.detail.contested, ['src/routines/service.ts'])
})

test('a branch far behind that touches nothing contested PASSES', () => {
  // Distance alone must never decide the verdict. If it did, every long-lived branch would
  // fail, everyone would learn to ignore the guard, and it would stop protecting the case it
  // exists for. 244 behind and no overlap is genuinely fine.
  const v = evaluate(['src/brand-new.ts'], ['src/routines/service.ts'], 244)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'no_contested_files')
  assert.equal(v.detail.behind, 244)
})

test('ADDED files are exempt — only modifications can be moved under', () => {
  // The caller passes --diff-filter=M, so additions never reach evaluate(). This pins the
  // contract: a file the target does not have cannot be contested, and failing new-module
  // PRs is how a guard becomes something people route around.
  const v = evaluate([], ['src/routines/service.ts'], 100)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'no_modified_files')
})

test('only the overlap is reported, not every modified file', () => {
  const v = evaluate(
    ['src/types.ts', 'src/mcp/index.ts', 'src/untouched.ts'],
    ['src/types.ts', 'src/mcp/index.ts', 'docs/unrelated.md'],
    12,
  )
  assert.equal(v.ok, false)
  assert.deepEqual(v.detail.contested, ['src/mcp/index.ts', 'src/types.ts'])
})

// ── cannot-verify is not pass, on BOTH sides ─────────────────────────────────

test('unreadable PR file list FAILS rather than passing', () => {
  const v = evaluate(null, ['src/a.ts'], 5)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'pr_files_unreadable')
})

test('unreadable target diff FAILS rather than passing', () => {
  // The sibling guard (check-migration-numbering.mjs) shipped fail-open on exactly one of
  // its two inputs, because the rule was written once and applied to one argument. Both
  // sides get a case here for that reason.
  const v = evaluate(['src/a.ts'], null, 5)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_diff_unreadable')
})

// ── the git-reading half, against real throwaway repos ───────────────────────

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'staleness-'))
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@test.local')
  run('config', 'user.name', 'test')
  mkdirSync(join(dir, 'src'), { recursive: true })
  return { dir, run }
}

function runGuard(dir) {
  try {
    const stdout = execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('END-TO-END: a real branch whose file moved on main is refused', () => {
  const { dir, run } = repo()
  try {
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 1\n')
    run('add', '-A'); run('commit', '-qm', 'base')

    run('checkout', '-qb', 'feature')
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 2 // branch\n')
    run('add', '-A'); run('commit', '-qm', 'branch edit')

    run('checkout', '-q', 'main')
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 3 // main moved on\n')
    run('add', '-A'); run('commit', '-qm', 'main edit')

    // The guard reads origin/main; give the throwaway repo one that points at local main.
    run('update-ref', 'refs/remotes/origin/main', 'main')
    run('checkout', '-q', 'feature')

    const r = runGuard(dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /src\/service\.ts/)
    assert.match(r.out, /rebase/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('END-TO-END: a branch adding a new file while main moves elsewhere passes', () => {
  const { dir, run } = repo()
  try {
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 1\n')
    run('add', '-A'); run('commit', '-qm', 'base')

    run('checkout', '-qb', 'feature')
    writeFileSync(join(dir, 'src/brand-new.ts'), 'export const n = 1\n')
    run('add', '-A'); run('commit', '-qm', 'add new module')

    run('checkout', '-q', 'main')
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 3\n')
    run('add', '-A'); run('commit', '-qm', 'main edit')
    run('update-ref', 'refs/remotes/origin/main', 'main')
    run('checkout', '-q', 'feature')

    const r = runGuard(dir)
    assert.equal(r.code, 0)
    assert.match(r.out, /OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('END-TO-END: a file ADDED on both sides is exempt (proves --diff-filter=M is live)', () => {
  // A mutation probe caught this gap: deleting --diff-filter=M from the script left the
  // whole suite GREEN, because no fixture created the one state that distinguishes it — the
  // SAME path added on both the branch and the target. Without the filter that path appears
  // in both lists and the guard fails a PR it should pass. Fixture SHAPE decides coverage,
  // not fixture presence.
  const { dir, run } = repo()
  try {
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 1\n')
    run('add', '-A'); run('commit', '-qm', 'base')

    run('checkout', '-qb', 'feature')
    writeFileSync(join(dir, 'src/shared-new.ts'), 'export const n = 1 // branch\n')
    run('add', '-A'); run('commit', '-qm', 'branch adds it')

    run('checkout', '-q', 'main')
    writeFileSync(join(dir, 'src/shared-new.ts'), 'export const n = 2 // main\n')
    run('add', '-A'); run('commit', '-qm', 'main adds the same path')
    run('update-ref', 'refs/remotes/origin/main', 'main')
    run('checkout', '-q', 'feature')

    const r = runGuard(dir)
    assert.equal(r.code, 0, 'an ADDED path must not be treated as moved-under')
    assert.match(r.out, /OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('END-TO-END: no origin/main at all is refused, not shrugged off', () => {
  // A shallow clone or a missing base ref. This is the branch where fail-open would mean the
  // guard reports success on every PR in CI and nobody notices for months.
  const { dir, run } = repo()
  try {
    writeFileSync(join(dir, 'src/service.ts'), 'export const v = 1\n')
    run('add', '-A'); run('commit', '-qm', 'base')
    const r = runGuard(dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /merge-base|fetch-depth/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

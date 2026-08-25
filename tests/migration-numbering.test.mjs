// tests/migration-numbering.test.mjs — self-tests for the migration-numbering guard (#729).
//
// The guard this file tests exists because a check that was correct when written decayed
// silently. So this suite is written to catch the same thing happening one level up: every
// case below was reproduced as a MUTATION against scripts/check-migration-numbering.mjs
// before it shipped, and each one is here because deleting the corresponding line in the
// script turns it red. A self-test that stays green when you break the thing it names is
// worse than absent — it certifies the hole (#721, MUT-B).
//
// Two halves:
//   - `evaluate` is pure, so the rules are driven directly with no git at all.
//   - the git-reading half runs the real script against throwaway repos in tmp, because the
//     fail-loud-on-unreadable-target behaviour cannot be proven any other way, and that is
//     the branch where a mistake means the guard quietly stops guarding.
//
// Hermetic: nothing here touches this repo's migrations/ or origin.
//
// Run: node --test tests/migration-numbering.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, migrationNumber } from '../scripts/check-migration-numbering.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'check-migration-numbering.mjs')

// ── filename parsing ───────────────────────────────────────────────────────────────────

test('a well-formed migration name parses to its number', () => {
  assert.equal(migrationNumber('0079_task_priority_and_parent.sql'), 79)
  assert.equal(migrationNumber('0001_init.sql'), 1)
})

test('names that are not exactly four digits do not parse', () => {
  // The anchored regex matters: a loose /^(\d+)/ accepts all three of these and compares
  // them as 7, 760 and 76 — an ordering guard confidently returning a wrong answer.
  assert.equal(migrationNumber('007_short.sql'), null)
  assert.equal(migrationNumber('00760_long.sql'), null)
  assert.equal(migrationNumber('0076-dash.sql'), null)
  assert.equal(migrationNumber('rollback.sql'), null)
})

// ── the rule ───────────────────────────────────────────────────────────────────────────

const TARGET = ['0001_init.sql', '0078_x.sql', '0079_task_priority_and_parent.sql']

test('an added migration above the target head passes', () => {
  const v = evaluate(TARGET, [...TARGET, '0080_new.sql'])
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'above_target_head')
  assert.equal(v.detail.head, 79)
})

test('Flight 3 reserves consecutive 0127 and 0128 strictly above a 0126 target', () => {
  const target = ['0125_mutation_host_control_audit.sql', '0126_decision_requests.sql']
  const local = [
    ...target,
    '0127_runtime_brokers.sql',
    '0128_fenced_deliveries.sql',
  ]
  const v = evaluate(target, local)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'above_target_head')
  assert.equal(v.detail.head, 126)
  assert.deepEqual(v.detail.added, [
    '0127_runtime_brokers.sql',
    '0128_fenced_deliveries.sql',
  ])
})

test('THE PRODUCTION CASE: an added migration at a free slot BELOW the head fails', () => {
  // Slot 0076 is empty on main (it jumps 0075 -> 0077) and four open PRs each claim it.
  // "The slot is free" is the intuition that makes this defect feel safe, and it is exactly
  // wrong: free-but-below-head still never runs.
  const v = evaluate(TARGET, [...TARGET, '0076_identity_cleanup.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'below_target_head')
  assert.equal(v.detail.below[0].number, 76)
})

test('an added migration EQUAL to the head fails (boundary)', () => {
  // <= not <. A file numbered exactly at the head does not run either, and an off-by-one
  // here would let through the single most likely collision — the one written by someone
  // who read the last filename and reused its number.
  const v = evaluate(TARGET, [...TARGET, '0079_other_name.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'below_target_head')
})

test('a PR that adds no migrations passes', () => {
  assert.equal(evaluate(TARGET, TARGET).reason, 'no_migrations_added')
})

test('PRE-EXISTING duplicates on the target are not this PR\'s problem', () => {
  // main really does carry two 0068 files. Failing on inherited debt would make the guard
  // unmergeable on the day it lands, and a guard nobody can merge protects nothing.
  const withDupe = ['0068_a.sql', '0068_b.sql', '0079_x.sql']
  assert.equal(evaluate(withDupe, [...withDupe, '0080_new.sql']).ok, true)
})

test('two added migrations sharing a number fail even when BOTH are above the head', () => {
  // The head rule passes both, so this needs its own check. D1 breaks the tie alphabetically
  // on the rest of the filename — an ordering nobody chose and nothing records.
  const v = evaluate(TARGET, [...TARGET, '0080_a.sql', '0080_b.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'duplicate_number_within_pr')
  assert.equal(v.detail.collisions[0].number, 80)
})

test('an added file with an unparseable name fails', () => {
  const v = evaluate(TARGET, [...TARGET, 'rollback_0080.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'malformed_migration_name')
})

test('an unparseable name already ON THE TARGET is tolerated', () => {
  // Ignored on purpose: refusing to compute a head because of one legacy filename would
  // disengage the guard for every future PR — the failure mode is silence, not noise.
  const messy = ['legacy.sql', '0079_x.sql']
  assert.equal(evaluate(messy, [...messy, '0080_new.sql']).ok, true)
})

test('FAIL CLOSED: an unreadable merge target is a failure, never a pass', () => {
  // The single most important assertion in this file. A shallow clone or a missing base ref
  // means the guard cannot verify anything — and a green check would read as
  // "ordering verified". The schema ratchet learned this the same way.
  const v = evaluate(null, ['0001_init.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_unreadable')
})

test('a target with migrations but NONE parseable fails rather than inventing a head', () => {
  // Math.max of an empty list is -Infinity, and every added file compares above it. That
  // would pass everything while looking like a real comparison.
  const v = evaluate(['legacy.sql'], ['legacy.sql', '0001_init.sql'])
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_has_no_parseable_migrations')
})

test('FAIL CLOSED, LOCAL SIDE: an unlistable working-tree migrations/ is a failure', () => {
  // Found by Prime's bypass review AFTER the target-side fix shipped in c43b35b — the mirror
  // image of that bug, in the mirror-image function. Neither Athena's bypass sweep nor 21
  // self-tests caught it, because everyone including me was looking at the target side.
  //
  // The lesson is not "check localMigrations too". It is that "cannot verify is not pass" was
  // written down once and applied to ONE of the function's two arguments. A rule stated in a
  // comment gets applied where the author was looking.
  const v = evaluate(['0079_x.sql'], null)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'local_unreadable')
})

test('a target with no migrations at all is bootstrap, and passes', () => {
  assert.equal(evaluate([], ['0001_init.sql']).reason, 'bootstrap_no_target_migrations')
})

// ── the git-reading half ───────────────────────────────────────────────────────────────

function scaffold({ targetMigrations, addedMigrations }) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-numbering-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-migration-numbering.mjs'))

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.test')
  git('config', 'user.name', 't')

  for (const name of targetMigrations) {
    writeFileSync(join(dir, 'migrations', name), '-- x\n')
  }
  git('add', '-A')
  git('commit', '-qm', 'target')

  // The script resolves `origin/main`, so give the throwaway repo an origin that points at
  // itself. This is what makes the test exercise the REAL ref-resolution path rather than a
  // stubbed one — the path where a typo means the guard silently stops comparing.
  git('remote', 'add', 'origin', dir)
  git('fetch', '-q', 'origin')

  for (const name of addedMigrations) {
    writeFileSync(join(dir, 'migrations', name), '-- new\n')
  }
  return dir
}

function run(dir, env = {}) {
  try {
    const stdout = execFileSync('node', [join(dir, 'scripts', 'check-migration-numbering.mjs')], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

test('end to end: a migration above the head exits 0', (t) => {
  const dir = scaffold({ targetMigrations: ['0001_init.sql', '0079_x.sql'], addedMigrations: ['0080_new.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
  assert.match(out, /0080_new\.sql/)
})

test('end to end: a migration below the head exits 1 and names the fix', (t) => {
  const dir = scaffold({ targetMigrations: ['0001_init.sql', '0079_x.sql'], addedMigrations: ['0076_dupe.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { code, out } = run(dir)
  assert.equal(code, 1)
  assert.match(out, /0076_dupe\.sql/)
  // The message must carry the next free number. A failure that makes the author go read the
  // directory to find out what to do costs more than the check saves.
  assert.match(out, /0080/)
})

test('end to end: NO origin ref at all exits 1 — the guard fails loud, not open', (t) => {
  // Reproduces the shallow-clone / missing-fetch-depth case in CI. If this ever exits 0, the
  // check is decorative and every PR after it merges unverified with a green tick.
  const dir = mkdtempSync(join(tmpdir(), 'migration-numbering-bare-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-migration-numbering.mjs'))
  writeFileSync(join(dir, 'migrations', '0080_new.sql'), '-- new\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })

  const { code, out } = run(dir)
  assert.equal(code, 1)
  assert.match(out, /fetch-depth/)
})

test('end to end: a ref that genuinely has no migrations/ is bootstrap, and passes', (t) => {
  // The counterpart to the test below. `git ls-tree -r --name-only <ref> migrations/` against
  // a ref with no such path exits 0 with empty stdout — it does NOT throw. That is what makes
  // real bootstrap distinguishable from a git failure, and it is the fact the first version
  // of this guard got backwards.
  const dir = scaffold({ targetMigrations: [], addedMigrations: ['0001_init.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { code, out } = run(dir)
  assert.equal(code, 0, out)
  assert.match(out, /bootstrap/)
})

test('FAIL CLOSED at the GIT layer: ls-tree failing is a failure, not a bootstrap', (t) => {
  // P0 found by Athena's diverse gate on this PR (pin 51aa9b1) — the guard against silent
  // disengagement had one. rev-parse succeeded, ls-tree threw, the catch returned [], and
  // `evaluate` read that as "target has no migrations yet" and PASSED a below-head migration.
  //
  // The pure/impure split is exactly what hid it: `evaluate([], …)` is legitimately a
  // bootstrap pass and its unit test says so, so the only way to catch the mislabelling is
  // to drive the real git layer with git actually broken. A PATH wrapper that fails only
  // ls-tree is the smallest way to stage that.
  const dir = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: ['0076_below.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir).code, 1, 'sanity: below-head must fail with git working')

  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'git'),
    '#!/bin/bash\nif [ "$1" = "ls-tree" ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec /usr/bin/git "$@"\n',
    { mode: 0o755 },
  )
  const { code, out } = run(dir, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(code, 1, 'a git failure must NOT read as bootstrap')
  assert.doesNotMatch(out, /bootstrap/)
})

test('PARTIAL working tree: a COMMITTED below-head migration is still caught when the file is not on disk', (t) => {
  // The fourth defect in this file (Athena's re-gate named the asymmetry; measured immediately
  // after). The local side read the WORKING TREE via readdirSync while the target side read
  // GIT — two oracles for the two halves of one comparison. A total readdir failure was
  // already handled; a PARTIAL tree returns a short list with NO error, so the guard
  // under-reported what the PR adds and called the shortfall "added nothing".
  //
  // This test replaced an earlier one that removed the whole directory and asserted exit 1.
  // That test encoded the WEAKER oracle: with HEAD now authoritative, a repo whose only added
  // file was never committed genuinely has nothing added, and passing is correct. Deleting the
  // old assertion was the right call, not a convenience — the property worth pinning is that a
  // COMMITTED violation survives the file vanishing from disk.
  const dir = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: [] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(join(dir, 'migrations', '0076_committed.sql'), '-- x\n')
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-qm', 'add below-head'], { cwd: dir, stdio: 'ignore' })
  assert.equal(run(dir).code, 1, 'sanity: below-head fails while the file is on disk')

  rmSync(join(dir, 'migrations', '0076_committed.sql'))
  const { code, out } = run(dir)
  assert.equal(code, 1, 'HEAD still contains it — the working tree is not the oracle')
  assert.match(out, /0076_committed\.sql/)
  assert.doesNotMatch(out, /no_migrations_added/)
})

test('an UNCOMMITTED migration is still checked, so the pre-commit warning survives the union', (t) => {
  // The reason the working tree is unioned in rather than dropped: a developer running this
  // before committing must still be warned about a file git has not seen yet.
  const dir = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: ['0076_uncommitted.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { code, out } = run(dir)
  assert.equal(code, 1)
  assert.match(out, /0076_uncommitted\.sql/)
})

test('FAIL CLOSED: only when BOTH local oracles fail is it local_unreadable', (t) => {
  // The union must not become a way to always find *some* answer. With git gone AND the
  // directory gone there is no oracle left, and inventing one is the original sin of this file.
  const dir = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: [] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(join(dir, 'migrations'), { recursive: true, force: true })
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  const { code, out } = run(dir)
  assert.equal(code, 1)
  // Assert the REASON, not just the exit code. Removing .git also makes the TARGET unreadable,
  // so a mutation that deletes the both-null guard still exits 1 — via target_unreadable — and
  // an exit-code-only assertion passes for the wrong reason. Measured: mutation M13 (`if
  // (false) return null`) left the suite 27/27 green until this line existed. The local check
  // runs first, so its message is the discriminator.
  assert.match(out, /Could not list/, 'must fail on the LOCAL oracle, not incidentally on the target')
  assert.doesNotMatch(out, /no_migrations_added/)
})

test('the union returns null, not [], when both local oracles fail', () => {
  // The pure counterpart to the test above, stated at the layer where the distinction is
  // unambiguous. `[]` and `null` are both falsy-ish shapes that flow onward; only one of them
  // means "I could not look". This whole file exists because that difference was collapsed.
  const v = evaluate(['0079_x.sql'], null)
  assert.equal(v.reason, 'local_unreadable')
})

test('end to end: BASE_REF selects a different merge target', (t) => {
  // PRs are not always against main. If BASE_REF were ignored, the guard would compare
  // against the wrong branch and its verdict would be unrelated to what actually merges.
  // No added file yet — it is written only after the release branch exists, or `git add -A`
  // on that branch would commit it there too and it would stop being "added" at all.
  const dir = scaffold({ targetMigrations: ['0001_init.sql', '0079_x.sql'], addedMigrations: [] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  // A release branch that already carries 0080, so the same added file is now a collision.
  git('checkout', '-qb', 'release')
  writeFileSync(join(dir, 'migrations', '0080_taken.sql'), '-- taken\n')
  git('add', '-A')
  git('commit', '-qm', 'release carries 0080')
  git('checkout', '-q', 'main')
  git('fetch', '-q', 'origin')
  writeFileSync(join(dir, 'migrations', '0080_new.sql'), '-- new\n')

  assert.equal(run(dir).code, 0, 'against main, 0080 is free')
  const { code, out } = run(dir, { BASE_REF: 'release' })
  assert.equal(code, 1, 'against release, 0080 is taken')
  assert.match(out, /0080/)
})

// ── repo invariant introduced by this change ───────────────────────────────────────────

test('every tests/*.test.mjs is wired to a node --test step in CI', () => {
  // This change excluded `**/*.test.mjs` from vitest as a class instead of naming each file,
  // because the per-file list had to be appended to every time and the third append is the
  // signal that the rule, not the list, was the thing to write down.
  //
  // That trade opens a hole: a new .test.mjs nobody wires to its own CI step now runs
  // NOWHERE — excluded from vitest, invoked by nothing — and a suite that runs nowhere is
  // indistinguishable from a suite that passes. This assertion is the close. It lives in
  // this file because this file is a node:test suite CI already runs, and because this
  // change is what opened the hole.
  const ci = execFileSync('git', ['show', 'HEAD:.github/workflows/ci.yml'], {
    cwd: join(HERE, '..'), encoding: 'utf8',
  })
  const files = execFileSync('git', ['ls-files', 'tests/*.test.mjs'], {
    cwd: join(HERE, '..'), encoding: 'utf8',
  }).split('\n').filter(Boolean)

  assert.ok(files.length > 0, 'expected to find node:test files under tests/')
  const unwired = files.filter((f) => !ci.includes(f))
  assert.deepEqual(unwired, [], `these node:test suites run nowhere: ${unwired.join(', ')}`)
})

test('STACKED PR: clearing the declared base is not enough — main head still binds', (t) => {
  // PR #398 is the live case (Prime, bypass review of the merged guard): base
  // `codex/project-routines-v025` head 0061, adds 0062, main at 0079. The guard printed
  // "migration numbering OK" while that migration can never run against main — it said
  // "ordering verified" about an ordering that does not exist.
  //
  // Staged synthetically rather than replayed from the real repo: a worktree carrying main's
  // full migration set makes "added vs an old base" meaningless, and my first attempt at
  // reproducing #398 that way produced a confident wrong answer. Build the shape instead.
  const dir = scaffold({ targetMigrations: ['0001_init.sql', '0079_x.sql'], addedMigrations: [] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })

  // An intermediate branch that forked BEFORE main reached 0079 — it only knows up to 0061.
  git('checkout', '-q', '-b', 'stack', 'HEAD')
  rmSync(join(dir, 'migrations', '0079_x.sql'))
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  git('commit', '-qm', 'stack base: no 0079')
  execFileSync('git', ['write-tree'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'migrations', '0061_stack_head.sql'), '-- x\n')
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  git('commit', '-qm', 'stack base head 0061')
  git('checkout', '-q', 'main')
  git('fetch', '-q', 'origin')

  // The PR: adds 0062. Above the stack's head (0061), at-or-below main's (0079).
  writeFileSync(join(dir, 'migrations', '0062_stacked.sql'), '-- x\n')

  const { code, out } = run(dir, { BASE_REF: 'stack' })
  assert.equal(code, 1, '0062 clears the stack head but can never run against main')
  assert.match(out, /0062_stacked\.sql/)
  // The message must say WHICH constraint bound, or the author rebases onto the wrong thing.
  assert.match(out, /origin\/main/)
})

test('EVERY green message names the ref it actually compared against', (t) => {
  // The overstatement half of the same finding. "migration numbering OK" with no ref reads as
  // "verified", full stop — which is exactly how #398 passed review.
  //
  // Both green paths, not one. The first version of this test covered only `above_target_head`,
  // and a mutation stripping the ref from the OTHER message (`no_migrations_added`) left the
  // suite 25/25 green. A test that pins one branch of a two-branch claim is the shape this
  // whole file exists to reject.
  const withAdd = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: ['0080_new.sql'] })
  t.after(() => rmSync(withAdd, { recursive: true, force: true }))
  const a = run(withAdd)
  assert.equal(a.code, 0, a.out)
  assert.match(a.out, /origin\/main/, 'above_target_head message must name the ref')

  const noAdd = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: [] })
  t.after(() => rmSync(noAdd, { recursive: true, force: true }))
  const b = run(noAdd)
  assert.equal(b.code, 0, b.out)
  assert.match(b.out, /origin\/main/, 'no_migrations_added message must name the ref too')
})

test('end to end: a malformed BASE_REF is refused, not resolved', (t) => {
  // BASE_REF comes from github.base_ref, which the PR author influences. It never reaches a
  // shell (every git call passes an argument array), but an unexpected value should be a
  // loud refusal rather than a ref that quietly resolves to something nobody intended.
  const dir = scaffold({ targetMigrations: ['0079_x.sql'], addedMigrations: ['0080_new.sql'] })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const bad of ['main;rm -rf /', '../../etc/passwd', 'a b']) {
    const { code, out } = run(dir, { BASE_REF: bad })
    assert.equal(code, 1, `${bad} must be refused`)
    assert.match(out, /not a plausible branch name/)
  }
})

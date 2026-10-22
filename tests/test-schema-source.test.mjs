// tests/test-schema-source.test.mjs — self-tests for the test-schema-source ratchet.
//
// Every case below was REPRODUCED as a mutation against a version of
// scripts/check-test-schema-source.mjs during review, on 2026-08-06. They are not
// hypotheticals; each exists so that specific hole stays shut.
//
// The gate that guards the tests had no tests of its own. That is the shape it exists to
// reject, so it should not have been exempt from it — and the exemption was not free: the
// `mockDb` class below was found by an adversarial gate on someone else's PR (#719), not by
// this gate, four days after it shipped.
//
// Hermetic: `classify` is pure, and the two git-backed pins are exercised against a real
// throwaway repo built in tmp. Nothing here touches the actual tests/ tree or origin.
//
// Run: node --test tests/test-schema-source.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from '../scripts/check-test-schema-source.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'check-test-schema-source.mjs')

const IMPORTS = `import { thing } from '../src/agents/messages'\n`

// ── the detector ───────────────────────────────────────────────────────────────────────

test('a test with a real engine and hand-written DDL is class `files`', () => {
  assert.equal(
    classify(IMPORTS + `const h = createSqliteD1()\nh.sqlite.exec('CREATE TABLE t (id TEXT)')`),
    'files',
  )
})

test('a test with a real engine that pins individual migration files is class `files`', () => {
  assert.equal(classify(IMPORTS + `read('migrations/0001_init.sql')\nDatabaseSync`), 'files')
})

test('the sanctioned path — applyAllMigrations — is not a violation', () => {
  assert.equal(
    classify(IMPORTS + `const h = createSqliteD1()\napplyAllMigrations(h.sqlite)`),
    null,
  )
})

test('MOCK D1: an object supplying prepare(), with NO sql engine, is class `mockDb`', () => {
  // #719's exact shape: D1 re-implemented as a JS object that string-matches SQL. This
  // passed the gate cleanly before #720 — it writes no DDL, so the original rule was blind.
  assert.equal(
    classify(IMPORTS + `const db = { prepare(sql) { return { bind: () => ({}) } } }`),
    'mockDb',
  )
})

test('MOCK D1 is also caught when prepare is a property rather than a method', () => {
  assert.equal(classify(IMPORTS + `const db = { prepare: (sql) => makeStmt(sql) }`), 'mockDb')
})

test('a real-engine test is NOT mockDb, even though it calls db.prepare()', () => {
  // The classes are ordered, not overlapping: REAL_ENGINE is decided first. Getting this
  // wrong would file every real-schema test under mockDb and make the new class meaningless.
  assert.equal(
    classify(IMPORTS + `const h = createSqliteD1()\napplyAllMigrations(h.sqlite)\nh.db.prepare('SELECT 1')`),
    null,
  )
})

test('a test that does not import production code is out of scope entirely', () => {
  // Migration-behaviour tests legitimately construct historical schemas.
  assert.equal(classify(`const db = { prepare(sql) {} }\nCREATE TABLE t (id TEXT)`), null)
})

// ── the git-backed pins ────────────────────────────────────────────────────────────────

/** A throwaway repo with a committed `main`, so the ratchet has a real merge target. */
function scaffold({ baseline, targetBaseline, extraTest }) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-ratchet-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'tests', 'helpers'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-test-schema-source.mjs'))

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.test')
  git('config', 'user.name', 't')

  // TWO pre-existing violators, both present on the target — legitimate baseline material.
  // Two, not one, so a non-growth test can grow the baseline using a file that EXISTS on the
  // target. With only new files available, the smuggled-new-file pin catches everything and
  // the non-growth pin is never the thing under test: disabling it outright left this suite
  // 15/15 green (mutation MUT-B, 2026-08-06). A guard against guards passing for the wrong
  // reason, which passed for the wrong reason.
  for (const name of ['legacy.test.ts', 'legacy2.test.ts']) {
    writeFileSync(join(dir, 'tests', name), IMPORTS + `const db = { prepare(sql) { return {} } }`)
  }
  writeFileSync(
    join(dir, 'scripts', 'test-schema-source-baseline.json'),
    JSON.stringify(targetBaseline, null, 2),
  )
  git('add', '-A')
  git('commit', '-qm', 'base')
  // The ratchet reads `origin/main`; a self-remote makes that resolvable with no network.
  git('remote', 'add', 'origin', dir)
  git('fetch', '-q', 'origin')

  // Now the PR's state, uncommitted — exactly how CI sees a branch.
  if (extraTest) writeFileSync(join(dir, 'tests', extraTest.name), extraTest.body)
  writeFileSync(
    join(dir, 'scripts', 'test-schema-source-baseline.json'),
    JSON.stringify(baseline, null, 2),
  )
  return dir
}

function run(dir) {
  try {
    const stdout = execFileSync('node', [join(dir, 'scripts', 'check-test-schema-source.mjs')], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const BOTH = ['tests/legacy.test.ts', 'tests/legacy2.test.ts']

test('a pre-existing violator that is baselined passes', (t) => {
  const dir = scaffold({
    targetBaseline: { files: [], mockDb: BOTH },
    baseline: { files: [], mockDb: BOTH },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir).code, 0)
})

test('a NEW violator that is not baselined fails, and is named', (t) => {
  const dir = scaffold({
    targetBaseline: { files: [], mockDb: BOTH },
    baseline: { files: [], mockDb: BOTH },
    extraTest: { name: 'fresh.test.ts', body: IMPORTS + `const db = { prepare(sql) {} }` },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /fresh\.test\.ts/)
})

test('THE BYPASS: adding the new violator to the baseline still fails', (t) => {
  // The whole point of a ratchet. Enforced by comparing against the target's baseline,
  // which is not in the PR.
  const dir = scaffold({
    targetBaseline: { files: [], mockDb: BOTH },
    baseline: { files: [], mockDb: [...BOTH, 'tests/fresh.test.ts'] },
    extraTest: { name: 'fresh.test.ts', body: IMPORTS + `const db = { prepare(sql) {} }` },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir).code, 1)
})

test('NON-GROWTH IS LOAD-BEARING: growing the baseline with a PRE-EXISTING file fails', (t) => {
  // Isolates the non-growth pin from the smuggled-new-file pin. `legacy2` exists on the
  // target and genuinely violates, so nothing else can object to it — only the fact that
  // the list went 1 -> 2. Disabling the pin turns this test red and only this test.
  const dir = scaffold({
    targetBaseline: { files: [], mockDb: ['tests/legacy.test.ts'] },
    baseline: { files: [], mockDb: BOTH },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /BASELINE \[mockDb\] GREW: 1 -> 2/)
})

test('THE SEEDING BYPASS: a new violator cannot ride in while a class is being seeded', (t) => {
  // Mutation M2, 2026-08-06 — this exited 0 before the fix. While a class is absent from the
  // target there is no number to compare against, so the non-growth pin is inert and a
  // brand-new violator is indistinguishable from legitimate pre-existing debt. Closed by
  // requiring every baselined file to exist ON THE TARGET: a file this PR introduced is by
  // definition not pre-existing.
  const dir = scaffold({
    targetBaseline: { files: [] }, // mockDb absent -> seeding
    baseline: { files: [], mockDb: [...BOTH, 'tests/fresh.test.ts'] },
    extraTest: { name: 'fresh.test.ts', body: IMPORTS + `const db = { prepare(sql) {} }` },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /BASELINED FILE IS NEW/)
  assert.match(r.out, /fresh\.test\.ts/)
})

test('seeding a class with genuinely pre-existing debt is allowed exactly once', (t) => {
  const dir = scaffold({
    targetBaseline: { files: [] },
    baseline: { files: [], mockDb: BOTH },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 0)
  assert.match(r.out, /seeding/)
})

test('CLASSES ARE INDEPENDENT: shrinking one must not license growing the other', (t) => {
  // A single summed count passes this: files 1 -> 0, mockDb 1 -> 2, total unchanged. Both
  // mockDb entries exist on the target and genuinely violate, so the per-class comparison
  // is the only thing that can object.
  const dir = scaffold({
    targetBaseline: { files: ['tests/legacy.test.ts'], mockDb: ['tests/legacy.test.ts'] },
    baseline: { files: [], mockDb: BOTH },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /BASELINE \[mockDb\] GREW/)
})

test('a baselined file that was FIXED is reported stale, not silently retained', (t) => {
  const dir = scaffold({
    targetBaseline: { files: [], mockDb: [...BOTH, 'tests/gone.test.ts'] },
    baseline: { files: [], mockDb: [...BOTH, 'tests/gone.test.ts'] },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /STALE BASELINE/)
  assert.match(r.out, /gone\.test\.ts/)
})

test('an unreadable merge target FAILS rather than passing quietly', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'schema-ratchet-nogit-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-test-schema-source.mjs'))
  writeFileSync(
    join(dir, 'scripts', 'test-schema-source-baseline.json'),
    JSON.stringify({ files: [], mockDb: [] }),
  )
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /CANNOT VERIFY THE RATCHET/)
})

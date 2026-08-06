#!/usr/bin/env node
// scripts/check-test-schema-source.mjs — a test that imports production code must build
// its schema from the committed migration chain.
//
// WHY THIS EXISTS
//
// mupot#684 shipped a query naming `member_tokens.capability`, a column that does not
// exist. Twelve tests passed against it, because the DB double never executed the SQL.
// The fix was a real-schema test. The FOLLOW-ON problem is that a real SQL engine is not
// enough: a test can execute genuine SQL against a schema it invented, and then it looks
// like the strong kind of test while proving nothing about production.
//
// Two shapes of that, both measured live in this repo:
//
//   1. HAND-WRITTEN `CREATE TABLE` in the test. The fixture is the author's belief about
//      the schema. #684 would have reproduced identically — the invented column would
//      simply have been typed into the fixture too.
//
//   2. A HAND-PICKED LIST of migration files. Subtler and worse: correct on the day it is
//      written, and it rots every time a migration lands with nobody making a mistake.
//      Measured across the 14 tests that did this, 13 had already drifted — `agents` short
//      15 columns (including `capabilities`), `tasks` short 10, `projects` short 4.
//
// THIS IS NOT A HYPOTHETICAL TAX. On 2026-08-05, adding two nullable columns to `tasks`
// (migrations/0079) broke FOUR test files. None of them caught a bug. Each had a fixture
// that lied about the schema and blocked a feature. That is the cost this guard exists to
// stop paying.
//
// THE RULE
//
//   A test that imports production code must build its schema with applyAllMigrations().
//
// Structural and self-declaring. The two legitimate exemptions fall out of it rather than
// being listed: a migration-behaviour test (which must construct a historical state, and
// imports no src/) and the harness itself.
//
// ON THE BASELINE — a position I changed, stated rather than buried
//
// I originally claimed this rule needed NO allowlist. With 26 pre-existing violations a
// hard gate cannot land, and shipping nothing is worse than shipping a ratchet. So there
// is a baseline, and it is honest about what it is:
//
//   - it can only SHRINK. Removing a file is a normal PR; adding one fails the check.
//   - the count is PRINTED on every run, so it cannot quietly grow.
//   - a baselined file that has since been fixed is ALSO an error, so the list cannot rot
//     into a permanent exemption for files that no longer need it.
//
// A list that can only shrink and announces its own size is a ratchet. A list anyone can
// append to is an exemption, and exemptions are how #684 happened.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'test-schema-source-baseline.json')

// TWO violating classes, TWO baselines, each shrink-only and each compared independently.
//
//   files   — real SQL engine, hand-built schema (the original rule, #703/#711)
//   mockDb  — no SQL engine at all: a D1-shaped object literal that string-matches SQL
//
// Independent because a summed count lets one class grow while the other shrinks, which is
// the non-growth pin defeating itself. (#720, found by the adversarial gate on #719.)
const CLASSES = ['files', 'mockDb']
const baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const baselines = Object.fromEntries(
  CLASSES.map((c) => [c, new Set(baselineFile[c] ?? [])]),
)

/**
 * MECHANICAL NON-GROWTH PIN.
 *
 * The first version claimed "the baseline may only shrink" and did not enforce it: adding a
 * new violator AND appending it to the baseline exited 0. The ratchet was a promise in a
 * comment — a named property that was false, which is the entire class this guard exists
 * to stop. (Athena, gate on #711.)
 *
 * Enforced by comparing against the baseline on the MERGE TARGET, not against a number
 * committed next to the list it is supposed to constrain. A PR cannot grow the list,
 * because the thing it is measured against is not in the PR.
 *
 * Returns null when the target ref is unavailable (a shallow clone, a detached build, a
 * fresh worktree). That is a real limitation and it FAILS LOUD rather than passing quietly
 * — see the exit logic. A ratchet that silently disengages when it cannot read git is the
 * same defect one level down.
 */
function baselineSizeOnTarget() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'

  // Distinguish THREE cases, because collapsing them is how a ratchet quietly disengages:
  //   git unreadable           -> cannot verify -> FAIL (shallow clone, missing base ref)
  //   ref readable, no file    -> bootstrap     -> allow, and say so
  //   ref readable, file there -> compare
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: ROOT, stdio: 'ignore',
    })
  } catch {
    return { state: 'unreadable' }
  }

  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/test-schema-source-baseline.json`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    // Per class, and ABSENT is distinguished from EMPTY:
    //   key missing on target -> that class did not exist yet -> bootstrap, seed it once
    //   key present (even [])  -> constrained, may only shrink
    //
    // The seeding path is not a bypass, and does not need to be trusted: deleting a class
    // key from the baseline to "re-seed" it makes every file in that class a NEW offender
    // in the very same run, because the in-PR baseline for it is empty. The escape hatch
    // fails closed on use.
    return {
      state: 'compared',
      sizes: Object.fromEntries(
        CLASSES.map((c) => [c, Array.isArray(parsed[c]) ? parsed[c].length : null]),
      ),
    }
  } catch {
    return { state: 'bootstrap' }
  }
}

/**
 * Files that exist on the merge target, or null if it cannot be read.
 *
 * WHY: the non-growth pin is INERT while a class is being seeded (there is no number on the
 * target to compare against), so during that one PR a brand-new violator can ride in
 * alongside the legitimate pre-existing debt and be indistinguishable from it. Measured, not
 * theorised: mutation M2 on this very change appended a new violating test to the seeding
 * list and the check exited 0.
 *
 * The fix is definitional. A baseline records PRE-EXISTING debt, and pre-existing means
 * "already on the merge target". A file introduced by this PR cannot be pre-existing, so it
 * can never be baselined — during seeding or otherwise.
 */
function targetFileSet() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'tests/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(raw.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    // .mjs/.js too: the first version walked only .ts, so a violator written as .mjs was
    // invisible to the scanner entirely.
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) out.push(full)
  }
  return out
}

// Imports anything under src/ — i.e. exercises production code, as opposed to testing a
// migration file's own behaviour (which legitimately builds a historical schema).
// Quote-agnostic and covers dynamic import(): the first version matched single quotes after
// `from ` only, so `from "../src/x"` and `await import('../src/x')` both slipped past.
const IMPORTS_PRODUCTION = /(?:from|import\s*\()\s*['"`](?:\.\.\/)+src\//
// Builds a schema by hand: names individual migration files, or writes DDL inline.
// Whitespace-tolerant so `CREATE\n TABLE` and `migrations /0001_x.sql` still match. String
// CONCATENATION ('CREA' + 'TE TABLE') defeats any regex and is NOT claimed to be caught —
// see the honesty note at the bottom of this file.
const PINS_MIGRATIONS = /migrations\s*\/\s*\d{4}_[a-z0-9_]+\.sql/
const HAND_WRITTEN_DDL = /CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE/i
// A REAL SQL engine — the thing that makes a schema mismatch actually throw.
const REAL_ENGINE = /createSqliteD1|DatabaseSync/
// A D1-shaped object literal: something supplying `prepare` as a property or method, i.e.
// a hand-written stand-in for env.DB. Real-engine files also call `db.prepare(...)`, so
// this is only consulted AFTER REAL_ENGINE has been ruled out.
const MOCK_D1 = /\bprepare\s*[:(]/
// The sanctioned path.
const USES_HELPER = /applyAllMigrations\s*\(/

/**
 * Which violating class does this file fall into, if any? Returns null when the rule does
 * not apply.
 *
 * Kept as ONE function evaluated for EVERY file, rather than a set of `continue` guards in
 * the scan loop. The first version filtered first and checked baseline staleness second,
 * so a baselined file that stopped matching a pre-filter — stopped importing src/, stopped
 * using the harness, or was deleted — was never evaluated at all and sat in the list
 * forever. The ratchet silently became an exemption. Caught by mutating a baselined file
 * to be compliant and finding the check still passed.
 *
 * THE mockDb CLASS (#720). The original rule bound hand-written DDL — it did not see a
 * test that never builds a schema at all because it never executes SQL. Found on #719:
 * tests/inbox-routes.test.ts re-implements D1 as a JS object that string-matches SQL, and
 * passed this gate cleanly while doing precisely what the gate exists to prevent. A fake
 * answers whatever the test expects, so #684's defect — a query naming a column that does
 * not exist — is not merely undetected but UNDETECTABLE: there is nothing to contradict it.
 * That is a strictly worse position than a hand-written schema, which at least executes.
 */
export function classify(source) {
  if (!IMPORTS_PRODUCTION.test(source)) return null
  if (USES_HELPER.test(source)) return null
  if (REAL_ENGINE.test(source)) {
    return PINS_MIGRATIONS.test(source) || HAND_WRITTEN_DDL.test(source) ? 'files' : null
  }
  return MOCK_D1.test(source) ? 'mockDb' : null
}

// Importing this module (the self-tests do, to exercise `classify` directly) must not run
// the scan or call process.exit. Only direct execution does.
const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  const offenders = { files: [], mockDb: [] }
  const violating = { files: new Set(), mockDb: new Set() }

  for (const file of walk(TESTS_DIR)) {
    const rel = relative(ROOT, file)
    const cls = classify(readFileSync(file, 'utf8'))
    if (!cls) continue
    violating[cls].add(rel)
    if (!baselines[cls].has(rel)) offenders[cls].push(rel)
  }

  // Evaluated over the BASELINE, not over the scan — so a listed file that was fixed,
  // renamed, or deleted is reported rather than silently retained. A file that MOVED between
  // classes is stale in its old class and a new offender in its new one, which is correct:
  // converting a mock to a hand-written schema is not progress and must not pass silently.
  const staleBaseline = Object.fromEntries(
    CLASSES.map((c) => [c, [...baselines[c]].filter((rel) => !violating[c].has(rel)).sort()]),
  )

  const target = baselineSizeOnTarget()
  const label = { files: 'building schema by hand', mockDb: 'faking D1 instead of executing SQL' }
  for (const c of CLASSES) {
    const remaining = baselines[c].size - staleBaseline[c].length
    const note =
      target.state === 'compared' && target.sizes[c] !== null ? `, target ${target.sizes[c]}`
      : target.state === 'compared' ? ', target none (new class, seeding)'
      : target.state === 'bootstrap' ? ', target none (bootstrap)'
      : ''
    console.log(
      `test-schema-source [${c}]: ${remaining} file(s) ${label[c]} ` +
      `(baseline ${baselines[c].size}${note}).`,
    )
  }

  let failed = false

  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.')
    console.error('Failing rather than passing: a ratchet that disengages when it cannot read')
    console.error('git is exactly the silent-exemption defect it exists to prevent.\n')
  } else if (target.state === 'compared') {
    for (const c of CLASSES) {
      // null = the class did not exist on the target; seeding it once is allowed (see
      // baselineSizeOnTarget). Every later run compares against a real number.
      if (target.sizes[c] !== null && baselines[c].size > target.sizes[c]) {
        failed = true
        console.error(`\nBASELINE [${c}] GREW: ${target.sizes[c]} -> ${baselines[c].size}. It may only shrink.`)
        console.error('Appending a file here is not a fix. Convert the test to applyAllMigrations()')
        console.error('and remove its entry instead.\n')
      }
    }
  }

  const WHY = {
    files: [
      'A hand-written CREATE TABLE or a hand-picked list of migration files is a',
      'schema you invented. It executes real SQL against a database production does',
      'not have, which is why it looks like a strong test while proving nothing.',
    ],
    mockDb: [
      'A hand-written object supplying prepare() is a SQL ENGINE you invented. It does',
      'not execute the query at all — it string-matches it and answers what the test',
      'expects, so a query naming a column that does not exist cannot be contradicted.',
      'That is strictly weaker than a hand-written schema, which at least runs.',
    ],
  }

  for (const c of CLASSES) {
    if (offenders[c].length === 0) continue
    failed = true
    console.error(`\nNEW VIOLATION [${c}] — a test that imports production code must execute real`)
    console.error('SQL against a schema built with applyAllMigrations() from tests/helpers/migrations.ts:\n')
    for (const f of offenders[c]) console.error(`  ${f}`)
    console.error('')
    for (const line of WHY[c]) console.error(line)
    console.error('The baseline is a ratchet: it may shrink, never grow.\n')
  }

  // A baselined file that does not exist on the merge target was introduced by this PR, and
  // therefore is not pre-existing debt. Blocks the seeding-window bypass (mutation M2).
  const onTarget = targetFileSet()
  if (onTarget !== null) {
    for (const c of CLASSES) {
      const smuggled = [...baselines[c]].filter((rel) => !onTarget.has(rel)).sort()
      if (smuggled.length === 0) continue
      failed = true
      console.error(`\nBASELINED FILE IS NEW [${c}] — these are not on the merge target, so they`)
      console.error('are not pre-existing debt and cannot be baselined:\n')
      for (const f of smuggled) console.error(`  ${f}`)
      console.error('\nA baseline records debt that already existed. Write the new test against')
      console.error('createSqliteD1() + applyAllMigrations() instead.\n')
    }
  }

  for (const c of CLASSES) {
    if (staleBaseline[c].length === 0) continue
    failed = true
    console.error(`\nSTALE BASELINE [${c}] — these files no longer violate and must be removed from`)
    console.error(`${relative(ROOT, BASELINE_PATH)}:\n`)
    for (const f of staleBaseline[c]) console.error(`  ${f}`)
    console.error('\nLeaving a fixed file in the baseline turns a ratchet into an exemption.\n')
  }

  // WHAT THIS DOES NOT CATCH — stated rather than implied.
  //
  // The scanner is regex over source. String concatenation defeats it: 'CREA' + 'TE TABLE',
  // or a migration path assembled at runtime, will pass. That is not fixable with a regex,
  // and pretending otherwise would make this exactly the kind of confidently-wrong guard it
  // exists to replace.
  //
  // It is not the load-bearing part. The scanner catches ACCIDENTAL drift — the way all 27
  // current entries arrived, and the way four more surfaces silently diverged in #713. The
  // RATCHET is what makes deliberate growth impossible, and it does not depend on regex at
  // all: it compares the committed list against the list on the merge target, so the number
  // cannot go up no matter how a violator is written.
  //
  // A determined author can still evade the scanner. They cannot evade the count.

  process.exit(failed ? 1 : 0)
  }

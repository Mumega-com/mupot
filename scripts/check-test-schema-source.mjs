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
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'test-schema-source-baseline.json')

/** Files that build a schema by hand and still import production code. Only ever shrinks. */
const baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files)

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
    return { state: 'compared', size: JSON.parse(raw).files.length }
  } catch {
    return { state: 'bootstrap' }
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
// The sanctioned path.
const USES_HELPER = /applyAllMigrations\s*\(/

/**
 * Does this file violate the rule? Returns false for files the rule does not apply to.
 *
 * Kept as ONE function evaluated for EVERY file, rather than a set of `continue` guards in
 * the scan loop. The first version filtered first and checked baseline staleness second,
 * so a baselined file that stopped matching a pre-filter — stopped importing src/, stopped
 * using the harness, or was deleted — was never evaluated at all and sat in the list
 * forever. The ratchet silently became an exemption. Caught by mutating a baselined file
 * to be compliant and finding the check still passed.
 */
function violates(source) {
  if (!/createSqliteD1|DatabaseSync/.test(source)) return false
  if (!IMPORTS_PRODUCTION.test(source)) return false
  if (USES_HELPER.test(source)) return false
  return PINS_MIGRATIONS.test(source) || HAND_WRITTEN_DDL.test(source)
}

const offenders = []
const violating = new Set()

for (const file of walk(TESTS_DIR)) {
  const rel = relative(ROOT, file)
  if (!violates(readFileSync(file, 'utf8'))) continue
  violating.add(rel)
  if (!baseline.has(rel)) offenders.push(rel)
}

// Evaluated over the BASELINE, not over the scan — so a listed file that was fixed,
// renamed, or deleted is reported rather than silently retained.
const staleBaseline = [...baseline].filter((rel) => !violating.has(rel)).sort()

const remaining = baseline.size - staleBaseline.length
const target = baselineSizeOnTarget()
const targetNote =
  target.state === 'compared' ? `, target ${target.size}`
  : target.state === 'bootstrap' ? ', target none (bootstrap)'
  : ''
console.log(
  `test-schema-source: ${remaining} file(s) still building schema by hand ` +
  `(baseline ${baseline.size}${targetNote}).`,
)

let failed = false

if (target.state === 'unreadable') {
  failed = true
  console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
  console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.')
  console.error('Failing rather than passing: a ratchet that disengages when it cannot read')
  console.error('git is exactly the silent-exemption defect it exists to prevent.\n')
} else if (target.state === 'compared' && baseline.size > target.size) {
  failed = true
  console.error(`\nBASELINE GREW: ${target.size} -> ${baseline.size}. It may only shrink.`)
  console.error('Appending a file here is not a fix. Convert the test to applyAllMigrations()')
  console.error('and remove its entry instead.\n')
}

if (offenders.length > 0) {
  failed = true
  console.error('\nNEW VIOLATION — a test that imports production code must build its schema')
  console.error('with applyAllMigrations() from tests/helpers/migrations.ts:\n')
  for (const f of offenders) console.error(`  ${f}`)
  console.error('\nA hand-written CREATE TABLE or a hand-picked list of migration files is a')
  console.error('schema you invented. It executes real SQL against a database production does')
  console.error('not have, which is why it looks like a strong test while proving nothing.')
  console.error('The baseline is a ratchet: it may shrink, never grow.\n')
}

if (staleBaseline.length > 0) {
  failed = true
  console.error('\nSTALE BASELINE — these files no longer violate and must be removed from')
  console.error(`${relative(ROOT, BASELINE_PATH)}:\n`)
  for (const f of staleBaseline) console.error(`  ${f}`)
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

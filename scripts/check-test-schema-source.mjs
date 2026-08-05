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
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'test-schema-source-baseline.json')

/** Files that build a schema by hand and still import production code. Only ever shrinks. */
const baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

// Imports anything under src/ — i.e. exercises production code, as opposed to testing a
// migration file's own behaviour (which legitimately builds a historical schema).
const IMPORTS_PRODUCTION = /from '(\.\.\/)+src\//
// Builds a schema by hand: names individual migration files, or writes DDL inline.
const PINS_MIGRATIONS = /migrations\/\d{4}_[a-z0-9_]+\.sql/
const HAND_WRITTEN_DDL = /CREATE\s+TABLE/i
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
console.log(`test-schema-source: ${remaining} file(s) still building schema by hand (baseline ${baseline.size}).`)

let failed = false

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

process.exit(failed ? 1 : 0)

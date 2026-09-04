// tests/check-mcp-tool-seam.test.mjs — self-tests for the mcp-tool-seam ratchet.
//
// Modeled directly on tests/test-schema-source.test.mjs: a gate that guards the tests must
// have tests of its own, or it is the exact shape mupot#1290 exists to reject — a lane can be
// dead in production while the tests exercising it stay green.
//
// Two halves, like the model:
//   1. `scanSource` unit tests — the detector itself, driven with synthetic source read from
//      tests/fixtures/mcp-tool-seam/*.txt. Proves the taint-propagation shapes (direct
//      import, `.find()`-derived variable, for-of loop variable, type-annotated parameter)
//      are all caught, and that D1/Workflow/vitest `.run()` calls are NOT false-positived.
//   2. The git-backed ratchet pins — a throwaway repo with a committed `main`, so the
//      non-growth / smuggled-file / stale-baseline mechanics have a real merge target to be
//      tested against, exactly like test-schema-source.test.mjs's scaffold()/run().
//
// WHY THE FIXTURES LIVE IN .txt FILES, NOT INLINE TEMPLATE LITERALS: this file's own job is
// to synthesize source that LOOKS LIKE a test importing '../src/mcp/...' and calling
// prepare()/.run() — which is exactly the textual shape scripts/check-test-schema-source.mjs
// scans for. That guard classifies by regex over a file's raw text, not by AST, so an inline
// fixture like `import { TOOLS } from '../src/mcp/index'` sitting in THIS file's own source
// trips its mockDb detector even though it's test data, not a real import (found in CI on
// this very file, PR #1291). The fix is not a token trick (splitting strings, a decoy
// `applyAllMigrations(` to short-circuit its classify()) — that is exactly the false-signal
// class both ratchets exist to reject. Externalizing the fixture bodies to .txt is the real
// fix: check-test-schema-source.mjs's own walk() only scans .ts/.tsx/.mjs/.cjs/.js
// (scripts/check-test-schema-source.mjs:161), so a .txt fixture is invisible to it by
// construction, not by incidental token luck.
//
// Run: node --test tests/check-mcp-tool-seam.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSource } from '../scripts/check-mcp-tool-seam.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'check-mcp-tool-seam.mjs')
const FIXTURES_DIR = join(HERE, 'fixtures', 'mcp-tool-seam')

/** Read a fixture source body by filename. Kept as one helper so every fixture read goes
 * through the same, obviously-inert path (no string concatenation, no partial reads). */
function fixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

// ── the detector ───────────────────────────────────────────────────────────────────────

test('a directly-imported tool identifier calling .run() is a violation', () => {
  const { violations } = scanSource('x.test.ts', fixture('direct-import-violation.txt'))
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 2)
})

test('a variable derived via TOOLS.find() is tainted and its .run() is a violation', () => {
  // The exact shape of mupot#1289's original defect and tests/agent-messages.test.ts today:
  // the tool object is never itself imported, only looked up from an imported registry.
  const { violations } = scanSource('x.test.ts', fixture('tools-find-derived-violation.txt'))
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('a for-of loop variable over an imported registry is tainted', () => {
  // tests/provision-tools.test.ts's actual shape: `for (const tool of PROVISION_TOOLS)`.
  const { violations } = scanSource('x.test.ts', fixture('provision-tools-loop-violation.txt'))
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('an array literal spreading an imported registry is tainted', () => {
  // provision-tools.test.ts's regression-simulation shape: a local array that spreads a
  // seam-imported registry plus a locally-defined extra tool.
  const { violations } = scanSource('x.test.ts', fixture('array-spread-loop-violation.txt'))
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 4)
})

test('a parameter typed with an imported ToolSpec is tainted even though never imported by name', () => {
  // provision-tools.test.ts's isGuarded(tool: ToolSpec, env: Env) — `tool` is a bare
  // parameter, caught only because its TYPE annotation names an import from src/mcp.
  const { violations } = scanSource('x.test.ts', fixture('toolspec-typed-param-violation.txt'))
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('going through invokeTool is the sanctioned path and is not a violation', () => {
  const { violations } = scanSource('x.test.ts', fixture('invoke-tool-sanctioned.txt'))
  assert.equal(violations.length, 0)
})

test('inspecting TOOLS metadata without calling .run() is not a violation', () => {
  // The common, legitimate shape: dozens of test files do `TOOLS.find(...).min` /
  // `.inputSchema` / `.name` and never touch `.run()` at all.
  const { violations } = scanSource('x.test.ts', fixture('tools-metadata-inspection-only.txt'))
  assert.equal(violations.length, 0)
})

test('db.prepare(...).run() is NOT flagged', () => {
  const { violations } = scanSource('x.test.ts', fixture('d1-prepare-run-noise.txt'))
  assert.equal(violations.length, 0)
})

test('a plain statement variable calling .run() is NOT flagged (no seam import in scope)', () => {
  const { violations } = scanSource('x.test.ts', fixture('plain-statement-run-noise.txt'))
  assert.equal(violations.length, 0)
})

test('a Workflow-shaped .run() is NOT flagged even in a file that also imports the seam', () => {
  const { violations } = scanSource('x.test.ts', fixture('workflow-run-noise.txt'))
  assert.equal(violations.length, 0)
})

test('a file with no src/mcp import is out of scope entirely', () => {
  const { violations } = scanSource('x.test.ts', fixture('object-mock-prepare-run-noise.txt'))
  assert.equal(violations.length, 0)
})

test('a same-line seam-exempt comment exempts the call and is reported, not silently dropped', () => {
  const { violations, exemptions } = scanSource('x.test.ts', fixture('seam-exempt-same-line.txt'))
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 1)
  assert.equal(exemptions[0].line, 2)
  assert.match(exemptions[0].reason, /harness has no invokeTool shim yet/)
})

test('a line-above seam-exempt comment also exempts the call and is reported', () => {
  const { violations, exemptions } = scanSource('x.test.ts', fixture('seam-exempt-line-above.txt'))
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 1)
  assert.equal(exemptions[0].line, 3)
  assert.match(exemptions[0].reason, /migration-behaviour test/)
})

test('a module path containing "mcpwp" is not mistaken for the src/mcp seam', () => {
  const { violations } = scanSource('x.test.ts', fixture('mcpwp-false-positive.txt'))
  assert.equal(violations.length, 0)
})

// ── the git-backed pins ────────────────────────────────────────────────────────────────

/** A throwaway repo with a committed `main`, so the ratchet has a real merge target. */
function scaffold({ baseline, targetBaseline, extraTest }) {
  const dir = mkdtempSync(join(tmpdir(), 'seam-ratchet-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  mkdirSync(join(dir, 'src', 'mcp'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-mcp-tool-seam.mjs'))
  symlinkSync(join(HERE, '..', 'node_modules'), join(dir, 'node_modules'), 'dir')

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.test')
  git('config', 'user.name', 't')

  const VIOLATING_BODY = fixture('violating-body-scaffold.txt')

  // TWO pre-existing violators, both present on the target — legitimate baseline material.
  // Two, so the non-growth pin can be isolated from the smuggled-new-file pin (see
  // test-schema-source.test.mjs's scaffold() for why one is not enough).
  for (const name of ['legacy.test.ts', 'legacy2.test.ts']) {
    writeFileSync(join(dir, 'tests', name), VIOLATING_BODY)
  }
  writeFileSync(
    join(dir, 'scripts', 'mcp-tool-seam-baseline.json'),
    JSON.stringify(targetBaseline, null, 2),
  )
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('remote', 'add', 'origin', dir)
  git('fetch', '-q', 'origin')

  if (extraTest) writeFileSync(join(dir, 'tests', extraTest.name), extraTest.body ?? VIOLATING_BODY)
  writeFileSync(
    join(dir, 'scripts', 'mcp-tool-seam-baseline.json'),
    JSON.stringify(baseline, null, 2),
  )
  return dir
}

function run(dir) {
  try {
    const stdout = execFileSync('node', [join(dir, 'scripts', 'check-mcp-tool-seam.mjs')], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const BOTH = ['tests/legacy.test.ts', 'tests/legacy2.test.ts']

test('a pre-existing violator that is baselined passes', (t) => {
  const dir = scaffold({ targetBaseline: { files: BOTH }, baseline: { files: BOTH } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir).code, 0)
})

test('a NEW violator that is not baselined fails, and is named', (t) => {
  const dir = scaffold({
    targetBaseline: { files: BOTH },
    baseline: { files: BOTH },
    extraTest: { name: 'fresh.test.ts' },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /fresh\.test\.ts/)
})

test('THE BYPASS: adding the new violator to the baseline still fails', (t) => {
  const dir = scaffold({
    targetBaseline: { files: BOTH },
    baseline: { files: [...BOTH, 'tests/fresh.test.ts'] },
    extraTest: { name: 'fresh.test.ts' },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir).code, 1)
})

test('NON-GROWTH IS LOAD-BEARING: growing the baseline with a PRE-EXISTING file fails', (t) => {
  const dir = scaffold({
    targetBaseline: { files: ['tests/legacy.test.ts'] },
    baseline: { files: BOTH },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /BASELINE \[files\] GREW: 1 -> 2/)
})

test('THE SEEDING BYPASS: a new violator cannot ride in while the class is being seeded', (t) => {
  const dir = scaffold({
    targetBaseline: {}, // 'files' key absent entirely -> seeding
    baseline: { files: [...BOTH, 'tests/fresh.test.ts'] },
    extraTest: { name: 'fresh.test.ts' },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /BASELINED FILE IS NEW/)
  assert.match(r.out, /fresh\.test\.ts/)
})

test('seeding with genuinely pre-existing debt is allowed exactly once', (t) => {
  // The target's baseline file exists (readable) but has no `files` key yet — the class
  // itself is new, not the file. Distinguished from a wholly-unreadable target ("bootstrap",
  // covered below) by the "new class, seeding" note, which is inert in the same way: there
  // is no number on the target for this class to compare against yet.
  const dir = scaffold({ targetBaseline: {}, baseline: { files: BOTH } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 0)
  assert.match(r.out, /new class, seeding/)
})

test('a baselined file that was FIXED (removed .run() call) is reported stale, not silently retained', (t) => {
  const dir = scaffold({
    targetBaseline: { files: [...BOTH, 'tests/gone.test.ts'] },
    baseline: { files: [...BOTH, 'tests/gone.test.ts'] },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 'tests/gone.test.ts' is baselined but does not exist in the working tree at all — the
  // scan finds nothing violating in it, which must be treated the same as "fixed", not
  // silently retained.
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /STALE BASELINE/)
  assert.match(r.out, /gone\.test\.ts/)
})

test('a baselined file that stopped violating (rewritten to use invokeTool) is reported stale', (t) => {
  const dir = scaffold({
    targetBaseline: { files: BOTH },
    baseline: { files: BOTH },
  })
  // Overwrite legacy2 in the working tree with a fixed version, AFTER the base commit — this
  // is "the file rots" as check-test-schema-source.mjs's classify()-evaluated-per-file
  // comment describes: a baselined file that stopped matching must not sit in the list
  // forever.
  writeFileSync(join(dir, 'tests', 'legacy2.test.ts'), fixture('fixed-invoketool-body.txt'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /STALE BASELINE/)
  assert.match(r.out, /legacy2\.test\.ts/)
})

test('a seam-exempt call in a baselined file is printed as an exemption, not silently absorbed', (t) => {
  const dir = scaffold({ targetBaseline: { files: BOTH }, baseline: { files: BOTH } })
  writeFileSync(join(dir, 'tests', 'exempted.test.ts'), fixture('exempted-seam-file.txt'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 0)
  assert.match(r.out, /exempted\.test\.ts:2 — sanctioned probe/)
})

test('an unreadable merge target FAILS rather than passing quietly', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-ratchet-nogit-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'scripts', 'check-mcp-tool-seam.mjs'))
  symlinkSync(join(HERE, '..', 'node_modules'), join(dir, 'node_modules'), 'dir')
  writeFileSync(join(dir, 'scripts', 'mcp-tool-seam-baseline.json'), JSON.stringify({ files: [] }))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /CANNOT VERIFY THE RATCHET/)
})

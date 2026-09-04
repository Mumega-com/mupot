// tests/check-mcp-tool-seam.test.mjs — self-tests for the mcp-tool-seam ratchet.
//
// Modeled directly on tests/test-schema-source.test.mjs: a gate that guards the tests must
// have tests of its own, or it is the exact shape mupot#1290 exists to reject — a lane can be
// dead in production while the tests exercising it stay green.
//
// Two halves, like the model:
//   1. `scanSource` unit tests — the detector itself, driven with synthetic source. Proves
//      the taint-propagation shapes (direct import, `.find()`-derived variable, for-of loop
//      variable, type-annotated parameter) are all caught, and that D1/Workflow/vitest
//      `.run()` calls are NOT false-positived.
//   2. The git-backed ratchet pins — a throwaway repo with a committed `main`, so the
//      non-growth / smuggled-file / stale-baseline mechanics have a real merge target to be
//      tested against, exactly like test-schema-source.test.mjs's scaffold()/run().
//
// Run: node --test tests/check-mcp-tool-seam.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSource } from '../scripts/check-mcp-tool-seam.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'check-mcp-tool-seam.mjs')

// ── the detector ───────────────────────────────────────────────────────────────────────

test('a directly-imported tool identifier calling .run() is a violation', () => {
  const src = `import { toolPotProvision } from '../src/mcp/pots'\n` +
    `const outcome = await toolPotProvision.run(auth, env, {}, ctx)\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 2)
})

test('a variable derived via TOOLS.find() is tainted and its .run() is a violation', () => {
  // The exact shape of mupot#1289's original defect and tests/agent-messages.test.ts today:
  // the tool object is never itself imported, only looked up from an imported registry.
  const src = `import { TOOLS } from '../src/mcp/index'\n` +
    `const toolSend = TOOLS.find((t) => t.name === 'send')!\n` +
    `const r = await toolSend.run(auth, env, {}, ctx)\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('a for-of loop variable over an imported registry is tainted', () => {
  // tests/provision-tools.test.ts's actual shape: `for (const tool of PROVISION_TOOLS)`.
  const src = `import { PROVISION_TOOLS } from '../src/mcp/provision'\n` +
    `for (const tool of PROVISION_TOOLS) {\n` +
    `  await tool.run(auth, env, {}, ctx)\n` +
    `}\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('an array literal spreading an imported registry is tainted', () => {
  // provision-tools.test.ts's regression-simulation shape: a local array that spreads a
  // seam-imported registry plus a locally-defined extra tool.
  const src = `import { PROVISION_TOOLS } from '../src/mcp/provision'\n` +
    `const registryWithRegression = [...PROVISION_TOOLS, forgotTheGuard]\n` +
    `for (const tool of registryWithRegression) {\n` +
    `  await tool.run(auth, env, {}, ctx)\n` +
    `}\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 4)
})

test('a parameter typed with an imported ToolSpec is tainted even though never imported by name', () => {
  // provision-tools.test.ts's isGuarded(tool: ToolSpec, env: Env) — `tool` is a bare
  // parameter, caught only because its TYPE annotation names an import from src/mcp.
  const src = `import type { ToolSpec } from '../src/mcp'\n` +
    `async function isGuarded(tool: ToolSpec, env) {\n` +
    `  const outcome = await tool.run(auth, env, {}, ctx)\n` +
    `  return outcome.ok === false\n` +
    `}\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 3)
})

test('going through invokeTool is the sanctioned path and is not a violation', () => {
  const src = `import { invokeTool } from '../src/mcp/index'\n` +
    `const out = await invokeTool(auth, env, 'send', { to: 'x', body: 'hi' }, ctx)\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('inspecting TOOLS metadata without calling .run() is not a violation', () => {
  // The common, legitimate shape: dozens of test files do `TOOLS.find(...).min` /
  // `.inputSchema` / `.name` and never touch `.run()` at all.
  const src = `import { TOOLS } from '../src/mcp/index'\n` +
    `for (const t of TOOLS) {\n` +
    `  expect(VALID_MIN.has(t.min)).toBe(true)\n` +
    `}\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('db.prepare(...).run() is NOT flagged', () => {
  const src = `import { TOOLS } from '../src/mcp/index'\n` +
    `await env.DB.prepare('DELETE FROM agents WHERE id = ?').bind(id).run()\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('a plain statement variable calling .run() is NOT flagged (no seam import in scope)', () => {
  const src = `const stmt = harness.sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?')\n` +
    `stmt.run('done', id)\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('a Workflow-shaped .run() is NOT flagged even in a file that also imports the seam', () => {
  const src = `import { TOOLS } from '../src/mcp/index'\n` +
    `const instance = await env.MY_WORKFLOW.create()\n` +
    `await workflow.run(payload)\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('a file with no src/mcp import is out of scope entirely', () => {
  const src = `const db = { prepare: () => ({ run: () => ({}) }) }\n` + `db.prepare().run()\n`
  const { violations } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
})

test('a same-line seam-exempt comment exempts the call and is reported, not silently dropped', () => {
  const src = `import { toolPotProvision } from '../src/mcp/pots'\n` +
    `const outcome = await toolPotProvision.run(auth, env, {}, ctx) // seam-exempt: harness has no invokeTool shim yet\n`
  const { violations, exemptions } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 1)
  assert.equal(exemptions[0].line, 2)
  assert.match(exemptions[0].reason, /harness has no invokeTool shim yet/)
})

test('a line-above seam-exempt comment also exempts the call and is reported', () => {
  const src = `import { toolPotProvision } from '../src/mcp/pots'\n` +
    `// seam-exempt: migration-behaviour test, no auth context available\n` +
    `const outcome = await toolPotProvision.run(auth, env, {}, ctx)\n`
  const { violations, exemptions } = scanSource('x.test.ts', src)
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 1)
  assert.equal(exemptions[0].line, 3)
  assert.match(exemptions[0].reason, /migration-behaviour test/)
})

test('a module path containing "mcpwp" is not mistaken for the src/mcp seam', () => {
  const src = `import { toolThing } from '../src/mcpwp/tools'\n` +
    `await toolThing.run(auth, env, {}, ctx)\n`
  const { violations } = scanSource('x.test.ts', src)
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

  const VIOLATING_BODY =
    `import { TOOLS } from '../src/mcp/index'\n` +
    `const t = TOOLS.find((x) => x.name === 'send')!\n` +
    `t.run(auth, env, {}, ctx)\n`

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
  writeFileSync(
    join(dir, 'tests', 'legacy2.test.ts'),
    `import { invokeTool } from '../src/mcp/index'\n` +
      `await invokeTool(auth, env, 'send', {}, ctx)\n`,
  )
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /STALE BASELINE/)
  assert.match(r.out, /legacy2\.test\.ts/)
})

test('a seam-exempt call in a baselined file is printed as an exemption, not silently absorbed', (t) => {
  const dir = scaffold({ targetBaseline: { files: BOTH }, baseline: { files: BOTH } })
  writeFileSync(
    join(dir, 'tests', 'exempted.test.ts'),
    `import { toolPotProvision } from '../src/mcp/pots'\n` +
      `await toolPotProvision.run(auth, env, {}, ctx) // seam-exempt: sanctioned probe\n`,
  )
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

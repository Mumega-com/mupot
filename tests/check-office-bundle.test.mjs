// tests/check-office-bundle.test.mjs — subprocess tests for scripts/check-office-bundle.mjs as a CLI.
// Hermetic: temp dirs only. Run: node --test tests/check-office-bundle.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(here, '..', 'scripts')
const SCRIPT = join(SCRIPTS, 'check-office-bundle.mjs')

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}
function withTmp(fn) {
  const d = mkdtempSync(join(tmpdir(), 'office-bundle-'))
  try { return fn(d) } finally { rmSync(d, { recursive: true, force: true }) }
}
function bundle(dir, files) {
  for (const [name, text] of Object.entries({ 'index.js': 'export default {}', 'index.js.map': '{}', ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
}

test('bundle CLI: a clean bundle exits 0', () => withTmp((d) => {
  bundle(d, { 'README.md': 'picomatch vite mentioned in docs is ignored' })
  assert.equal(run(SCRIPT, [d]).status, 0)
}))
test('bundle CLI: picomatch in index.js exits 1', () => withTmp((d) => {
  bundle(d, { 'index.js': 'import picomatch from "picomatch"' })
  const r = run(SCRIPT, [d]); assert.equal(r.status, 1); assert.match(r.stderr, /index\.js contains "picomatch"/)
}))
test('bundle CLI: picomatch only in index.js.map exits 1', () => withTmp((d) => {
  bundle(d, { 'index.js.map': '{"sources":["node_modules/picomatch/index.js"]}' })
  const r = run(SCRIPT, [d]); assert.equal(r.status, 1); assert.match(r.stderr, /index\.js\.map contains/)
}))
test('bundle CLI: a planted chunks/a.js is scanned recursively', () => withTmp((d) => {
  bundle(d, { 'chunks/a.js': 'require("picomatch")' })
  const r = run(SCRIPT, [d]); assert.equal(r.status, 1); assert.match(r.stderr, /chunks.a\.js contains/)
}))
test('bundle CLI: empty outdir, missing outdir, missing map, missing arg all exit 1', () => withTmp((d) => {
  assert.equal(run(SCRIPT, [d]).status, 1)
  assert.equal(run(SCRIPT, [join(d, 'nope')]).status, 1)
  assert.equal(run(SCRIPT, []).status, 1)
  writeFileSync(join(d, 'index.js'), 'x')
  const r = run(SCRIPT, [d]); assert.equal(r.status, 1); assert.match(r.stderr, /index\.js\.map not found/)
}))

// Entry guard must not fail open: a symlinked path or a path with a space must still RUN
// (proved by a bad input exiting 1; a skipped main would exit 0).
for (const name of ['check-office-bundle.mjs', 'audit-gate.mjs']) {
  test(`entry guard: ${name} runs through a symlink`, () => withTmp((d) => {
    const link = join(d, 'link.mjs'); symlinkSync(join(SCRIPTS, name), link)
    assert.equal(run(link, ['--bogus-arg', join(d, 'missing')]).status, 1)
  }))
  test(`entry guard: ${name} runs from a path with a space`, () => withTmp((d) => {
    const sp = join(d, 'a b'); mkdirSync(sp)
    for (const f of [name, 'lockfile-paths.mjs']) copyFileSync(join(SCRIPTS, f), join(sp, f))
    assert.equal(run(join(sp, name), ['--bogus-arg', join(d, 'missing')]).status, 1)
  }))
}

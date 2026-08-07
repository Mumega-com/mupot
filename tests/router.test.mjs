// tests/router.test.mjs — self-tests for the task router's routing rules.
//
// Every case here is one of Athena's BLOCK findings on PR #759, reproduced as a test so
// it stays shut. Two of the three were things I had MEASURED and then not guarded — the
// dry run showed ~40 GitHub PR-mirror tasks routing to the build lane, I wrote that in
// the PR body as evidence the dry run works, and left `--apply` able to do exactly that.
// Observing a misroute is not preventing one.
//
// The router itself is Python; these tests drive it as a subprocess through a tiny
// harness that feeds one task and prints the verdict, so the tests exercise the REAL
// route() rather than a JS reimplementation of it. A reimplementation would test my
// belief about the rules, which is the thing under suspicion.
//
// Run: node --test tests/router.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(HERE, '..', 'scripts', 'router.py')

/** Ask the real router where one task would go. Returns { lane, why }. */
function route(title, body = '') {
  const py = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("router", ${JSON.stringify(ROUTER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
lane, why = m.route({"title": ${JSON.stringify(title)}, "body": ${JSON.stringify(body)}})
print(json.dumps({"lane": lane, "why": why}))
`
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' })
  return JSON.parse(out.trim().split('\n').pop())
}

// ── Athena BLOCK 1: GitHub PR mirrors must never route ────────────────────────

test('a GitHub PR mirror is never routed to a lane', () => {
  // The measured case: 76 of 89 unassigned tasks were these, and the first dry run
  // would have sent ~40 to the build lane. Note the title contains 'fix' — under the
  // old rules that alone bought it a tech-grok assignment.
  const r = route('[GH Mumega-com/mupot] PR #446 opened: fix(marketing): query shape')
  assert.equal(r.lane, null)
  assert.match(r.why, /mirror/i)
})

test('every mirror ACTION shape is caught, not just "opened"', () => {
  // opened/merged/closed/synchronize/edited all appear on the live board.
  for (const action of ['opened', 'merged', 'closed', 'synchronize', 'edited']) {
    const r = route(`[GH Mumega-com/mupot] PR #123 ${action}: feat(scripts): worker test`)
    assert.equal(r.lane, null, `${action} must not route`)
  }
})

test('a REAL task that merely mentions a PR still routes', () => {
  // The guard is anchored to the mirror's exact title shape. If it were a loose
  // "contains [GH" it would swallow genuine work that references a PR, which trades
  // one silent misroute for another.
  const r = route('Fix the migration guard so PR #398 cannot evade it')
  assert.equal(r.lane, 'tech-grok')
})

// ── Athena BLOCK 2: substring keyword false positives ─────────────────────────

test('"ci" does not match inside "circuit"', () => {
  // `k in text` voted tech-grok for anything containing 'circuit'. Every one of these
  // was a confident wrong answer, which is the expensive kind: the task gets picked up
  // and worked by the wrong lane.
  const r = route('Render the workflow circuit graph on the dashboard')
  assert.notEqual(r.why, undefined)
  assert.ok(!/\bci\b/.test(JSON.stringify(r.why)), `'ci' should not have matched: ${r.why}`)
})

test('"fix" does not match inside "Prefix"', () => {
  const r = route('Prefix every metric key with the tenant slug')
  assert.ok(!(r.lane === 'tech-grok' && /fix/.test(r.why) && !/\bfix\b/.test('Prefix')),
    `'fix' matched inside 'Prefix': ${r.why}`)
})

test('"page" does not drag unrelated prose to the WordPress lane', () => {
  const r = route('Paginate the audit log query')
  assert.notEqual(r.lane, 'mumcp')
})

test('a genuine whole-word match still routes', () => {
  // The boundary fix must not break real matches — the failure mode of over-tightening
  // is a router that routes nothing and looks safe while being useless.
  assert.equal(route('Fix the failing CI build').lane, 'tech-grok')
  assert.equal(route('Update the WordPress page template').lane, 'mumcp')
  assert.equal(route('Audit the docs for stale endpoints').lane, 'prime')
})

// ── unchanged rules, pinned so a later edit cannot quietly drop them ──────────

test('human-only signals are never delegated', () => {
  for (const t of ['Decide the pricing tier', 'Rotate the admin token', 'Deploy to production']) {
    assert.equal(route(t).lane, null, `${t} must stay with a human`)
  }
})

test('an ambiguous tie is refused rather than coin-flipped', () => {
  // Athena confirmed this direction is right: UNROUTED is a useful answer, a guess is not.
  const r = route('Audit the WordPress page and fix the docs')
  assert.equal(r.lane, null)
  assert.match(r.why, /ambiguous/i)
})

test('no signal at all is reported as needing a human, not routed', () => {
  const r = route('Talk to Gavin about the thing')
  assert.equal(r.lane, null)
  assert.match(r.why, /no lane keyword|human/i)
})

// tests/check-bare-squad-id-authz.test.mjs — self-tests for the bare-squad-id-authz ratchet
// (scripts/check-bare-squad-id-authz.mjs).
//
// A gate that guards the codebase must have tests of its own — same discipline as
// tests/check-mcp-tool-seam.test.mjs / tests/test-schema-source.test.mjs. This suite drives
// `scanSource` directly with synthetic source, proving:
//   1. A plain, unsuppressed call to a gated function is NOT flagged (the common case —
//      the typechecker alone enforces SquadScope there).
//   2. A `@ts-ignore`/`@ts-expect-error` immediately above OR on the same line as a gated
//      call IS flagged.
//   3. An `as SquadScope` / `as any` cast on the call line IS flagged.
//   4. A `// bare-squad-id-exempt: <reason>` comment turns a would-be violation into a
//      reported exemption instead, and the reason is preserved.
//   5. A function name that merely CONTAINS a gated name as a substring
//      (`hasCapabilityOnDynamicScope`, `sharedCanOnSquad`) is NOT a false positive — the
//      dynamic-dispatch helper is the sanctioned escape hatch for genuinely scope-agnostic
//      callers, and must never itself be flagged as evidence of suppression.
//   6. An unrelated `.run(` / suppressed-but-irrelevant call (e.g. a D1 statement) is not
//      flagged just because a suppression comment happens to sit nearby a DIFFERENT line.
//
// This suite is intentionally lighter than check-mcp-tool-seam's (no git-scaffold
// ratchet-mechanics tests for baseline growth/staleness/smuggled-files) — this checker's
// detector is a straightforward per-line text scan, not an AST taint-propagation, so the
// git-backed ratchet plumbing it shares with the seam checker is unit-tested by inspection
// (identical to check-test-schema-source.mjs's own mechanism, already covered there) rather
// than re-proven end-to-end here.
//
// Run: node --test tests/check-bare-squad-id-authz.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource } from '../scripts/check-bare-squad-id-authz.mjs'

test('plain unsuppressed gated call is not flagged', () => {
  const src = `
export function check(grants, scope) {
  return hasCapability(grants, 'squad', scope, 'member')
}
`
  const { violations, exemptions } = scanSource(src)
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 0)
})

test('@ts-expect-error on the line above a gated call is flagged', () => {
  const src = `
export function check(grants, squadId) {
  // @ts-expect-error forcing a bare id through
  return hasCapability(grants, 'squad', squadId, 'member')
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 1)
  assert.match(violations[0].snippet, /hasCapability/)
})

test('@ts-ignore on the same line as a gated call is flagged', () => {
  const src = `
export function check(grants, squadId) {
  return hasCapability(grants, 'squad', squadId, 'member') // @ts-ignore
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 1)
})

test('an `as SquadScope` cast on the call line is flagged', () => {
  const src = `
export async function check(env, grants, squadId) {
  return canOnSquad(env, grants, squadId as SquadScope, 'admin')
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 1)
  assert.match(violations[0].snippet, /canOnSquad/)
})

test('an `as any` cast on the call line is flagged', () => {
  const src = `
export async function check(env, grants, squadId) {
  return canOnSquadAuth(env, grants, squadId as any, 'admin')
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 1)
})

test('bare-squad-id-exempt comment turns a violation into a reported exemption', () => {
  const src = `
export async function check(env, grants, squadId) {
  // @ts-expect-error bare-squad-id-exempt: legacy shim removed in a follow-up, tracked in mupot#9999
  return hasCapability(grants, 'squad', squadId, 'member')
}
`
  const { violations, exemptions } = scanSource(src)
  assert.equal(violations.length, 0)
  assert.equal(exemptions.length, 1)
  assert.match(exemptions[0].reason, /mupot#9999/)
})

test('hasCapabilityOnDynamicScope (the sanctioned dynamic-dispatch helper) is never flagged', () => {
  const src = `
export async function check(env, grants, scopeType, scopeId) {
  // @ts-expect-error unrelated suppression on a DIFFERENT line below this comment
  const x = 1
  return hasCapabilityOnDynamicScope(env, grants, scopeType, scopeId, 'admin')
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 0)
})

test('a local alias like sharedCanOnSquad is not conflated with canOnSquad', () => {
  const src = `
const canOnSquad = sharedCanOnSquad // @ts-ignore unrelated note on this exact line
`
  const { violations } = scanSource(src)
  // 'canOnSquad' the bare identifier (const NAME) is not itself a CALL — GATE_CALL_RE
  // requires a following '(' — so this const-alias line must not be flagged.
  assert.equal(violations.length, 0)
})

test('a suppression comment near, but not on/above, a gated call line does not flag it', () => {
  const src = `
export function unrelated() {
  // @ts-expect-error something else entirely
  const y: number = 'oops'
}

export function check(grants, scope) {
  return hasCapability(grants, 'squad', scope, 'member')
}
`
  const { violations } = scanSource(src)
  assert.equal(violations.length, 0)
})

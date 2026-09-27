// tests/check-member-email-authority-lookup.test.mjs — self-tests for the
// member-email-authority-lookup ratchet (scripts/check-member-email-authority-lookup.mjs,
// mupot#1578).
//
// A gate that guards the codebase must have tests of its own — same discipline as
// tests/check-bare-squad-id-authz.test.mjs / tests/check-mcp-tool-seam.test.mjs. This suite
// drives `scanSource` directly with synthetic source, proving:
//   1. The exact defect shape (a bare `FROM members ... WHERE email = ...` / `WHERE
//      lower(email) = ...`) IS flagged, single-line and split across a `WHERE` on the next
//      line (the real shape every site in this codebase uses).
//   2. A `FROM members ... WHERE id = ...` lookup (keyed on id, never email) is NOT flagged,
//      even when the SELECT list itself happens to include an `email` column.
//   3. An UNRELATED query's own `WHERE ... email` clause sitting on the same line as, but
//      textually BEFORE, a `FROM members` reference does not leak into that reference's own
//      window (the exact false positive this checker's own doc-comment first tripped in this
//      PR, before it was fixed to slice from the `FROM members` match onward).
//   4. `email != ?` (a case-collision guard's second predicate) is flagged too, not just
//      `email = ?` — the class is "email decides which row", not one exact operator.
//
// This suite is intentionally lighter than check-mcp-tool-seam's (no git-scaffold
// ratchet-mechanics tests for allowlist growth/staleness/smuggled-files) — this checker's
// detector is a straightforward per-line text scan with a small lookahead, not an AST
// taint-propagation, so the git-backed allowlist plumbing it shares with the other file-list
// ratchets is unit-tested by inspection (identical mechanism to
// check-bare-squad-id-authz.mjs, already covered there) rather than re-proven end-to-end.
//
// Run: node --test tests/check-member-email-authority-lookup.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource } from '../scripts/check-member-email-authority-lookup.mjs'

test('single-line raw email match against members is flagged', () => {
  const src = `
async function memberIdFor(env, auth) {
  const member = await env.DB.prepare(
    "SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'",
  ).bind(auth.email, env.TENANT_SLUG).first()
  return member?.id ?? null
}
`
  const { length } = scanSource(src)
  assert.equal(length, 1)
})

test('lower(email) split across the next line is flagged', () => {
  const src = `
  const rows = await env.DB.prepare(
    \`SELECT id, status FROM members
      WHERE lower(email) = ?1 AND tenant = ?2\`,
  ).bind(email, tenant).all()
`
  const violations = scanSource(src)
  assert.equal(violations.length, 1)
  assert.match(violations[0].snippet, /FROM members/)
})

test('email != ? (a case-collision guard) is flagged too', () => {
  const src = `
  const caseDifferentMember = await c.env.DB.prepare(
    'SELECT id FROM members WHERE lower(email) = ? AND email != ? LIMIT 1',
  ).bind(normalizedEmail, trimmedRawEmail).first()
`
  assert.equal(scanSource(src).length, 1)
})

test('a members lookup keyed on id, not email, is NOT flagged', () => {
  const src = `
  const row = await env.DB.prepare(
    'SELECT id, email, display_name FROM members WHERE id = ?1 AND status = \\'active\\' LIMIT 1',
  ).bind(memberId).first()
`
  assert.equal(scanSource(src).length, 0)
})

test('an unrelated WHERE clause before FROM members on the same line does not leak in', () => {
  // The exact shape this checker's own doc-comment first mis-flagged: an outer query's
  // WHERE (on `users`) appears textually BEFORE an inner "FROM members WHERE id = ..."
  // subquery that has nothing to do with email at all.
  const src = `
  const row = \`OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = (SELECT lower(email) FROM members WHERE id = \${idParam}) AND u.role = 'owner')\`
`
  assert.equal(scanSource(src).length, 0)
})

test('the resolver module itself is exempt via the canonical-file list, not scanSource', () => {
  // scanSource has no file-path awareness — it flags this shape wherever it appears.
  // Canonical-file exemption is main()'s job (CANONICAL_FILES), verified by inspection:
  // src/members/exclusive-control.ts and src/members/resolve-human-member.ts both contain
  // this exact shape and are hardcoded exempt in scripts/check-member-email-authority-lookup.mjs.
  const src = `
    \`SELECT id, status, telegram_chat_id FROM members
      WHERE lower(email) = ?1 AND tenant = ?2\`,
`
  assert.equal(scanSource(src).length, 1)
})

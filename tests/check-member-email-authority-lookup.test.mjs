// tests/check-member-email-authority-lookup.test.mjs — self-tests for the
// member-email-authority-lookup ratchet (scripts/check-member-email-authority-lookup.mjs,
// mupot#1578, hardened mupot#1583 round 1 P1).
//
// A gate that guards the codebase must have tests of its own — same discipline as
// tests/check-bare-squad-id-authz.test.mjs / tests/check-mcp-tool-seam.test.mjs. This suite
// drives `scanSource` and `loadAllowlist` directly with synthetic source, proving each
// evasion shape a round-1 adversarial gate found live on this same PR is now caught, that
// the two false positives found while hardening the detector are now fixed, and that a
// corrupt/missing allowlist is a hard failure rather than a silent bootstrap.
//
// Run: node --test tests/check-member-email-authority-lookup.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSource, loadAllowlist } from '../scripts/check-member-email-authority-lookup.mjs'

// ── scanSource: the shapes round 1 already caught ──────────────────────────────────────

test('single-line raw email match against members is flagged', () => {
  const src = `
async function memberIdFor(env, auth) {
  const member = await env.DB.prepare(
    "SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'",
  ).bind(auth.email, env.TENANT_SLUG).first()
  return member?.id ?? null
}
`
  assert.equal(scanSource(src).length, 1)
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

// ── scanSource: shapes a round-1 adversarial gate found live but round 1 missed ────────

test('email != ? (a case-collision guard) is flagged too', () => {
  const src = `
  const caseDifferentMember = await c.env.DB.prepare(
    'SELECT id FROM members WHERE lower(email) = ? AND email != ? LIMIT 1',
  ).bind(normalizedEmail, trimmedRawEmail).first()
`
  assert.equal(scanSource(src).length, 1)
})

test('an alias-qualified email column (m.email) is flagged', () => {
  const src = `
  const row = await env.DB.prepare(
    "SELECT id FROM members m WHERE lower(m.email) = ?1 LIMIT 1",
  ).bind(email).first()
`
  assert.equal(scanSource(src).length, 1)
})

test('email IN (...) is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE email IN (?, ?)\").bind(a, b).all()"
  assert.equal(scanSource(src).length, 1)
})

test('email LIKE ? is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE email LIKE ?\").bind(pattern).all()"
  assert.equal(scanSource(src).length, 1)
})

test('email IS NULL is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE email IS NULL\").all()"
  assert.equal(scanSource(src).length, 1)
})

test('email COLLATE NOCASE = ? is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE email COLLATE NOCASE = ?\").bind(email).first()"
  assert.equal(scanSource(src).length, 1)
})

test('the operator on the LEFT of email (? = email) is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE ? = email\").bind(email).first()"
  assert.equal(scanSource(src).length, 1)
})

test('email wrapped in instr(...) is flagged', () => {
  const src = "await env.DB.prepare(\"SELECT id FROM members WHERE instr(lower(email), ?) > 0\").bind(needle).all()"
  assert.equal(scanSource(src).length, 1)
})

test('string literals concatenated with + on ONE line are flagged (adjacent-literal evasion)', () => {
  const src = "const sql = 'SELECT id FROM ' + 'members ' + 'WHERE lower(email) = ?'"
  assert.equal(scanSource(src).length, 1)
})

test('string literals concatenated with + ACROSS lines are flagged (the exact evasion shape a round-1 gate could have used)', () => {
  const src = `
const sql =
  'SELECT id FROM ' +
  'members ' +
  'WHERE lower(email) = ?'
`
  assert.equal(scanSource(src).length, 1)
})

test('template-literal fragments concatenated with + are flagged', () => {
  const src = "const sql = `SELECT id FROM ` + `members WHERE ` + `email = ?`"
  assert.equal(scanSource(src).length, 1)
})

// ── scanSource: negatives (must NOT be flagged) ─────────────────────────────────────────

test('a members lookup keyed on id, not email, is NOT flagged', () => {
  const src = `
  const row = await env.DB.prepare(
    'SELECT id, email, display_name FROM members WHERE id = ?1 AND status = \\'active\\' LIMIT 1',
  ).bind(memberId).first()
`
  assert.equal(scanSource(src).length, 0)
})

test('a SELECT of the email column, filtered by id, does not leak into unrelated TS code after the literal (round-2 false-positive fix)', () => {
  // The EXACT shape a fixed-width character window (round 1's hardening draft) mis-flagged:
  // the string literal closes right after "LIMIT 1", and a naive window bled straight
  // through the closing quote into the very next line's TypeScript generic, matching
  // "email" there instead of inside the SQL text.
  const src = `
export async function targetLegacyRoleRank(env, targetMemberId) {
  const member = await env.DB.prepare('SELECT lower(email) AS email FROM members WHERE id = ?1 LIMIT 1')
    .bind(targetMemberId)
    .first()
  if (!member?.email) return 0
}
`
  assert.equal(scanSource(src).length, 0)
})

test('an email comparison belonging to a LATER, unrelated clause in the same giant literal does not attach to an earlier, unrelated members reference', () => {
  // A single large template literal holding two independent EXISTS(...) clauses: the
  // first references members but filters by id only; the second (far away) is the one
  // that actually compares email, on a DIFFERENT alias. Neither should count as the OTHER
  // one's email comparison.
  const filler = 'x'.repeat(500)
  const src = `
const sql = \`(
  EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active' AND ${filler})
  OR EXISTS (SELECT 1 FROM users u2 WHERE lower(u2.email) = lower(m2.email) AND u2.role = 'owner')
)\`
`
  assert.equal(scanSource(src).length, 0)
})

test('an unrelated WHERE clause before FROM members on the same line does not leak in', () => {
  // An outer query's WHERE (on `users`) appears textually BEFORE an inner "FROM members
  // WHERE id = ..." subquery that has nothing to do with email at all.
  const src = `
  const row = \`OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = (SELECT lower(email) FROM members WHERE id = \${idParam}) AND u.role = 'owner')\`
`
  assert.equal(scanSource(src).length, 0)
})

test('"verified_email" is not mistaken for the members.email column (word-boundary check)', () => {
  const src = `
  const row = await env.DB.prepare(
    \`SELECT h.member_id AS id FROM human_login_identities h
       JOIN members m ON m.id = h.member_id
      WHERE lower(h.verified_email) = ?1\`,
  ).bind(email).first()
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

// ── loadAllowlist: corrupt/missing config is a hard failure, never a silent bootstrap ───

test('loadAllowlist: a missing file is a hard failure', () => {
  const result = loadAllowlist(join(tmpdir(), 'definitely-does-not-exist-12345.json'))
  assert.equal(result.ok, false)
})

test('loadAllowlist: unparsable JSON is a hard failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
  const path = join(dir, 'allowlist.json')
  writeFileSync(path, '{ not valid json')
  try {
    const result = loadAllowlist(path)
    assert.equal(result.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadAllowlist: a non-object "files" field is a hard failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
  const path = join(dir, 'allowlist.json')
  writeFileSync(path, JSON.stringify({ files: ['src/foo.ts'] }))
  try {
    const result = loadAllowlist(path)
    assert.equal(result.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadAllowlist: a negative or non-integer count is a hard failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
  const path = join(dir, 'allowlist.json')
  writeFileSync(path, JSON.stringify({ files: { 'src/foo.ts': -1 } }))
  try {
    assert.equal(loadAllowlist(path).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const path2 = join(dir, 'allowlist2.json')
  // dir was removed above — recreate for the second case
  const dir2 = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
  const path3 = join(dir2, 'allowlist.json')
  writeFileSync(path3, JSON.stringify({ files: { 'src/foo.ts': 1.5 } }))
  try {
    assert.equal(loadAllowlist(path3).ok, false)
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('loadAllowlist: a well-formed file loads successfully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
  const path = join(dir, 'allowlist.json')
  writeFileSync(path, JSON.stringify({ files: { 'src/foo.ts': 2, 'src/bar.ts': 0 } }))
  try {
    const result = loadAllowlist(path)
    assert.equal(result.ok, true)
    assert.deepEqual(result.files, { 'src/foo.ts': 2, 'src/bar.ts': 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

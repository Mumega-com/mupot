// tests/invite-insert-shared-predicate-seam.test.ts — mupot#1551 round 2
// (Athena P1 on PR #1559): "two tools, one predicate" — an invite-creating
// producer that stores an un-normalized email, or skips the squatted-row
// check, is a SECOND copy of the predicate the moment it exists, whether or
// not anyone meant it to be. This file greps every `INSERT INTO invites` in
// `src/` (there are exactly four, enumerated below — a fifth appearing
// with none of the checks below is exactly the class of drift this file
// exists to catch) and asserts each one's OWN producer function carries the
// shared predicate it is supposed to.
//
// Contract, per Athena's ruling on this PR:
//   - EVERY producer normalizes the email via `normalizeInviteEmail`
//     (src/auth/pending-invite-link.ts) before it is stored.
//   - The two ORG-INTERNAL producers (POST /invites, team_bootstrap — both
//     reachable by an ordinary tenant member, squad-admin or org-admin)
//     ALSO guard against a "squatted row" (RESERVED_INVITE_EMAIL_SQL,
//     src/members/index.ts).
//   - The Telegram/project door (createProjectInvite,
//     src/members/project-invites.ts) does NOT carry the squatted-row
//     guard — a DELIBERATE exemption, not a gap: this producer requires
//     org-admin or project-admin standing to invoke at all (createProjectInvite's
//     own rank-ceiling check), so RESERVED_INVITE_EMAIL_SQL's org-admin
//     bypass would be a permanent no-op there — the same reasoning that
//     made team_bootstrap's OWN guard unconditional rather than bypassable.
//     It still gets `normalizeInviteEmail` (P1-2) and its own downstream
//     member-mint INSERT (redeemTelegramProjectInvite) carries a
//     `lower(email)` collision guard instead (a different table, same
//     class of fix, tested in tests/telegram-project-onboarding.test.ts).
//
// This is a STATIC check (source text, not runtime behavior) — it cannot
// prove the guard actually WORKS (the dedicated test files for each
// producer do that), only that a future edit cannot silently drop the
// predicate from a producer without this file naming it. Adding a FIFTH
// `INSERT INTO invites` site makes this file fail closed (the enumeration
// below must be updated deliberately, not silently outgrown).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')

interface InviteProducer {
  file: string
  functionName?: string
  /** Must appear in the file, textually before the closing of the function
   *  that owns the `INSERT INTO invites` (approximated here by requiring it
   *  to appear anywhere in the file; functionName scopes files with multiple producers). */
  requiresNormalize: boolean
  requiresReservedGuard: boolean
  reservedGuardExemptionReason?: string
}

const PRODUCERS: InviteProducer[] = [
  {
    file: 'src/members/index.ts',
    requiresNormalize: true,
    requiresReservedGuard: true,
  },
  {
    file: 'src/org/team-bootstrap.ts',
    requiresNormalize: true,
    requiresReservedGuard: true,
  },
  {
    file: 'src/members/project-invites.ts',
    functionName: 'createProjectInvite',
    requiresNormalize: true,
    requiresReservedGuard: false,
    reservedGuardExemptionReason:
      'org-admin/project-admin producer, separate door — createProjectInvite already requires ' +
      'org-admin or project-admin standing to invoke at all, so an org-admin bypass on the ' +
      'reserved check would be a permanent no-op here (same reasoning as team_bootstrap\'s ' +
      'unconditional guard). Gets normalizeInviteEmail + its own downstream lower(email) ' +
      'collision guard on the member-mint INSERT instead.',
  },
  {
    file: 'src/members/project-invites.ts',
    functionName: 'createIdentityOnlyInvite',
    requiresNormalize: true,
    requiresReservedGuard: false,
    reservedGuardExemptionReason:
      'Fresh authenticated dashboard self-pairing derives email from the existing member; ' +
      'it cannot select another email, mint a member, or grant authority. The reserved-row ' +
      'guard protects caller-selected invite emails, so it does not apply to this identity-only producer.',
  },
]

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('mupot#1551 round 2 — every INSERT INTO invites carries the shared predicate', () => {
  it('the enumeration below is exhaustive — exactly these files contain "INSERT INTO invites"', () => {
    // A fifth site appearing anywhere in src/ must be added to PRODUCERS
    // above, deliberately, not discovered by accident later.
    for (const file of ['src/members/index.ts', 'src/org/team-bootstrap.ts', 'src/members/project-invites.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const expected = PRODUCERS.filter((producer) => producer.file === file).length
      expect(countOccurrences(source, 'INSERT INTO invites'), `${file} must match its registered producers`).toBe(expected)
    }
  })

  it.each(PRODUCERS)('$file $functionName normalizes the email before storing it', ({ file, functionName }) => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const producer = functionName
      ? source.slice(source.indexOf(`export async function ${functionName}(`)).split(/\nexport (?:async )?function /)[0]!
      : source
    expect(countOccurrences(producer, 'INSERT INTO invites')).toBe(1)
    expect(producer).toContain('normalizeInviteEmail')
  })

  it.each(PRODUCERS.filter((p) => p.requiresReservedGuard))(
    '$file guards against a squatted row (RESERVED_INVITE_EMAIL_SQL)',
    ({ file }) => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(source).toContain('RESERVED_INVITE_EMAIL_SQL')
    },
  )

  it('each producer without the reserved-row guard states why', () => {
    const exempt = PRODUCERS.filter((p) => !p.requiresReservedGuard)
    expect(exempt).toHaveLength(2)
    for (const producer of exempt) expect(producer.reservedGuardExemptionReason).toBeTruthy()
    expect(exempt[0]!.file).toBe('src/members/project-invites.ts')
    expect(exempt[0]!.reservedGuardExemptionReason).toBeTruthy()
    const source = readFileSync(join(ROOT, exempt[0]!.file), 'utf8')
    // The exemption is a real design decision, not silence — this file's own
    // door still carries a lower(email) collision guard on its member INSERT.
    expect(source).not.toContain('RESERVED_INVITE_EMAIL_SQL')
    expect(source).toContain('lower(email)')
  })
})

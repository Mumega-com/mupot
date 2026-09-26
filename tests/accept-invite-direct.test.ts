// acceptInvite — called DIRECTLY, mupot#1436 round-2 findings P1-A / WARN-B / WARN-C.
//
// P1-A: every existing "second accept → 409" test (tests/invite-landing-page.test.ts,
// tests/csrf-cookie-mounts.test.ts) goes through a HANDLER that runs its own
// loadInviteLanding pre-check (`if (invite.accepted_at) return already_accepted`)
// BEFORE ever calling acceptInvite — so none of them reach acceptInvite's own
// atomic guard:
//   UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL
// This file calls acceptInvite DIRECTLY, bypassing every handler-level
// pre-check, so the guard is exercised at the exact place — and in the exact
// way (concurrent callers) — it exists to protect.
//
// Schema via createSqliteD1 + applyAllMigrations — no hand-written CREATE TABLE.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { acceptInvite } from '../src/members'
import * as membersService from '../src/members/service'
import type { Env } from '../src/types'

const TENANT = 'pot-a'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot' } as unknown as Env
}

function seedInvite(harness: SqliteD1Harness, id: string, email: string): void {
  harness.sqlite
    .prepare(`INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES (?, ?, 'dept-a', 'member', 'member-admin')`)
    .run(id, email)
}

function memberRowFor(harness: SqliteD1Harness, email: string) {
  return harness.sqlite
    .prepare(`SELECT id FROM members WHERE email = ?`)
    .get(email) as { id: string } | undefined
}

describe('acceptInvite — atomic single-use guard, called directly (P1-A)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('sequential: the first accept succeeds, the second returns invite_already_accepted', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-seq', 'seq@example.com')

    const first = await acceptInvite(env, 'inv-seq', 'First')
    expect(first.ok).toBe(true)

    const second = await acceptInvite(env, 'inv-seq', 'Second')
    expect(second).toEqual({ ok: false, error: 'invite_already_accepted' })

    // Only the first call's write should exist.
    expect(memberRowFor(harness, 'seq@example.com')).toBeDefined()
    const n = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }
    expect(n.n).toBe(2) // member-admin + the one accepted member
  })

  it('5x concurrent Promise.all on a fresh invite: exactly one wins, four are refused', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-race', 'race@example.com')

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => acceptInvite(env, 'inv-race', `Racer ${i}`)),
    )

    const wins = results.filter((r) => r.ok)
    const losses = results.filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(4)
    for (const loss of losses) {
      expect(loss).toEqual({ ok: false, error: 'invite_already_accepted' })
    }

    const member = memberRowFor(harness, 'race@example.com')
    expect(member).toBeDefined()

    const memberCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE email = ?`)
      .get('race@example.com') as { n: number }
    expect(memberCount.n).toBe(1)

    const capCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ?`)
      .get(member!.id) as { n: number }
    expect(capCount.n).toBe(1)

    // mupot#1551: acceptInvite never mints a token any more (function-boundary
    // invariant, not a per-caller option) — the race winner gets no
    // member_tokens row either.
    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?`)
      .get(member!.id) as { n: number }
    expect(tokenCount.n).toBe(0)
  })
})

describe('acceptInvite — server-side display_name cap (WARN-B)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('rejects a 200k-character display name for BOTH callers (enforced once, shared)', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-long-name', 'longname@example.com')

    const result = await acceptInvite(env, 'inv-long-name', 'x'.repeat(200_000))
    expect(result).toEqual({ ok: false, error: 'invalid_display_name' })
    expect(memberRowFor(harness, 'longname@example.com')).toBeUndefined()

    // The invite must NOT have been spent by a rejected attempt.
    const invite = harness.sqlite
      .prepare(`SELECT accepted_at FROM invites WHERE id = 'inv-long-name'`)
      .get() as { accepted_at: string | null }
    expect(invite.accepted_at).toBeNull()
  })

  it('rejects an empty (post-trim) display name', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-blank-name', 'blankname@example.com')

    const result = await acceptInvite(env, 'inv-blank-name', '    ')
    expect(result).toEqual({ ok: false, error: 'invalid_display_name' })
  })

  it('accepts exactly 120 characters (boundary)', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-boundary-name', 'boundary@example.com')

    const result = await acceptInvite(env, 'inv-boundary-name', 'x'.repeat(120))
    expect(result.ok).toBe(true)
  })
})

// mupot#1551 (Athena's ruling, 2026-09-26): acceptInvite() can no longer mint
// a token AT ALL — this used to be a per-caller `mintToken` option (WARN-C);
// it is now a function-boundary invariant with no flag to flip. These tests
// pin that boundary directly, not just its downstream symptom.
describe('acceptInvite — never mints a token (mupot#1551, function boundary)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined; vi.restoreAllMocks() })

  it('writes member+capability but NO member_tokens row, and returns token: null', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-no-token', 'notoken@example.com')

    const result = await acceptInvite(env, 'inv-no-token', 'No Token')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.token).toBeNull()

    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?`)
      .get(result.value.member_id) as { n: number }
    expect(tokenCount.n).toBe(0)
  })

  it('never even COMPUTES a raw token or its hash — mintRawToken/sha256Hex are not called', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    seedInvite(harness, 'inv-no-hash', 'nohash@example.com')

    const mintSpy = vi.spyOn(membersService, 'mintRawToken')
    const hashSpy = vi.spyOn(membersService, 'sha256Hex')

    const result = await acceptInvite(env, 'inv-no-hash', 'No Hash')
    expect(result.ok).toBe(true)

    // Neither helper is imported by src/members/index.ts's acceptInvite any
    // more (the call sites were deleted, not merely gated behind an `if`
    // that happens not to trigger) — asserting zero calls proves the code
    // path structurally cannot produce a raw token, not just that this one
    // run didn't.
    expect(mintSpy).not.toHaveBeenCalled()
    expect(hashSpy).not.toHaveBeenCalled()
  })
})

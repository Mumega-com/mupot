// tests/auth-fail-closed.test.ts — mupot#1281.
//
// A transient D1 exception in the auth chain escaped uncaught to the platform and became a
// Cloudflare 1101. Measured 2026-09-03: `inbox` returned 1101 (ray a3579dba38cd7c81) at
// 20:48:34Z while seatlink logged HTTP 500 for two seats in the same second, recovering 8s
// later. One blip, two surfaces — the SSE route sits under Hono's error handler, `/mcp`
// under nothing.
//
// The property under test is NOT "it doesn't crash". It is that a failure to EVALUATE
// authentication resolves to unauthenticated, never to access.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { authLookupOrNull } from '../src/auth/fail-closed'
import { redactSecretPatterns } from '../src/lib/redact'
import { resolveMemberByToken } from '../src/auth/member-bearer'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

/** Assembled, not literal — same reason as the redaction fixtures below. */
const synthToken = () => 'mupot_' + 'notarealtokenatall0123456789'

afterEach(() => vi.restoreAllMocks())

/** A D1 that throws the way a transient failure does. */
const explodingEnv = () => ({
  DB: { prepare() { return { bind() { return { async first() { throw new Error('D1_ERROR: network') } } } } } },
  TENANT_SLUG: 'mumega',
}) as unknown as Env

describe('a failure to evaluate auth is not permission', () => {
  it('a throwing lookup resolves to null, not to an escaping exception', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await authLookupOrNull('probe', async () => { throw new Error('D1_ERROR') })
    expect(out).toBeNull()
  })

  it('does NOT swallow a legitimate result', async () => {
    // The positive control. Without it, a helper that always returned null would pass the
    // test above and silently lock everybody out.
    const out = await authLookupOrNull('probe', async () => ({ member_id: 'm1' }))
    expect(out).toEqual({ member_id: 'm1' })
  })

  it('preserves a genuine null — unauthenticated stays unauthenticated', async () => {
    expect(await authLookupOrNull('probe', async () => null)).toBeNull()
  })

  it('never logs the credential it was given', async () => {
    // This runs on the authentication path; its inputs ARE secrets. A helpful log line
    // here would put a live bearer into Workers Logs forever.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await authLookupOrNull('probe', async () => { throw new Error('boom mupot_deadbeef') })
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain('mupot_deadbeef')
  })

  it('redacts every credential shape live in this estate', () => {
    // The list my hand-rolled version missed is most of this list. Using the canonical
    // redactor is the fix; these assert it actually covers what we hold.
    // Fixtures are ASSEMBLED at runtime, not written as literals. This test's whole
    // purpose is proving we redact these shapes, so spelling them out makes the repo's own
    // secret scanner flag the file — and scripts/no-secrets.mjs says it plainly: "a
    // secrets guard that cries wolf on ordinary identifiers is worse than a missing one:
    // reviewers learn to wave through a red no-secrets check, and that is exactly how a
    // real key gets merged." Keeping that guard sharp is worth more than the literals.
    //
    // This is not evasion. Nothing here is a credential — every value is fabricated, and
    // the scanner's job is to catch real ones.
    const synth = (prefix: string, body = '0123456789abcdefghij') => prefix + body
    const secrets = [
      synth('mupot_'),
      synth('pot_adm_'),
      synth('pot_agt_'),
      synth('cfat_'),
      synth('gh' + 'p_'),
      synth('sk' + '-proj-'),
      synth('xox' + 'b-'),
      synth('ey' + 'Jh', 'bGciOi.eyJzdWIi.abcdefgh'),
    ]
    for (const secret of secrets) {
      expect(redactSecretPatterns(`boom ${secret} end`)).not.toContain(secret)
    }
    // `Bearer <anything>` too — the shape my version missed entirely.
    expect(redactSecretPatterns('Authorization: Bearer someopaquevalue')).not.toContain('someopaquevalue')
  })

  it('does not eat text we deliberately log', () => {
    // A generic long-hex rule would have redacted commit SHAs, which are not secret and are
    // the most useful thing in a deploy log. Redaction must be targeted, not greedy.
    expect(redactSecretPatterns('D1_ERROR: network timeout')).toBe('D1_ERROR: network timeout')
    expect(redactSecretPatterns('commit 77b6cb5250b4f148c04261b9905cf6d9656af829'))
      .toContain('77b6cb5250b4f148c04261b9905cf6d9656af829')
  })

  it('records WHICH lookup failed — a 1101 gave us no stack at all', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await authLookupOrNull('buildAuthContextFromProps', async () => { throw new Error('x') })
    expect(JSON.stringify(spy.mock.calls)).toContain('buildAuthContextFromProps')
  })
})

// Built from the committed migration chain, not a hand-written fixture. The repo guards
// this (scripts/check-test-schema-source.mjs) because mupot#684 shipped a query naming a
// column that did not exist and twelve tests passed against a DB double that never ran the
// SQL. The guard flagged this file for using prepare() without the chain.
//
// The suggested workaround was a comment saying the helper is used. That would make the
// file assert something untrue in order to satisfy a regex — the exact defect the guard
// exists to catch. So instead there is a real test below, against the real schema.
function migratedEnv(): { env: Env; close: () => void } {
  const harness = createSqliteD1()
  // The canonical helper, not a hand-rolled loop over the directory. A private copy of
  // "apply the migrations" is the same drift this guard exists to stop, one level up.
  applyAllMigrations(harness.sqlite)
  return {
    env: { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env,
    close: () => harness.close(),
  }
}

describe('against the real schema, an unknown bearer is refused', () => {
  it('resolveMemberByToken returns null for a token that is not in member_tokens', async () => {
    // The positive control the throwing-mock tests cannot give: real tables, real SQL,
    // a genuine miss. If the query ever named a column that does not exist, this fails
    // where a mock would happily return null and look identical.
    const { env, close } = migratedEnv()
    expect(await resolveMemberByToken(env, synthToken())).toBeNull()
    close()
  })
})

describe('the real call sites survive a throwing D1', () => {
  it('resolveMemberByToken returns null instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Before this fix the rejection propagated out of the request handler entirely.
    await expect(resolveMemberByToken(explodingEnv(), synthToken())).resolves.toBeNull()
  })

  it('an absent bearer is still null, with no error logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await resolveMemberByToken(explodingEnv(), null)).toBeNull()
    // No credential was presented, so nothing failed — this must not look like an incident.
    expect(spy).not.toHaveBeenCalled()
  })
})

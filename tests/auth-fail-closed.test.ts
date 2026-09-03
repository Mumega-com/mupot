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
    const secrets = [
      'mupot_deadbeefcafe1234',
      'pot_adm_0123456789abcdef',
      'pot_agt_0123456789abcdef',
      'cfat_0123456789abcdefghij',
      'ghp_0123456789abcdefghij',
      'sk-proj-0123456789abcdef',
      'xoxb-0123456789-abcdefgh',
      'eyJhbGciOi.eyJzdWIi.abcdef',
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

describe('the real call sites survive a throwing D1', () => {
  it('resolveMemberByToken returns null instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Before this fix the rejection propagated out of the request handler entirely.
    await expect(resolveMemberByToken(explodingEnv(), 'mupot_sometoken')).resolves.toBeNull()
  })

  it('an absent bearer is still null, with no error logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await resolveMemberByToken(explodingEnv(), null)).toBeNull()
    // No credential was presented, so nothing failed — this must not look like an incident.
    expect(spy).not.toHaveBeenCalled()
  })
})

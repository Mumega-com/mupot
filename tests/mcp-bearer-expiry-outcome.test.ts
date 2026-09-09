// tests/mcp-bearer-expiry-outcome.test.ts — expiry at the /mcp doors.
//
// WHY THIS FILE EXISTS ALONGSIDE token-lifecycle-real-schema.test.ts
//
// That file proves TOKEN_LIVE_PREDICATE is correct, and asserts two source files
// reference it. Both claims were true while an expired credential still authenticated
// in production, because the doors it names are not all the doors:
//
//   src/mcp/index.ts          authenticateMember        ← named, guarded
//   src/auth/member-bearer.ts resolveMemberByToken      ← named, guarded
//   src/mcp/oauth-authorize.ts resolveExternalToken     ← NOT named. POST /mcp bearer.
//   src/mcp/oauth-authorize.ts buildAuthContextFromProps ← NOT named. Every MCP request.
//
// Its own guard iterates a hardcoded two-element file list, so the third and fourth
// lookups could never have failed it. That is the defect class: a labelled condition
// ("both doors") that stopped matching its members, verified against the label.
//
// So this file asserts the OUTCOME through the ACTUAL production functions rather than
// a transcribed query: an expired token must not authenticate, whichever door it uses.
//
// PAIRED POSITIVE CONTROLS ARE LOAD-BEARING. Both resolvers wrap their D1 reads in
// authLookupOrNull, which converts ANY throw into `null`. A test that only asserted
// "expired ⇒ null" would pass identically against a schema that does not exist, a
// binding error, or a typo in the SQL. Every negative case below is paired with the
// same call on a LIVE token that must return non-null through the same code path.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { resolveExternalToken, buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch {
      // Same tolerance as token-lifecycle-real-schema.test.ts: some historical
      // migrations are environment-specific. The columns this test depends on are
      // asserted explicitly below rather than assumed.
    }
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** An expiry earlier today, ISO-shaped — the format that fails OPEN under a string
 *  compare. Using it here means a fix that "enforces expiry" with `>` instead of
 *  julianday() does not get to pass this file either. */
function isoEarlierToday(): string {
  const now = Date.now()
  const midnight = new Date(now)
  midnight.setUTCHours(0, 0, 0, 0)
  const clamped = Math.min(Math.max(now - 3600_000, midnight.getTime()), now)
  return new Date(clamped).toISOString()
}

describe('POST /mcp bearer doors enforce expiry', () => {
  let h: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite
      .prepare(
        `INSERT INTO members (id, email, display_name, status, tenant)
         VALUES ('mem-1', 'agent@test.local', 'Agent One', 'active', '${TENANT}')`,
      )
      .run()
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  async function insertToken(
    id: string,
    raw: string,
    opts: { expires_at?: string | null; revoked_at?: string | null } = {},
  ): Promise<void> {
    h.sqlite
      .prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, expires_at, tenant)
         VALUES (?, 'mem-1', ?, 'test', 'workspace', datetime('now'), ?, ?, '${TENANT}')`,
      )
      .run(id, await sha256Hex(raw), opts.revoked_at ?? null, opts.expires_at ?? null)
  }

  it('the schema under test actually has expires_at (not a silently skipped migration)', () => {
    const cols = h.sqlite.prepare('PRAGMA table_info(member_tokens)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('expires_at')
  })

  // ── door 3: resolveExternalToken — POST /mcp with a mupot_ member API key ──────

  it('POSITIVE CONTROL: a live token resolves through resolveExternalToken', async () => {
    await insertToken('tok-live', 'mupot_live', { expires_at: '2099-01-01 00:00:00' })
    const out = await resolveExternalToken(env, 'mupot_live')
    // If this is null the harness is broken and every negative case below is vacuous.
    expect(out).not.toBeNull()
    expect(out?.props.memberId).toBe('mem-1')
    expect(out?.props.tokenId).toBe('tok-live')
  })

  it('an EXPIRED token does not resolve through resolveExternalToken', async () => {
    await insertToken('tok-exp', 'mupot_expired', { expires_at: '2020-01-01 00:00:00' })
    expect(await resolveExternalToken(env, 'mupot_expired')).toBeNull()
  })

  it('an ISO-shaped expiry earlier TODAY does not resolve (string compare fails open here)', async () => {
    await insertToken('tok-iso', 'mupot_iso', { expires_at: isoEarlierToday() })
    expect(await resolveExternalToken(env, 'mupot_iso')).toBeNull()
  })

  it('expires_at NULL still resolves — the owner-gated non-expiring exception survives', async () => {
    await insertToken('tok-immortal', 'mupot_immortal', { expires_at: null })
    const out = await resolveExternalToken(env, 'mupot_immortal')
    expect(out).not.toBeNull()
    expect(out?.props.tokenId).toBe('tok-immortal')
  })

  it('a revoked token stays dead through resolveExternalToken', async () => {
    await insertToken('tok-rev', 'mupot_revoked', {
      expires_at: '2099-01-01 00:00:00',
      revoked_at: '2026-01-01 00:00:00',
    })
    expect(await resolveExternalToken(env, 'mupot_revoked')).toBeNull()
  })

  // ── door 4: buildAuthContextFromProps — runs on EVERY MCP request ──────────────

  const props = (tokenId: string) => ({
    memberId: 'mem-1',
    tokenId,
    email: 'agent@test.local',
    channel: 'workspace' as const,
    boundAgentId: null,
    consentedByMemberId: null,
  })

  it('POSITIVE CONTROL: a live token builds an auth context', async () => {
    await insertToken('ctx-live', 'raw-live', { expires_at: '2099-01-01 00:00:00' })
    const auth = await buildAuthContextFromProps(env, props('ctx-live'))
    expect(auth).not.toBeNull()
    expect(auth?.userId).toBe('mem-1')
  })

  it('an EXPIRED token builds NO auth context', async () => {
    await insertToken('ctx-exp', 'raw-expired', { expires_at: '2020-01-01 00:00:00' })
    expect(await buildAuthContextFromProps(env, props('ctx-exp'))).toBeNull()
  })

  it('an ISO-shaped expiry earlier TODAY builds no auth context', async () => {
    await insertToken('ctx-iso', 'raw-iso', { expires_at: isoEarlierToday() })
    expect(await buildAuthContextFromProps(env, props('ctx-iso'))).toBeNull()
  })

  it('expires_at NULL still builds a context — non-expiring exception survives here too', async () => {
    await insertToken('ctx-immortal', 'raw-immortal', { expires_at: null })
    expect(await buildAuthContextFromProps(env, props('ctx-immortal'))).not.toBeNull()
  })

  it('a revoked token builds no context', async () => {
    await insertToken('ctx-rev', 'raw-revoked', {
      expires_at: '2099-01-01 00:00:00',
      revoked_at: '2026-01-01 00:00:00',
    })
    expect(await buildAuthContextFromProps(env, props('ctx-rev'))).toBeNull()
  })
})

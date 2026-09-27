// handoff-dedup.test.ts — the cross-path identity dedup engine (#262).
// Validates upsertUserByEmail: email is the dedup key (one human → one mupot user,
// both directions), allowBootstrapOwner is fail-safe, a concurrent UNIQUE(email) crash is
// caught + recovered (not a 500), and — mupot#1583 round 2 — an AMBIGUOUS match (two rows
// colliding on the same normalized email) is refused, never silently resolved to whichever
// row an ORDER BY happens to prefer.

import { describe, expect, it } from 'vitest'
import { upsertUserByEmail, AmbiguousUserEmailError } from '../src/auth/index'
import type { Env } from '../src/types'

// mupot#1583 round 1 P3 / round 2: the mocks below match this EXACT query text, not a
// loose `sql.includes('email')` substring — a real change to findUserByEmail's own query
// (src/auth/index.ts) must break this test visibly, not silently keep "matching" via a
// substring that happened to still be present. Round 2: findUserByEmail now reads ALL
// matching rows via `.all()` (no LIMIT) instead of `.first()` — see AmbiguousUserEmailError.
const FIND_USER_BY_EMAIL_SQL =
  'SELECT id, role FROM users WHERE lower(email) = ?1 ORDER BY created_at ASC, id ASC'

type Row = { id: string; email: string | null; role: 'owner' | 'admin' | 'member' }

// Minimal stateful in-memory `users` table with the UNIQUE(email) constraint, driven
// through a D1-shaped prepare()/bind()/first()/all()/run() surface. `throwOnInsertEmail`
// simulates losing the concurrent-insert race (the winner already took the email).
// `exactEmails` (not a normalized index) is what backs the UNIQUE(email) simulation on
// `run()` — real `users.email` has no COLLATE NOCASE (migration 0001), so two
// differently-cased rows for the same email are a LEGAL shape at the DB level, which is
// exactly what lets the ambiguity test below construct that state.
function makeUsersDB(seed: Row[] = [], opts: { throwOnInsertEmail?: boolean } = {}) {
  const byId = new Map<string, Row>()
  const exactEmails = new Set<string>()
  for (const r of seed) {
    byId.set(r.id, r)
    if (r.email) exactEmails.add(r.email)
  }
  function rowsForNormalizedEmail(normEmail: string): Row[] {
    return [...byId.values()]
      .filter((r) => r.email?.toLowerCase() === normEmail)
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = []
      const api = {
        bind(...a: unknown[]) {
          args = a
          return api
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('WHERE id')) {
            return (byId.get(args[0] as string) ?? null) as T | null
          }
          if (sql.includes('COUNT(*)')) {
            return { n: byId.size } as unknown as T
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql === FIND_USER_BY_EMAIL_SQL) {
            return { results: rowsForNormalizedEmail(args[0] as string) as unknown as T[] }
          }
          return { results: [] }
        },
        async run() {
          // INSERT INTO users (id, email, role) ... ON CONFLICT(id) DO NOTHING
          const [id, email, role] = args as [string, string | null, Row['role']]
          if (email && opts.throwOnInsertEmail) {
            throw new Error('D1_ERROR: UNIQUE constraint failed: users.email')
          }
          if (byId.has(id)) return { meta: { changes: 0 } } // ON CONFLICT(id) DO NOTHING
          if (email && exactEmails.has(email)) {
            throw new Error('D1_ERROR: UNIQUE constraint failed: users.email')
          }
          const row: Row = { id, email, role }
          byId.set(id, row)
          if (email) exactEmails.add(email)
          return { meta: { changes: 1 } }
        },
      }
      return api
    },
  }
  return { DB: DB as unknown as Env['DB'], byId }
}

const env = (db: Env['DB']) => ({ DB: db }) as unknown as Env

describe('upsertUserByEmail — cross-path dedup (#262)', () => {
  it('handoff reuses an existing OWN-GOOGLE user with the same email (direction 1)', async () => {
    const { DB } = makeUsersDB([{ id: 'google-id-abc', email: 'op@x.com', role: 'owner' }])
    // Handoff arrives with a different preferredId (hash(mumega:email)) but same email.
    const r = await upsertUserByEmail(env(DB), 'mumega-id-zzz', 'op@x.com')
    expect(r.id).toBe('google-id-abc') // canonical = the existing row, NOT preferredId
    expect(r.role).toBe('owner') // role preserved, never clobbered
  })

  it('own-Google login reuses an existing HANDOFF user with the same email (direction 2)', async () => {
    const { DB } = makeUsersDB([{ id: 'mumega-id-zzz', email: 'op@x.com', role: 'member' }])
    const r = await upsertUserByEmail(env(DB), 'google-id-abc', 'op@x.com', true)
    expect(r.id).toBe('mumega-id-zzz')
    expect(r.role).toBe('member')
  })

  it('email match is case/whitespace-insensitive', async () => {
    const { DB } = makeUsersDB([{ id: 'u1', email: 'op@x.com', role: 'member' }])
    const r = await upsertUserByEmail(env(DB), 'other', '  OP@X.com ')
    expect(r.id).toBe('u1')
  })

  it('a handoff NEVER bootstraps the first owner (allowBootstrapOwner defaults false)', async () => {
    const { DB, byId } = makeUsersDB([]) // virgin pot
    const r = await upsertUserByEmail(env(DB), 'mumega-id', 'first@x.com') // handoff path
    expect(r.role).toBe('member')
    expect(byId.get('mumega-id')?.role).toBe('member')
  })

  it('the own-Google path DOES bootstrap the first owner (allowBootstrapOwner=true)', async () => {
    const { DB } = makeUsersDB([])
    const r = await upsertUserByEmail(env(DB), 'google-id', 'first@x.com', true)
    expect(r.role).toBe('owner')
  })

  it('a later non-first handoff user is a member (no escalation)', async () => {
    const { DB } = makeUsersDB([{ id: 'owner1', email: 'owner@x.com', role: 'owner' }])
    const r = await upsertUserByEmail(env(DB), 'mumega-new', 'new@x.com')
    expect(r.role).toBe('member')
  })

  it('recovers from a concurrent UNIQUE(email) insert crash → returns the winner row (no 500)', async () => {
    // Race: step-1 email lookup MISSES, then our INSERT loses to a concurrent winner
    // that already took the email (UNIQUE violation). The catch must fall back to the
    // re-resolve email lookup, which now finds the winner. No throw, no 500.
    const winner: Row = { id: 'winner-id', email: 'race@x.com', role: 'member' }
    let committed = false // the winner commits at the moment of our failed INSERT
    let inserted = false
    const DB = {
      prepare(sql: string) {
        let args: unknown[] = []
        const api = {
          bind(...a: unknown[]) {
            args = a
            return api
          },
          async first<T>(): Promise<T | null> {
            if (sql.includes('WHERE id')) return null as T | null
            if (sql.includes('COUNT(*)')) return { n: 0 } as unknown as T
            return null
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (sql === FIND_USER_BY_EMAIL_SQL) {
              return { results: (committed ? [winner] : []) as unknown as T[] } // miss pre-race, hit post-race
            }
            return { results: [] }
          },
          async run() {
            inserted = true
            committed = true // the concurrent winner commits, then ours conflicts
            throw new Error('D1_ERROR: UNIQUE constraint failed: users.email')
          },
        }
        return api
      },
    }
    const r = await upsertUserByEmail(env(DB as unknown as Env['DB']), 'loser-id', 'race@x.com')
    expect(inserted).toBe(true) // we did attempt the insert
    expect(r.id).toBe('winner-id') // resolved the winner, did not throw
  })

  // mupot#1583 round 2 (Athena BLOCK): an OLDER 'member' row and a NEWER case-variant
  // 'owner' row (e.g. 'Boss@Pot.test') both matching the same normalized email used to be
  // silently collapsed to ONE winner by `ORDER BY created_at ASC LIMIT 1` — whichever row
  // that ORDER BY preferred decided the returned role, invisibly. upsertUserByEmail must
  // now refuse outright rather than pick either row.
  it('two rows colliding on the same normalized email (case-variant) throw AmbiguousUserEmailError, never silently pick a winner', async () => {
    const { DB } = makeUsersDB([
      { id: 'older-member-id', email: 'boss@pot.test', role: 'member' },
      { id: 'newer-owner-id', email: 'Boss@Pot.test', role: 'owner' },
    ])
    await expect(upsertUserByEmail(env(DB), 'whoever', 'boss@pot.test')).rejects.toThrow(
      AmbiguousUserEmailError,
    )
  })
})

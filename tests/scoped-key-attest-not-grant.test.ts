// S1 regression — mintScopedKey must ATTEST existing authority, never GRANT it.
//
// The live HIGH (identity-access-fix-map §S1): the old mintScopedKey wrote a standing
// `capabilities` row + `gate_grants` rows on the MEMBER at mint time. Caps resolve from
// `capabilities` at auth and the token carries no scope of its own, so those rows both
// (a) elevated the principal and (b) survived token revocation. The fix: mint verifies
// the member already holds >= the preset capability and writes NOTHING to the principal.
//
// The regression guard proven here: across a successful mint, NO INSERT touches
// `capabilities` or `gate_grants`; and a member without the capability is refused
// (never elevated), with no token minted.

import { describe, expect, it } from 'vitest'
import { mintScopedKey } from '../src/dashboard/keys'
import type { Capability, CapabilityGrant, Env } from '../src/types'

interface Rec {
  sql: string
  values: unknown[]
}

function makeDb(grants: CapabilityGrant[], opts: { memberActive?: boolean } = {}) {
  const statements: Rec[] = []
  const db = {
    prepare(sql: string) {
      const rec: Rec = { sql, values: [] }
      statements.push(rec)
      return {
        bind(...values: unknown[]) {
          rec.values = values
          return {
            async first<T>() {
              if (sql.includes('FROM members WHERE id')) {
                return (opts.memberActive === false ? null : { id: values[0] }) as T | null
              }
              throw new Error(`unexpected first(): ${sql}`)
            },
            async all<T>() {
              if (sql.includes('FROM capabilities')) {
                return { results: grants as T[] }
              }
              throw new Error(`unexpected all(): ${sql}`)
            },
            async run() {
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
  return { env: { TENANT_SLUG: 'tenant-a', DB: db } as unknown as Env, statements }
}

const orgGrant = (capability: Capability): CapabilityGrant =>
  ({ member_id: 'm1', scope_type: 'org', scope_id: null, capability }) as CapabilityGrant

const wrote = (statements: Rec[], re: RegExp) => statements.some((s) => re.test(s.sql))

describe('mintScopedKey — attest, never grant (S1)', () => {
  // 'brain' preset: role=observer, scopeType=org — no squad/department validation path.
  const brainKey = { memberId: 'm1', presetId: 'brain', scopeId: null, minterRank: 5 }

  it('refuses when the member lacks the preset capability — never elevates, mints nothing', async () => {
    const { env, statements } = makeDb([]) // member holds no capability
    const res = await mintScopedKey(env, brainKey)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('member_lacks_capability')

    // No principal mutation and no token on refusal.
    expect(wrote(statements, /INTO\s+capabilities/i)).toBe(false)
    expect(wrote(statements, /INTO\s+gate_grants/i)).toBe(false)
    expect(wrote(statements, /INTO\s+member_tokens/i)).toBe(false)
  })

  it('mints when the member already holds the capability, writing NO standing principal grant', async () => {
    const { env, statements } = makeDb([orgGrant('admin')]) // admin >= observer
    const res = await mintScopedKey(env, brainKey)

    expect(res.ok).toBe(true)
    // The token IS minted…
    expect(wrote(statements, /INTO\s+member_tokens/i)).toBe(true)
    // …but the mint mutates the principal NOWHERE — the S1 regression guard.
    expect(wrote(statements, /INTO\s+capabilities/i)).toBe(false)
    expect(wrote(statements, /INTO\s+gate_grants/i)).toBe(false)
  })

  it('refuses an inactive member before any capability read', async () => {
    const { env, statements } = makeDb([orgGrant('admin')], { memberActive: false })
    const res = await mintScopedKey(env, brainKey)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('member_not_found')
    expect(wrote(statements, /INTO\s+member_tokens/i)).toBe(false)
  })
})

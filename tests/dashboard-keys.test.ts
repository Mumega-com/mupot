// Tests for:
//  1. Role preset correctness (src/auth/role-presets.ts)
//  2. loadKeysView — DB query shape
//  3. mintScopedKey — happy path + all guard paths
//  4. Show-once: raw is returned exactly once (no DB read-back possible)
//  5. Non-admin guard: isAdmin check (verified at route layer; modelled here via mintScopedKey expectations)
//  6. Tenant-scope: scope_id validated against this pot's D1 only

import { describe, it, expect } from 'vitest'
import {
  ROLE_PRESETS,
  findPreset,
  isValidPresetId,
} from '../src/auth/role-presets'
import { loadKeysView, mintScopedKey } from '../src/dashboard/keys'
import type { Env } from '../src/types'

// ── D1 mock helpers ────────────────────────────────────────────────────────────

interface CallRecord {
  sql: string
  binds: unknown[]
}

/**
 * Build a mock Env that records every DB.prepare() call.
 *
 * queryBatches: each element is the rows returned for the Nth .all() call.
 * firstResults: each element is the row returned for the Nth .first() call.
 * runChanges: each element is the `changes` meta for the Nth .run() call.
 */
function makeEnv(opts: {
  queryBatches?: unknown[][]
  firstResults?: (Record<string, unknown> | null)[]
  runChanges?: number[]
} = {}): { env: Env; calls: CallRecord[] } {
  const { queryBatches = [], firstResults = [], runChanges = [] } = opts
  const calls: CallRecord[] = []
  let allIdx = 0
  let firstIdx = 0
  let runIdx = 0

  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        const call: CallRecord = { sql, binds: [] }
        calls.push(call)
        const thisAllIdx = allIdx++
        const thisFirstIdx = firstIdx++
        const thisRunIdx = runIdx++
        const stmt = {
          bind(...args: unknown[]) { call.binds = args; return stmt },
          async all()  { return { results: queryBatches[thisAllIdx] ?? [] } },
          async first() { return firstResults[thisFirstIdx] ?? null },
          async run()  { return { meta: { changes: runChanges[thisRunIdx] ?? 1 } } },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, calls }
}

// ── 1. Role presets ────────────────────────────────────────────────────────────

describe('ROLE_PRESETS', () => {
  it('exports at least 3 presets', () => {
    expect(ROLE_PRESETS.length).toBeGreaterThanOrEqual(3)
  })

  it('includes sales-rep, admin, observer', () => {
    const ids = ROLE_PRESETS.map((p) => p.id)
    expect(ids).toContain('sales-rep')
    expect(ids).toContain('admin')
    expect(ids).toContain('observer')
  })

  describe('sales-rep preset', () => {
    const p = findPreset('sales-rep')!
    it('exists', () => expect(p).toBeTruthy())
    it('role is member (no admin on sales-rep key)', () => expect(p.role).toBe('member'))
    it('scopeType is squad', () => expect(p.scopeType).toBe('squad'))
    it('scopeHint is squad (picker required)', () => expect(p.scopeHint).toBe('squad'))
    it('allows includes leads:read and outreach:draft', () => {
      expect(p.allows).toContain('leads:read')
      expect(p.allows).toContain('outreach:draft')
    })
    it('denies includes admin and cross-tenant', () => {
      expect(p.denies).toContain('admin')
      expect(p.denies).toContain('cross-tenant')
    })
    it('denies includes mcpwp:write', () => {
      expect(p.denies).toContain('mcpwp:write')
    })
    it('denies includes budget:write', () => {
      expect(p.denies).toContain('budget:write')
    })
  })

  describe('admin preset', () => {
    const p = findPreset('admin')!
    it('exists', () => expect(p).toBeTruthy())
    it('role is admin (NOT owner — admins cannot mint owner tokens)', () => expect(p.role).toBe('admin'))
    it('scopeType is org', () => expect(p.scopeType).toBe('org'))
    it('scopeHint is org (no scope picker needed)', () => expect(p.scopeHint).toBe('org'))
    it('denies includes owner (admin preset cannot mint owner-level tokens)', () => {
      expect(p.denies).toContain('owner')
    })
  })

  describe('observer preset', () => {
    const p = findPreset('observer')!
    it('exists', () => expect(p).toBeTruthy())
    it('role is observer', () => expect(p.role).toBe('observer'))
    it('allows read-only surfaces', () => {
      expect(p.allows).toContain('tasks:read')
      expect(p.allows).toContain('pipeline:read')
    })
    it('denies write', () => {
      expect(p.denies).toContain('write')
      expect(p.denies).toContain('outreach:send')
    })
  })

  describe('findPreset', () => {
    it('returns null for unknown id', () => expect(findPreset('does-not-exist')).toBeNull())
    it('returns the preset for a valid id', () => expect(findPreset('sales-rep')).not.toBeNull())
  })

  describe('isValidPresetId', () => {
    it('returns true for valid preset id', () => expect(isValidPresetId('admin')).toBe(true))
    it('returns false for unknown string', () => expect(isValidPresetId('superadmin')).toBe(false))
    it('returns false for non-string', () => expect(isValidPresetId(42)).toBe(false))
    it('returns false for empty string', () => expect(isValidPresetId('')).toBe(false))
  })
})

// ── 2. loadKeysView ────────────────────────────────────────────────────────────

describe('loadKeysView', () => {
  it('issues 4 queries (members, squads, departments, tokens)', async () => {
    const { env, calls } = makeEnv({ queryBatches: [[], [], [], []] })
    await loadKeysView(env)
    expect(calls).toHaveLength(4)
  })

  it('members query filters status=active', async () => {
    const { env, calls } = makeEnv({ queryBatches: [[], [], [], []] })
    await loadKeysView(env)
    expect(calls[0].sql).toContain("status = 'active'")
  })

  it('squads query JOINs departments for dept_name', async () => {
    const { env, calls } = makeEnv({ queryBatches: [[], [], [], []] })
    await loadKeysView(env)
    expect(calls[1].sql).toContain('LEFT JOIN departments')
    expect(calls[1].sql).toContain('dept_name')
  })

  it('tokens query filters on label LIKE [preset:%', async () => {
    const { env, calls } = makeEnv({ queryBatches: [[], [], [], []] })
    await loadKeysView(env)
    expect(calls[3].sql).toContain('[preset:%')
    expect(calls[3].sql).toContain('revoked_at IS NULL')
  })

  it('returns empty arrays when DB returns no rows', async () => {
    const { env } = makeEnv({ queryBatches: [[], [], [], []] })
    const view = await loadKeysView(env)
    expect(view.members).toEqual([])
    expect(view.squads).toEqual([])
    expect(view.departments).toEqual([])
    expect(view.tokens).toEqual([])
  })

  it('populates arrays from DB rows', async () => {
    const member = { id: 'm1', display_name: 'Alice', email: 'a@x' }
    const squad  = { id: 's1', name: 'Sales', dept_name: 'Growth' }
    const dept   = { id: 'd1', name: 'Growth' }
    const token  = { id: 't1', member_id: 'm1', label: '[preset:sales-rep:s1]', created_at: '2026-01-01T00:00:00Z' }
    const { env } = makeEnv({ queryBatches: [[member], [squad], [dept], [token]] })
    const view = await loadKeysView(env)
    expect(view.members[0]).toMatchObject({ id: 'm1', display_name: 'Alice' })
    expect(view.squads[0]).toMatchObject({ id: 's1', name: 'Sales', dept_name: 'Growth' })
    expect(view.departments[0]).toMatchObject({ id: 'd1', name: 'Growth' })
    expect(view.tokens[0]).toMatchObject({ id: 't1', label: '[preset:sales-rep:s1]' })
  })
})

// ── 3. mintScopedKey ──────────────────────────────────────────────────────────
//
// DB call order (per mintScopedKey), current shape:
//   1. .first() — member-belongs-to-pot check
//   2. .all()   — resolveCapabilities, for the target-rank ceiling (mupot#1453)
//   3. .first() — targetLegacyRoleRank's members.email bridge (same ceiling)
//   4. .first() — squad/dept exists check (only for squad/department scope)
//   5. .first() — squad's department_id (inheritance check, squad scope only)
//   6. .all()   — resolveCapabilities again, for the S1 attest/"already holds" check
//   7. .run()   — INSERT member_tokens
//
// minterRank values used in tests:
//   owner=5, admin=4, lead=3, member=2, observer=1
//   admin minting sales-rep(member,2): minterRank=4, presetRank=2 → 2<4 → OK
//   owner minting admin(admin,4):      minterRank=5, presetRank=4 → 4<5 → OK
//   admin minting admin(admin,4):      minterRank=4, presetRank=4 → 4>=4 → rank_ceiling
//   admin minting observer(observer,1):minterRank=4, presetRank=1 → 1<4 → OK
//
// The mock below dispatches by SQL content, not by call ordinal — mupot#1453
// added two new DB round trips (the target-rank ceiling) between the member
// check and the scope-validation checks, so an ordinal-indexed mock would
// silently feed every later call the wrong fixture. Keyed dispatch makes the
// mock immune to future reordering of the same kind.

interface MintEnvOptions {
  member?: Record<string, unknown> | null
  squad?: Record<string, unknown> | null
  department?: Record<string, unknown> | null
  squadDepartmentId?: Record<string, unknown> | null
  /** resolveCapabilities' result for the target member — reused for BOTH the
   *  target-rank ceiling (mupot#1453) and the S1 attest check, since both
   *  call sites resolve capabilities for the SAME target memberId. */
  grants?: Record<string, unknown>[]
  /** targetLegacyRoleRank's members.email bridge lookup. Default (undefined)
   *  = no matching row = legacy-role rank 0 (the common, safe case). */
  memberEmail?: Record<string, unknown> | null
  /** targetLegacyRoleRank's users.role lookup (only reached when memberEmail
   *  resolves to a non-null email). */
  userRole?: Record<string, unknown> | null
  runChanges?: number
}

function makeMintEnv(opts: MintEnvOptions = {}): { env: Env; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        const call: CallRecord = { sql, binds: [] }
        calls.push(call)
        const stmt = {
          bind(...args: unknown[]) { call.binds = args; return stmt },
          async all() {
            // The only .all() query mintScopedKey's call graph issues is
            // resolveCapabilities (capabilities UNION ALL
            // channel_capability_grants) — always for the SAME target
            // memberId, whether it's serving the ceiling check or the S1
            // attest check.
            return { results: opts.grants ?? [] }
          },
          async first() {
            if (sql.includes('FROM members') && sql.includes('lower(email)')) {
              return opts.memberEmail ?? null // targetLegacyRoleRank: members bridge
            }
            if (sql.includes('FROM users')) {
              return opts.userRole ?? null // targetLegacyRoleRank: users.role
            }
            if (sql.includes('FROM members')) {
              return opts.member ?? null // member-belongs-to-pot check
            }
            if (sql.includes('FROM squads') && sql.includes('department_id')) {
              // loadSquadScope (src/auth/capability.ts) — `hasCapabilityOnDynamicScope`'s
              // squad-scope load. Full SquadScope shape now (id + department_id + kind),
              // not just the bare department_id the old, separate inheritance-only query
              // returned — synthesized from squadDepartmentId's department_id plus the
              // bound scope id, defaulting kind to 'work' (no test here exercises a home
              // scope through mintScopedKey).
              if (!opts.squadDepartmentId) return null
              return {
                id: call.binds[0],
                department_id: opts.squadDepartmentId.department_id ?? null,
                kind: opts.squadDepartmentId.kind ?? 'work',
              }
            }
            if (sql.includes('FROM squads')) {
              return opts.squad ?? null // squad-exists check
            }
            if (sql.includes('FROM departments')) {
              return opts.department ?? null // department-exists check
            }
            return null
          },
          async run() {
            return { meta: { changes: opts.runChanges ?? 1 } }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, calls }
}

describe('mintScopedKey', () => {
  // ATTEST, never GRANT (S1): mint verifies the member already holds >= the preset
  // capability and writes NOTHING to the principal.
  const noStandingGrant = (calls: { sql: string }[]) => {
    expect(calls.some((c) => c.sql.includes('INTO capabilities'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('INTO gate_grants'))).toBe(false)
  }

  // Happy path: sales-rep (squad scope), member already holds member@s1.
  it('returns ok:true + raw token for a valid sales-rep mint (member already holds the cap)', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'member' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep',
      scopeId: 's1',
      minterRank: 4,  // admin
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.raw).toMatch(/^mupot_/)
    expect(result.label).toBe('[preset:sales-rep:s1]')
    expect(result.tokenId).toBeTruthy()
    // The S1 guard: mint wrote no standing principal grant.
    noStandingGrant(calls)
  })

  // Refuses when the member lacks the preset capability — never elevates.
  it('returns member_lacks_capability when the member does not already hold the cap', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [], // resolveCapabilities → no grants
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep',
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('member_lacks_capability')
    // No token minted, no principal write.
    expect(calls.some((c) => c.sql.includes('INTO member_tokens'))).toBe(false)
    noStandingGrant(calls)
  })

  // Happy path: admin preset (org scope), member already holds admin@org.
  it('mints org-scope admin preset when member holds admin@org (scope_id null)', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm2' },
      grants: [{ member_id: 'm2', scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm2',
      presetId: 'admin',
      scopeId: null,
      minterRank: 5,  // owner
    })
    expect(result.ok).toBe(true)
    noStandingGrant(calls)
  })

  // Happy path: observer preset (squad scope), member already holds observer@s2.
  it('mints observer preset when member holds observer@s2', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm3' },
      squad: { id: 's2' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm3', scope_type: 'squad', scope_id: 's2', capability: 'observer' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm3',
      presetId: 'observer',
      scopeId: 's2',
      minterRank: 4,  // admin
    })
    expect(result.ok).toBe(true)
    noStandingGrant(calls)
  })

  // Guard: unknown preset (no DB calls, no minterRank needed)
  it('returns ok:false + unknown_preset for an unrecognised preset id', async () => {
    const { env } = makeMintEnv()
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'hacker', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('unknown_preset')
  })

  // Guard: inactive / missing member
  it('returns ok:false + member_not_found when member row is null', async () => {
    const { env } = makeMintEnv({ member: null })
    const result = await mintScopedKey(env, { memberId: 'ghost', presetId: 'admin', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('member_not_found')
  })

  // Guard: squad preset requires scope_id
  it('returns scope_id_required_for_squad_preset when scope_id is null for squad preset', async () => {
    const { env } = makeMintEnv({ member: { id: 'm1' } })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: null, minterRank: 4 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('scope_id_required_for_squad_preset')
  })

  // Guard: tenant-scope — squad_id must exist in this pot's DB
  it('returns ok:false + squad_not_found when squad does not exist in this pot', async () => {
    const { env } = makeMintEnv({ member: { id: 'm1' }, squad: null })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 'foreign-squad-uuid', minterRank: 4 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('squad_not_found')
  })

  // Show-once discipline: raw is on the result, not stored separately
  it('show-once: raw token is returned on result and is a mupot_ prefixed string', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'member' }],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 's1', minterRank: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // The raw token is our only access to the plaintext — it must start with mupot_
    expect(result.raw).toMatch(/^mupot_[0-9a-f]{64}$/)
  })

  // A member holding MORE than the preset (lead >= observer) still mints — and still
  // writes no standing grant (the token carries the member's own authority).
  it('mints (no principal write) when the member holds a HIGHER capability than the preset', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'lead' }],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'observer', scopeId: 's1', minterRank: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // No INSERT to the principal — mint never grants.
    expect(calls.some((c) => c.sql.includes('INTO capabilities'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('INTO gate_grants'))).toBe(false)
  })

  // Token label encodes the preset id for the audit trail
  it('token label encodes preset id and scope_id for audit trail', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 'squad-abc' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 'squad-abc', capability: 'member' }],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 'squad-abc', minterRank: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.label).toContain('[preset:sales-rep')
    expect(result.label).toContain('squad-abc')
  })

  // Org preset: label has no scope segment (null scope)
  it('label for org preset has no scope_id segment', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm2' },
      grants: [{ member_id: 'm2', scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const result = await mintScopedKey(env, { memberId: 'm2', presetId: 'admin', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.label).toBe('[preset:admin]')
  })

  // ── preset rank-ceiling tests (mupot#1330/#1337-era: preset must be < minterRank) ──

  // (1) admin minting admin preset → 403 (rank_ceiling: 4 >= 4)
  it('rank_ceiling: admin (rank 4) cannot mint admin preset (rank 4)', async () => {
    const { env } = makeMintEnv()
    // rank_ceiling fires before any DB access — no fixtures needed
    const result = await mintScopedKey(env, {
      memberId: 'm-admin',
      presetId: 'admin',
      scopeId: null,
      minterRank: 4,  // admin rank
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('rank_ceiling')
  })

  // (2) owner minting admin preset → OK (rank 4 < 5), member holds admin@org
  it('rank_ceiling: owner (rank 5) CAN mint admin preset (rank 4)', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      grants: [{ member_id: 'm1', scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'admin',
      scopeId: null,
      minterRank: 5,  // owner rank
    })
    expect(result.ok).toBe(true)
  })

  // (3) admin minting sales-rep (member, rank 2) → OK; admin minting observer (rank 1) → OK
  it('rank_ceiling: admin (rank 4) can mint sales-rep (member, rank 2)', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'member' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep',
      scopeId: 's1',
      minterRank: 4,  // admin rank
    })
    expect(result.ok).toBe(true)
  })

  it('rank_ceiling: admin (rank 4) can mint observer preset (rank 1)', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'observer' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
  })

  // (4) attest-not-grant: preset needs MORE than the member holds → refuse, never upgrade.
  //     (Old behavior: mint silently upgraded observer→member. New: refuse.)
  it('attest: sales-rep (member) refused when member holds only observer@s1 — never upgrades', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'observer' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep',  // role=member (rank 2) > observer (rank 1)
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('member_lacks_capability')
    // Never upgrades the principal, never mints on refusal.
    expect(calls.some((c) => c.sql.includes('INTO capabilities'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('INTO member_tokens'))).toBe(false)
  })

  // (5) member holds MORE than the preset (lead >= observer) → mint OK, no principal write.
  it('attest: observer preset mints when member holds lead@s1, writing no standing grant', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'lead' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',  // role=observer (rank 1) <= lead (rank 3)
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(calls.some((c) => c.sql.includes('INTO capabilities'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('INTO gate_grants'))).toBe(false)
  })

  // ── mupot#1453: TARGET-rank ceiling (the member's REAL standing, not the preset) ──

  it('target_rank_ceiling: admin (rank 4) refused minting for a member who globally holds owner (rank 5), even at a low preset', async () => {
    const { env, calls } = makeMintEnv({
      member: { id: 'm1' },
      // The target's real standing is org→owner (rank 5) — on a DIFFERENT
      // scope than the one being minted for. resolveCapabilities is global,
      // so this must be caught even though the preset itself is 'observer'.
      grants: [{ member_id: 'm1', scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',
      scopeId: null,
      minterRank: 4, // admin
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('target_rank_ceiling')
    // Refused before any scope validation or mint — no token minted.
    expect(calls.some((c) => c.sql.includes('INTO member_tokens'))).toBe(false)
    noStandingGrant(calls)
  })

  it('target_rank_ceiling: admin (rank 4) refused minting for a member whose ONLY standing is the legacy role plane (owner, rank 5)', async () => {
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      grants: [], // zero capability rows — bootstrap-owner shape
      memberEmail: { email: 'owner@x.test' },
      userRole: { role: 'owner' },
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',
      scopeId: null,
      minterRank: 4,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('target_rank_ceiling')
  })

  it('target_rank_ceiling: equal rank (target == minter) is NOT refused by this ceiling (strict >)', async () => {
    // Target's global rank (admin, 4) equals the minter's rank (4) exactly.
    // exceedsTargetRankCeiling's HTTP sibling uses a strict `>` — this must
    // match, or an admin could never mint even a low preset for a peer admin.
    const { env } = makeMintEnv({
      member: { id: 'm1' },
      squad: { id: 's1' },
      squadDepartmentId: { department_id: null },
      grants: [
        { member_id: 'm1', scope_type: 'org', scope_id: null, capability: 'admin' },
        { member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'admin' },
      ],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep', // rank 2, < minterRank 4 — preset ceiling passes
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
  })
})

// ── 4. Enforcement status documentation ───────────────────────────────────────
// These tests assert the documented state of capability enforcement, not a desired
// future state. They catch regressions if someone silently changes the preset shape.

describe('enforcement status (documented)', () => {
  it('sales-rep denies list contains the key surfaces documented as rank-only-today', () => {
    const p = findPreset('sales-rep')!
    // These are the surfaces named in the PR note that are policy-only today.
    expect(p.denies).toContain('mcpwp:write')
    expect(p.denies).toContain('budget:write')
    expect(p.denies).toContain('admin')
    // Granular route-level gates for outreach:send-gated are pending follow-up.
    expect(p.allows).toContain('outreach:send-gated')
    expect(p.denies).toContain('outreach:send-ungated')
  })

  it('admin preset caps at admin rank (never owner) — the ceiling for API-key minting', () => {
    const p = findPreset('admin')!
    expect(p.role).not.toBe('owner')
    expect(p.role).toBe('admin')
  })
})

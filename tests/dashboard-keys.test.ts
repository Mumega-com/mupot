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
// DB call order (per mintScopedKey):
//   1. .first() — member exists check
//   2. .first() — squad/dept exists check (only for squad/department scope)
//   3. .first() — existing capability read (rank-max upsert gate)
//   4. .run()   — INSERT OR REPLACE capabilities (skipped if existing rank >=)
//   5. .run()   — INSERT member_tokens
//
// minterRank values used in tests:
//   owner=5, admin=4, lead=3, member=2, observer=1
//   admin minting sales-rep(member,2): minterRank=4, presetRank=2 → 2<4 → OK
//   owner minting admin(admin,4):      minterRank=5, presetRank=4 → 4<5 → OK
//   admin minting admin(admin,4):      minterRank=4, presetRank=4 → 4>=4 → rank_ceiling
//   admin minting observer(observer,1):minterRank=4, presetRank=1 → 1<4 → OK

describe('mintScopedKey', () => {
  // Happy path: sales-rep (squad scope), admin minter (rank 4 > member rank 2)
  it('returns ok:true + raw token for a valid sales-rep mint', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm1' },  // member exists check
        { id: 's1' },  // squad exists check
        null,          // no existing capability grant on this scope
      ],
      runChanges: [1, 1],  // INSERT OR REPLACE capabilities, INSERT member_tokens
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
    expect(result.grantUnchanged).toBeFalsy()
    // capability INSERT must use the correct scope values
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.binds[2]).toBe('squad')   // scope_type
    expect(capInsert!.binds[3]).toBe('s1')      // scope_id
    expect(capInsert!.binds[4]).toBe('member')  // capability
  })

  // Happy path: admin preset (org scope), owner minter (rank 5 > admin rank 4)
  it('mints org-scope admin preset correctly (scope_id null)', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm2' },  // member exists
        null,          // no existing capability grant (no squad check for org preset)
      ],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm2',
      presetId: 'admin',
      scopeId: null,
      minterRank: 5,  // owner
    })
    expect(result.ok).toBe(true)
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))!
    expect(capInsert.binds[2]).toBe('org')
    expect(capInsert.binds[3]).toBeNull()
    expect(capInsert.binds[4]).toBe('admin')
  })

  // Happy path: observer preset (squad scope), admin minter (rank 4 > observer rank 1)
  it('mints observer preset correctly', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm3' },
        { id: 's2' },
        null,  // no existing capability
      ],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm3',
      presetId: 'observer',
      scopeId: 's2',
      minterRank: 4,  // admin
    })
    expect(result.ok).toBe(true)
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))!
    expect(capInsert.binds[4]).toBe('observer')
  })

  // Guard: unknown preset (no DB calls, no minterRank needed)
  it('returns ok:false + unknown_preset for an unrecognised preset id', async () => {
    const { env } = makeEnv()
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'hacker', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('unknown_preset')
  })

  // Guard: inactive / missing member
  it('returns ok:false + member_not_found when member row is null', async () => {
    const { env } = makeEnv({
      firstResults: [null], // member not found
    })
    const result = await mintScopedKey(env, { memberId: 'ghost', presetId: 'admin', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('member_not_found')
  })

  // Guard: squad preset requires scope_id
  it('returns scope_id_required_for_squad_preset when scope_id is null for squad preset', async () => {
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: null, minterRank: 4 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('scope_id_required_for_squad_preset')
  })

  // Guard: tenant-scope — squad_id must exist in this pot's DB
  it('returns ok:false + squad_not_found when squad does not exist in this pot', async () => {
    const { env } = makeEnv({
      firstResults: [
        { id: 'm1' },  // member found
        null,          // squad NOT found — tenant-scope guard
      ],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 'foreign-squad-uuid', minterRank: 4 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('squad_not_found')
  })

  // Show-once discipline: raw is on the result, not stored separately
  it('show-once: raw token is returned on result and is a mupot_ prefixed string', async () => {
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }, { id: 's1' }, null],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 's1', minterRank: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // The raw token is our only access to the plaintext — it must start with mupot_
    expect(result.raw).toMatch(/^mupot_[0-9a-f]{64}$/)
  })

  // Rank-max upsert: existing higher grant is preserved (downgrade protection)
  it('skips the capability INSERT and sets grantUnchanged when existing rank is higher', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm1' },                // member exists
        { id: 's1' },                // squad exists
        { capability: 'lead' },      // existing grant is lead (rank 3) — higher than observer (rank 1)
      ],
      runChanges: [1],               // only the token INSERT runs (no cap INSERT)
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'observer', scopeId: 's1', minterRank: 4 })
    // Token still minted (the key is still valid), but grant was not downgraded
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.grantUnchanged).toBe(true)
    // No INSERT OR REPLACE should have run for capabilities
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))
    expect(capInsert).toBeUndefined()
  })

  // Token label encodes the preset id for the audit trail
  it('token label encodes preset id and scope_id for audit trail', async () => {
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }, { id: 'squad-abc' }, null],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, { memberId: 'm1', presetId: 'sales-rep', scopeId: 'squad-abc', minterRank: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.label).toContain('[preset:sales-rep')
    expect(result.label).toContain('squad-abc')
  })

  // Org preset: label has no scope segment (null scope)
  it('label for org preset has no scope_id segment', async () => {
    const { env } = makeEnv({
      firstResults: [{ id: 'm2' }, null],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, { memberId: 'm2', presetId: 'admin', scopeId: null, minterRank: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.label).toBe('[preset:admin]')
  })

  // ── NEW: rank-ceiling tests (the BLOCK fix) ──────────────────────────────────

  // (1) admin minting admin preset → 403 (rank_ceiling: 4 >= 4)
  it('rank_ceiling: admin (rank 4) cannot mint admin preset (rank 4)', async () => {
    const { env } = makeEnv()
    // rank_ceiling fires before any DB access — no firstResults needed
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

  // (2) owner minting admin preset → OK (rank 4 < 5)
  it('rank_ceiling: owner (rank 5) CAN mint admin preset (rank 4)', async () => {
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }, null],
      runChanges: [1, 1],
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
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }, { id: 's1' }, null],
      runChanges: [1, 1],
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
    const { env } = makeEnv({
      firstResults: [{ id: 'm1' }, { id: 's1' }, null],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
  })

  // (4) rank-max upsert: sales-rep (member, rank 2) over existing observer (rank 1) → grant upgraded
  it('rank-max upsert: sales-rep (member, rank 2) over existing observer (rank 1) → grant upgraded', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm1' },              // member exists
        { id: 's1' },              // squad exists
        { capability: 'observer' }, // existing grant is observer (rank 1) — lower than member (rank 2)
      ],
      runChanges: [1, 1],
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'sales-rep',  // role=member (rank 2)
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // Grant was upgraded — grantUnchanged should be false
    expect(result.grantUnchanged).toBeFalsy()
    // INSERT OR REPLACE should have run (upgrading observer → member)
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.binds[4]).toBe('member')
  })

  // (5) observer over existing lead → stays lead (downgrade protection, grantUnchanged=true)
  it('rank-max upsert: observer (rank 1) over existing lead (rank 3) → stays lead, grantUnchanged=true', async () => {
    const { env, calls } = makeEnv({
      firstResults: [
        { id: 'm1' },           // member exists
        { id: 's1' },           // squad exists
        { capability: 'lead' }, // existing grant is lead (rank 3) — higher than observer (rank 1)
      ],
      runChanges: [1],          // only token INSERT runs
    })
    const result = await mintScopedKey(env, {
      memberId: 'm1',
      presetId: 'observer',  // role=observer (rank 1)
      scopeId: 's1',
      minterRank: 4,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.grantUnchanged).toBe(true)
    // No INSERT OR REPLACE for capabilities — downgrade blocked
    const capInsert = calls.find((c) => c.sql.includes('INSERT OR REPLACE INTO capabilities'))
    expect(capInsert).toBeUndefined()
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

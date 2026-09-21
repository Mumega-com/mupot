// mupot#1453 — target-rank ceiling on the dashboard scoped-key mint.
//
// mintScopedKey's preset-rank check (mupot#1330/#1337-era) only bounds the
// LABEL a minter may pick — it says nothing about the MEMBER the key is
// minted for. The mint always resolves the token to the TARGET's own
// capabilities at auth time (the S1 "attest, never grant" fix), so a target
// whose REAL standing (across every scope, or the legacy role plane) already
// outranks the minter must be refused regardless of which lower preset was
// picked — mirroring the sibling HTTP route's guard (POST
// /api/members/:id/tokens, mupot#1337, src/members/index.ts's
// targetRankCeiling). Without this, an org admin (rank 4) could mint an
// 'observer' preset key for a member who separately holds org→owner and
// authenticate as owner.
//
// Run against the FULL committed migration chain (tests/helpers/migrations.ts)
// — a hand-built schema would test a database production does not have.
import { describe, expect, it } from 'vitest'
import { mintScopedKey } from '../src/dashboard/keys'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'target-ceiling-tenant'

function addMember(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  opts: { email?: string | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
  ).run(id, TENANT, opts.email ?? null, id)
}

function addSquad(sqlite: SqliteD1Harness['sqlite'], id: string, deptId: string): void {
  sqlite.prepare(
    `INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)`,
  ).run(deptId, deptId, deptId)
  sqlite.prepare(
    `INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)`,
  ).run(id, deptId, id, id)
}

function grantCapability(
  sqlite: SqliteD1Harness['sqlite'],
  memberId: string,
  scopeType: 'org' | 'squad' | 'department',
  scopeId: string | null,
  capability: string,
): void {
  sqlite.prepare(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`grant-${memberId}-${scopeType}-${scopeId ?? 'org'}-${capability}`, memberId, scopeType, scopeId, capability)
}

function tokenCount(sqlite: SqliteD1Harness['sqlite'], memberId: string): number {
  const row = sqlite.prepare(
    `SELECT count(*) AS n FROM member_tokens WHERE member_id = ?`,
  ).get(memberId) as { n: number }
  return row.n
}

describe('mintScopedKey — target-rank ceiling (mupot#1453), real SQLite D1', () => {
  it('admin (rank 4) refused minting for a member who globally holds org->owner, zero token rows written', async () => {
    const harness = createSqliteD1()
    try {
      applyAllMigrations(harness.sqlite)
      const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      addMember(harness.sqlite, 'target-owner')
      // Target's REAL standing: org owner (rank 5) — unrelated to the squad
      // the (lower) preset targets.
      grantCapability(harness.sqlite, 'target-owner', 'org', null, 'owner')
      addSquad(harness.sqlite, 'squad-1', 'dept-1')

      const result = await mintScopedKey(env, {
        memberId: 'target-owner',
        presetId: 'sales-rep', // role=member, rank 2 — well under the minter's rank 4
        scopeId: 'squad-1',
        minterRank: 4, // admin
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected refusal')
      expect(result.error).toBe('target_rank_ceiling')
      expect(tokenCount(harness.sqlite, 'target-owner')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('admin (rank 4) mints for a member whose global rank is member (rank 2) — allowed', async () => {
    const harness = createSqliteD1()
    try {
      applyAllMigrations(harness.sqlite)
      const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      addSquad(harness.sqlite, 'squad-2', 'dept-2')
      addMember(harness.sqlite, 'target-member')
      grantCapability(harness.sqlite, 'target-member', 'squad', 'squad-2', 'member')

      const result = await mintScopedKey(env, {
        memberId: 'target-member',
        presetId: 'sales-rep', // role=member, rank 2
        scopeId: 'squad-2',
        minterRank: 4, // admin
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected success')
      expect(tokenCount(harness.sqlite, 'target-member')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('owner (rank 5) mints for a member holding org->admin (rank 4) — allowed', async () => {
    const harness = createSqliteD1()
    try {
      applyAllMigrations(harness.sqlite)
      const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      addMember(harness.sqlite, 'target-admin')
      grantCapability(harness.sqlite, 'target-admin', 'org', null, 'admin')

      const result = await mintScopedKey(env, {
        memberId: 'target-admin',
        presetId: 'admin', // role=admin, rank 4 — strictly under the owner minter's rank 5
        scopeId: null,
        minterRank: 5, // owner
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected success')
      expect(tokenCount(harness.sqlite, 'target-admin')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('refuses via the LEGACY ROLE plane too: a target with zero capability rows but users.role=owner', async () => {
    const harness = createSqliteD1()
    try {
      applyAllMigrations(harness.sqlite)
      const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      addMember(harness.sqlite, 'bootstrap-owner', { email: 'owner@target-ceiling.test' })
      // No capabilities row at all — the "org owner characteristically holds
      // zero capability rows" shape (capability.ts's own documented case).
      // Standing lives entirely on users.role.
      harness.sqlite.prepare(
        `INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'owner', datetime('now'))`,
      ).run('user-bootstrap-owner', 'owner@target-ceiling.test')
      addSquad(harness.sqlite, 'squad-3', 'dept-3')

      const result = await mintScopedKey(env, {
        memberId: 'bootstrap-owner',
        presetId: 'sales-rep',
        scopeId: 'squad-3',
        minterRank: 4, // admin
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected refusal')
      expect(result.error).toBe('target_rank_ceiling')
      expect(tokenCount(harness.sqlite, 'bootstrap-owner')).toBe(0)
    } finally {
      harness.close()
    }
  })
})

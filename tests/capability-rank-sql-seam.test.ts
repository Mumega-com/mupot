// tests/capability-rank-sql-seam.test.ts — mupot#1551 round 2 (Athena BLOCK,
// P0 on PR #1559).
//
// `currentMemberRankOnScope` (JS, src/auth/capability.ts) and
// `currentMemberRankAtLeastSql` (its SQL mirror, same file) must agree on
// every scope shape they cover — the SQL version exists SPECIFICALLY so a
// write-time re-check (acceptInvite's member + capabilities INSERTs,
// src/members/index.ts) can close a race a JS-only pre-check cannot. If the
// two ever computed a DIFFERENT answer, that race-closing guard would
// silently enforce the WRONG bar. This file seeds one shared fixture per
// scenario, runs BOTH the JS function and the SQL fragment against the
// SAME rows, and asserts they agree at every rank threshold 1..5 — proof by
// matching behavior, not by reading the two implementations side by side.
//
// Also pins two specific survivor properties from the same round:
//   M4 — the legacy role-plane rank must NOT cover a home squad (a
//        role-plane-only owner is rank 0 there, not 5).
//   M5 — the legacy role-plane rank MUST cover org and department scope (a
//        role-plane-only owner — zero capability rows, `users.role` =
//        'owner' — must still resolve to rank 5 there). This is the exact
//        shape mupot's Shadi-compat note on PR #1559 depends on: inviter
//        14136dec is active, org OWNER, with the invite redeeming under the
//        re-check — if this ever regressed, that exact invite would start
//        refusing.

import { afterEach, describe, expect, it } from 'vitest'
import { currentMemberRankOnScope, currentMemberRankAtLeastSql } from '../src/auth/capability'
import type { Env, CapabilityScopeType } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const RANKS = [1, 2, 3, 4, 5] as const

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot' } as unknown as Env
}

/** Evaluate currentMemberRankAtLeastSql for one threshold, against the
 *  SAME harness currentMemberRankOnScope was (or will be) run against. */
async function sqlSaysAtLeast(
  env: Env,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  memberId: string,
  requiredRank: number,
): Promise<boolean> {
  const fragment = currentMemberRankAtLeastSql(scopeType, {
    inviterIdParam: '?1',
    scopeIdParam: '?2',
    requiredRankParam: '?3',
  })
  const row = await env.DB.prepare(`SELECT (${fragment}) AS ok`)
    .bind(memberId, scopeId, requiredRank)
    .first<{ ok: number }>()
  return row?.ok === 1
}

async function assertJsAndSqlAgree(
  env: Env,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  memberId: string,
  label: string,
): Promise<void> {
  const jsRank = await currentMemberRankOnScope(env, memberId, scopeType, scopeId)
  for (const threshold of RANKS) {
    const sqlOk = await sqlSaysAtLeast(env, scopeType, scopeId, memberId, threshold)
    const jsOk = jsRank >= threshold
    expect(sqlOk, `${label}: threshold ${threshold} — JS rank=${jsRank}, SQL said ${sqlOk}`).toBe(jsOk)
  }
}

function baseHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('squad-web', 'dept-a', 'squad-web', 'Web Squad', 'work'),
      ('squad-home', 'dept-a', 'squad-home', 'Home', 'home');
  `)
  return harness
}

describe('mupot#1551 round 2 — currentMemberRankOnScope / currentMemberRankAtLeastSql seam', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('no standing anywhere — both agree rank 0 on org/department/squad', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'org', null, 'm', 'no standing / org')
    await assertJsAndSqlAgree(env, 'department', 'dept-a', 'm', 'no standing / department')
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'no standing / squad')
  })

  it('org-scope admin grant covers org, department, and squad (inheritance)', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'org', NULL, 'admin');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'org', null, 'm', 'org-admin / org')
    await assertJsAndSqlAgree(env, 'department', 'dept-a', 'm', 'org-admin / department')
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'org-admin / work squad')
  })

  it('org-scope grant does NOT cover a home squad', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'org', NULL, 'owner');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-home', 'm', 'org-owner / home squad')
    const rank = await currentMemberRankOnScope(env, 'm', 'squad', 'squad-home')
    expect(rank).toBe(0)
  })

  it('department-scope grant covers ITS squad, not a home squad, not other departments', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Other');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-other-dept', 'dept-b', 'other', 'Other', 'work');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'department', 'dept-a', 'admin');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'department', 'dept-a', 'm', 'dept-admin / own department')
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'dept-admin / own department squad')
    await assertJsAndSqlAgree(env, 'squad', 'squad-home', 'm', 'dept-admin / home squad')
    await assertJsAndSqlAgree(env, 'squad', 'squad-other-dept', 'm', 'dept-admin / OTHER department squad')
    await assertJsAndSqlAgree(env, 'department', 'dept-b', 'm', 'dept-admin / OTHER department')
  })

  it('exact squad grant covers only that squad — including a home squad (exact match, not inheritance)', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'squad', 'squad-home', 'admin');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-home', 'm', 'exact home-squad grant')
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'exact home-squad grant / different squad')
    await assertJsAndSqlAgree(env, 'org', null, 'm', 'exact home-squad grant / org (no bubble-up)')
  })

  it('channel_capability_grants — exact squad match, never a home squad even exact', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO channel_bindings (id, platform, external_channel_id, squad_id)
        VALUES ('bind-1', 'discord', 'ext-1', 'squad-web');
      INSERT INTO channel_capability_grants (id, binding_id, member_id, squad_id, capability)
        VALUES ('ccg-1', 'bind-1', 'm', 'squad-web', 'lead');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'channel grant / its own squad')
  })

  it('M4 (survivor pin): role-plane-only owner (zero grant rows) is rank 0 on a HOME squad', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'roleonly@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO users (id, email, role) VALUES ('u1', 'roleonly@pot.test', 'owner');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-home', 'm', 'role-only owner / home squad')
    const rank = await currentMemberRankOnScope(env, 'm', 'squad', 'squad-home')
    expect(rank).toBe(0)
  })

  it('M4 (survivor pin, work squad contrast): the SAME role-only owner IS rank 5 on a WORK squad', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'roleonly@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO users (id, email, role) VALUES ('u1', 'roleonly@pot.test', 'owner');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-web', 'm', 'role-only owner / work squad')
    const rank = await currentMemberRankOnScope(env, 'm', 'squad', 'squad-web')
    expect(rank).toBe(5)
  })

  it('M5 (survivor pin): role-plane-only owner (zero grant rows) is rank 5 on ORG and DEPARTMENT scope', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'roleonly@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO users (id, email, role) VALUES ('u1', 'roleonly@pot.test', 'owner');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'org', null, 'm', 'role-only owner / org')
    await assertJsAndSqlAgree(env, 'department', 'dept-a', 'm', 'role-only owner / department')
    const orgRank = await currentMemberRankOnScope(env, 'm', 'org', null)
    const deptRank = await currentMemberRankOnScope(env, 'm', 'department', 'dept-a')
    expect(orgRank).toBe(5)
    expect(deptRank).toBe(5)
  })

  it('role-plane admin (not owner) resolves to rank 4, not 5, on org scope', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'roleadmin@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO users (id, email, role) VALUES ('u1', 'roleadmin@pot.test', 'admin');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'org', null, 'm', 'role-only admin / org')
    const rank = await currentMemberRankOnScope(env, 'm', 'org', null)
    expect(rank).toBe(4)
  })

  it('unknown/deleted squad row fails closed — both agree rank 0', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'org', NULL, 'owner');
    `)
    const env = envFor(harness)
    await assertJsAndSqlAgree(env, 'squad', 'squad-does-not-exist', 'm', 'unknown squad')
    const rank = await currentMemberRankOnScope(env, 'm', 'squad', 'squad-does-not-exist')
    expect(rank).toBe(0)
  })

  it('lead (below admin) on a squad — agrees at every threshold, including the admin/lead boundary', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('m', 'm@pot.test', 'M', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c', 'm', 'squad', 'squad-web', 'lead');
    `)
    await assertJsAndSqlAgree(envFor(harness), 'squad', 'squad-web', 'm', 'squad-lead')
  })
})

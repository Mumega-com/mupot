import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { membersApp } = await import('../src/members')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const AGENT_ID = 'agent-1'
const MEMBER_ID = 'member-1'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'

function createHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD_ID}', 'dept-1', 'home', 'Home'),
      ('${TARGET_SQUAD_ID}', 'dept-1', 'target', 'Target');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Agent Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-07-24T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('grant-home', '${MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');
  `)
  return harness
}

function capabilityRequest(body: Record<string, unknown>): Request {
  return new Request(`https://pot.example/members/${MEMBER_ID}/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /members/:id/capabilities bound-agent delegation', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createHarness()
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    authState.current = {
      userId: 'owner-1',
      email: 'owner@example.test',
      role: 'owner',
      tenant: TENANT,
    }
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('delegates bound-member squad grant and revoke through the synchronized writer', async () => {
    const granted = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
      capability: 'lead',
    }), env)
    expect(granted.status).toBe(201)
    await expect(granted.json()).resolves.toMatchObject({
      action: 'grant',
      result: 'created',
      grant: {
        member_id: MEMBER_ID,
        scope_id: TARGET_SQUAD_ID,
        capability: 'lead',
      },
    })
    expect(harness.sqlite.prepare(
      'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'lead' })
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'lead' })

    const revoked = await membersApp.fetch(capabilityRequest({
      action: 'revoke',
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
    }), env)
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({
      member_id: MEMBER_ID,
      action: 'revoke',
      result: 'removed',
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
  })

  it('refuses non-squad grants for a canonical bound member', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'org',
      capability: 'member',
    }), env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'agent_capability_scope_unsupported',
    })
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ? AND scope_type = 'org'",
    ).get(MEMBER_ID)).toEqual({ n: 0 })
  })

  it('allows a bound member home escalation to lead (ceiling removed per Hadi directive 2026-08-09)', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: HOME_SQUAD_ID,
      capability: 'lead',
    }), env)
    expect(response.status).toBe(200)
  })

  it('refuses the unsupported owner rank for bound-agent squad access', async () => {
    const response = await membersApp.fetch(capabilityRequest({
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
      capability: 'owner',
    }), env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_agent_capability',
      allowed: ['observer', 'member', 'lead', 'admin'],
    })
  })
})

// ── #1337: TARGET-rank ceiling on POST /members/:id/capabilities ──────────────
//
// The pre-existing ceiling guards the capability being GRANTED. It never looked
// at what the target ALREADY HOLDS, so an org admin could remove or demote the
// org OWNER. Both reachable paths are covered here because both DELETE the
// target's existing row:
//
//   revoke  — DELETEs by (member_id, scope_type, scope_id), not by capability
//   grant   — upsertCapabilityGrant is DELETE-then-INSERT on the same key, so
//             granting a LOWER capability deletes the higher one. The grant
//             ceiling cannot catch that: rank('member') is BELOW the actor's.
//
// Fixtures use the REAL migration chain (createHarness above), and every
// assertion re-reads the row rather than trusting the response body.
describe('POST /members/:id/capabilities — target-rank ceiling (#1337)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const OWNER_MEMBER = 'member-owner'
  const ADMIN_MEMBER = 'member-admin'
  const PEER_ADMIN = 'member-peer-admin'
  const SQUAD_OWNER_MEMBER = 'member-squad-owner'

  function ownerCapabilityRequest(target: string, body: Record<string, unknown>): Request {
    return new Request(`https://pot.example/members/${target}/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function orgCapabilityOf(memberId: string): { capability: string } | undefined {
    return harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'org' AND scope_id IS NULL`,
    ).get(memberId) as { capability: string } | undefined
  }

  beforeEach(() => {
    harness = createHarness()
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES
        ('${OWNER_MEMBER}', 'The Owner', 'active', '${TENANT}'),
        ('${ADMIN_MEMBER}', 'An Admin', 'active', '${TENANT}'),
        ('${PEER_ADMIN}', 'Peer Admin', 'active', '${TENANT}'),
        ('${SQUAD_OWNER_MEMBER}', 'Squad Owner Elsewhere', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner', '${OWNER_MEMBER}', 'org', NULL, 'owner'),
        ('cap-admin', '${ADMIN_MEMBER}', 'org', NULL, 'admin'),
        ('cap-peer',  '${PEER_ADMIN}',  'org', NULL, 'admin'),
        -- mupot#1411 P0-1: this member holds NOTHING on 'org' (the scope
        -- suspend/mint act on) but outranks the acting admin via a squad
        -- grant on an UNRELATED squad — exactly the case the pre-#1411
        -- per-scope-only ceiling could not see.
        ('cap-squad-owner-elsewhere', '${SQUAD_OWNER_MEMBER}', 'squad', '${TARGET_SQUAD_ID}', 'owner');
    `)
    // The ACTOR is an org admin, not an owner. role is deliberately 'member' so
    // standing comes from the capability grant, which is the plane that matters.
    authState.current = {
      userId: 'admin-user',
      email: 'admin@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: ADMIN_MEMBER,
      capabilities: [
        { member_id: ADMIN_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
    } as AuthContext
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  it('refuses an admin REVOKING the org owner, and the owner row survives', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(OWNER_MEMBER, {
      action: 'revoke',
      scope_type: 'org',
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // The row is what matters, not the status code.
    expect(orgCapabilityOf(OWNER_MEMBER)).toEqual({ capability: 'owner' })
  })

  it('refuses an admin DEMOTING the org owner via a lower grant — the path the grant ceiling cannot see', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(OWNER_MEMBER, {
      scope_type: 'org',
      capability: 'member',
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(orgCapabilityOf(OWNER_MEMBER)).toEqual({ capability: 'owner' })
  })

  it('still allows an admin to affect a PEER admin — the guard is about rank inversion, not peers', async () => {
    const res = await membersApp.fetch(ownerCapabilityRequest(PEER_ADMIN, {
      action: 'revoke',
      scope_type: 'org',
    }), env)

    expect(res.status).toBe(200)
    expect(orgCapabilityOf(PEER_ADMIN)).toBeUndefined()
  })

  it('refuses an admin SUSPENDING the org owner — #1330 made that lockout immediate', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${OWNER_MEMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // Re-read the row: the response body is not the evidence.
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(OWNER_MEMBER))
      .toEqual({ status: 'active' })
  })

  it('still allows an admin to suspend a PEER admin', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${PEER_ADMIN}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(200)
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(PEER_ADMIN))
      .toEqual({ status: 'suspended' })
  })

  // mupot#1411 P0-1: regression proof for the across-ALL-scopes widening on
  // the suspend/reactivate call site. The target has no 'org' grant at all —
  // a per-scope-only ceiling (the pre-#1411 shape) would query the target's
  // 'org' row, find none, and let this through. Only targetMaxRankAcrossScopes
  // (which also sees the target's 'owner' grant on an unrelated squad) can
  // refuse it. If the widening is reverted to per-scope, this test goes RED
  // (the response becomes 200 and the member is suspended).
  it('refuses an admin SUSPENDING a member who outranks them via a DIFFERENT, unrelated squad', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${SQUAD_OWNER_MEMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(SQUAD_OWNER_MEMBER))
      .toEqual({ status: 'active' })
  })

  it('refuses an admin MINTING A TOKEN for the org owner — a token authenticates AS that member, so this is rank ESCALATION', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${OWNER_MEMBER}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'escalation attempt' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    // No credential row may exist for the owner.
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(OWNER_MEMBER)).toEqual({ n: 0 })
  })

  it('still allows an admin to mint a token for a PEER admin', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${PEER_ADMIN}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ordinary' }),
    }), env)

    expect(res.status).toBe(201)
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(PEER_ADMIN)).toEqual({ n: 1 })
  })

  // mupot#1411 P0-1: regression proof for the across-ALL-scopes widening on
  // the token-mint call site. Same shape as the suspend proof above — the
  // target has no 'org' grant, only an 'owner' grant on an unrelated squad,
  // so only targetMaxRankAcrossScopes (not a per-scope query) can see it
  // outranks the acting org admin. Minting a token here would hand out a
  // credential authenticating AS a principal who outranks the actor.
  it('refuses an admin MINTING A TOKEN for a member who outranks them via a DIFFERENT, unrelated squad', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${SQUAD_OWNER_MEMBER}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'escalation attempt via unrelated squad' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(SQUAD_OWNER_MEMBER)).toEqual({ n: 0 })
  })

  // ── P0-A round 4 (kasra-review, 2026-09-15): the ROLE plane, not just grants ──
  //
  // The bootstrap owner CHARACTERISTICALLY holds ZERO capability rows
  // (src/auth/index.ts:917-923) — their standing lives entirely on
  // `users.role`, bridged by email. Every test above uses a target with a
  // capability GRANT row (an org 'owner' grant, or a squad 'owner' grant on
  // an unrelated squad) — none of them would catch a regression that measures
  // only the grants plane. This member has NEITHER: no capabilities row at
  // all, only a `users` row with role='owner' sharing its email.
  const BOOTSTRAP_OWNER_MEMBER = 'member-bootstrap-owner'
  const BOOTSTRAP_OWNER_EMAIL = 'bootstrap-owner@example.test'

  function insertBootstrapOwner(): void {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${BOOTSTRAP_OWNER_MEMBER}', '${BOOTSTRAP_OWNER_EMAIL}', 'Bootstrap Owner', 'active', '${TENANT}');
      INSERT INTO users (id, email, role)
        VALUES ('user-bootstrap-owner', '${BOOTSTRAP_OWNER_EMAIL}', 'owner');
    `)
  }

  it('P0-A — refuses an admin SUSPENDING the bootstrap owner (role-plane only, zero capability rows)', async () => {
    insertBootstrapOwner()
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${BOOTSTRAP_OWNER_MEMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get(BOOTSTRAP_OWNER_MEMBER))
      .toEqual({ status: 'active' })
  })

  it('P0-A — refuses an admin MINTING A TOKEN for the bootstrap owner (role-plane only, zero capability rows)', async () => {
    insertBootstrapOwner()
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${BOOTSTRAP_OWNER_MEMBER}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'escalation attempt via role plane' }),
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(BOOTSTRAP_OWNER_MEMBER)).toEqual({ n: 0 })
  })

  it('P0-A — refuses an admin GRANTING/REVOKING a capability on the bootstrap owner (role-plane only, zero capability rows)', async () => {
    insertBootstrapOwner()
    const res = await membersApp.fetch(ownerCapabilityRequest(BOOTSTRAP_OWNER_MEMBER, {
      scope_type: 'org',
      capability: 'member',
    }), env)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
    expect(orgCapabilityOf(BOOTSTRAP_OWNER_MEMBER)).toBeUndefined()
  })

  it('P0-A — a member with NO email bridges to nothing and is never treated as elevated', async () => {
    // Absence of a bridge (no email, or an email matching no `users` row) is
    // the SAFE default (0), never an escalation — this member has real
    // capability standing (squad member) and no email at all.
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-no-email', NULL, 'No Email', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-no-email', 'member-no-email', 'squad', '${TARGET_SQUAD_ID}', 'member');
    `)
    const res = await membersApp.fetch(new Request(`https://pot.example/members/member-no-email`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)

    expect(res.status).toBe(200)
    expect(harness.sqlite.prepare('SELECT status FROM members WHERE id = ?').get('member-no-email'))
      .toEqual({ status: 'suspended' })
  })

  // ── N2 round 4 (Athena, 2026-09-15): self-exemption + symmetric quantities ──
  //
  // An org admin who ALSO holds 'owner' on one squad has a real GLOBAL
  // standing of 5, but their org-scope-LOCAL rank is only 4. Before the fix,
  // targetRankCeiling compared the target's GLOBAL rank against the actor's
  // LOCAL rank — so this exact principal, acting on THEMSELVES, was measured
  // as outranking themselves (5 > 4) and 403'd. A principal can never
  // outrank themselves; the fix makes the comparison symmetric (both sides
  // global) AND self-exempt regardless.
  const SELF_GLOBAL_OWNER_MEMBER = 'member-self-global-owner'

  it('N2 — an org admin who also holds owner on an unrelated squad may still act on THEMSELVES', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('${SELF_GLOBAL_OWNER_MEMBER}', 'Admin With Global Owner Elsewhere', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-self-global-org', '${SELF_GLOBAL_OWNER_MEMBER}', 'org', NULL, 'admin'),
        ('cap-self-global-squad', '${SELF_GLOBAL_OWNER_MEMBER}', 'squad', '${TARGET_SQUAD_ID}', 'owner');
    `)
    authState.current = {
      userId: 'self-global-owner-user',
      email: 'self-global-owner@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: SELF_GLOBAL_OWNER_MEMBER,
      capabilities: [
        { member_id: SELF_GLOBAL_OWNER_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
        { member_id: SELF_GLOBAL_OWNER_MEMBER, scope_type: 'squad', scope_id: TARGET_SQUAD_ID, capability: 'owner' },
      ],
    } as AuthContext

    // Self-suspend (then self-reactivate) succeeds.
    const suspendRes = await membersApp.fetch(new Request(`https://pot.example/members/${SELF_GLOBAL_OWNER_MEMBER}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    }), env)
    expect(suspendRes.status).toBe(200)

    harness.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = '${SELF_GLOBAL_OWNER_MEMBER}'`)

    // Self-mint succeeds.
    const mintRes = await membersApp.fetch(new Request(`https://pot.example/members/${SELF_GLOBAL_OWNER_MEMBER}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'self-mint' }),
    }), env)
    expect(mintRes.status).toBe(201)

    // Self-grant (a capability at or below the actor's own local org rank)
    // succeeds too.
    const grantRes = await membersApp.fetch(ownerCapabilityRequest(SELF_GLOBAL_OWNER_MEMBER, {
      scope_type: 'org',
      capability: 'admin',
    }), env)
    expect(grantRes.status).toBe(201)
  })
})

// ── round 4 (kasra-review, 2026-09-15): DELETE /members/:id/telegram ───────
//
// P1-A: the SELECT and the clearing UPDATE were `WHERE id = ?` alone — the
// same #1330 F2 class the suspend route already closed 40 lines above it.
// P2-B/C: unbind wrote no audit trail at all, and the ONLY negative test for
// the route's `requireCapability(orgScope, 'admin')` gate targeted a
// SQUAD-scope actor — an org-scope 'admin' -> 'observer' mutation at that
// line left the suite green (M8).
describe('DELETE /members/:id/telegram — round 4 (P1-A tenant fence, P2-B/C receipt + M8)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT_A = TENANT
  const TENANT_B = 'tenant-b'
  const ADMIN_A = 'member-unbind-admin-a'
  const TARGET_A = 'member-unbind-target-a'
  const TARGET_B = 'member-unbind-target-b'
  const ORG_OBSERVER = 'member-unbind-org-observer'

  beforeEach(() => {
    harness = createHarness()
    env = { TENANT_SLUG: TENANT_A, DB: harness.db } as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant, telegram_chat_id, telegram_bound_at) VALUES
        ('${ADMIN_A}', 'Unbind Admin A', 'active', '${TENANT_A}', NULL, NULL),
        ('${TARGET_A}', 'Unbind Target A', 'active', '${TENANT_A}', '9500000', '2026-09-14T00:00:00.000000Z'),
        ('${TARGET_B}', 'Unbind Target B', 'active', '${TENANT_B}', '9500100', '2026-09-14T00:00:00.000000Z'),
        ('${ORG_OBSERVER}', 'Org Observer', 'active', '${TENANT_A}', NULL, NULL);
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-unbind-admin-a', '${ADMIN_A}', 'org', NULL, 'admin'),
        ('cap-unbind-org-observer', '${ORG_OBSERVER}', 'org', NULL, 'observer');
    `)
    authState.current = {
      userId: 'unbind-admin-a-user',
      email: 'unbind-admin-a@example.test',
      role: 'member',
      tenant: TENANT_A,
      memberId: ADMIN_A,
      capabilities: [{ member_id: ADMIN_A, scope_type: 'org', scope_id: null, capability: 'admin' }],
    } as AuthContext
  })

  afterEach(() => {
    authState.current = null
    harness.close()
  })

  function unbindRequest(target: string): Request {
    // content-type must be set: Hono's csrf() defaults an absent content-type
    // to 'text/plain' internally, which its own form-element regex treats as
    // CSRF-sensitive and 403s with no Origin/Sec-Fetch-Site header present —
    // the same header every other state-changing request in this file sets.
    return new Request(`https://pot.example/members/${target}/telegram`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    })
  }

  it('P1-A — refuses (member_not_found, same as nonexistent) a tenant-A admin unbinding a tenant-B member', async () => {
    const res = await membersApp.fetch(unbindRequest(TARGET_B), env)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'member_not_found' })
    // The tenant-B row is untouched — not merely refused at the HTTP layer.
    expect(harness.sqlite.prepare('SELECT telegram_chat_id FROM members WHERE id = ?').get(TARGET_B))
      .toEqual({ telegram_chat_id: '9500100' })
  })

  it('P2-B/C — a successful unbind writes an append-only receipt row (actor, target, prior identity)', async () => {
    const res = await membersApp.fetch(unbindRequest(TARGET_A), env)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ member_id: TARGET_A, telegram_unbound: true })
    const receipt = harness.sqlite.prepare(
      `SELECT tenant, member_id, actor_id, prior_telegram_chat_id
         FROM telegram_unbind_receipts WHERE member_id = ?`,
    ).get(TARGET_A)
    expect(receipt).toEqual({
      tenant: TENANT_A,
      member_id: TARGET_A,
      actor_id: ADMIN_A,
      prior_telegram_chat_id: '9500000',
    })
  })

  it('P2-B/C — no receipt is written when the unbind is refused (tenant fence)', async () => {
    await membersApp.fetch(unbindRequest(TARGET_B), env)
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM telegram_unbind_receipts WHERE member_id = ?',
    ).get(TARGET_B)).toEqual({ n: 0 })
  })

  // M8: the ONLY pre-existing negative test for this route's capability gate
  // used a SQUAD-scope actor. An org-scope 'admin' -> 'observer' mutation at
  // `requireCapability(orgScope, 'admin')` therefore left the whole suite
  // green — this test is the org-scope case that mutation needs to kill.
  it('M8 — refuses an ORG-SCOPE observer (403), not merely a squad-scope non-admin', async () => {
    authState.current = {
      userId: 'unbind-org-observer-user',
      email: 'unbind-org-observer@example.test',
      role: 'member',
      tenant: TENANT_A,
      memberId: ORG_OBSERVER,
      capabilities: [{ member_id: ORG_OBSERVER, scope_type: 'org', scope_id: null, capability: 'observer' }],
    } as AuthContext

    const res = await membersApp.fetch(unbindRequest(TARGET_A), env)

    expect(res.status).toBe(403)
    expect(harness.sqlite.prepare('SELECT telegram_chat_id FROM members WHERE id = ?').get(TARGET_A))
      .toEqual({ telegram_chat_id: '9500000' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM telegram_unbind_receipts WHERE member_id = ?',
    ).get(TARGET_A)).toEqual({ n: 0 })
  })

  // N1 (Athena, 2026-09-15): POST /members/:id/tokens' member lookup was
  // unscoped by tenant — the same pre-existing #1330 F2 class this same
  // round already closed on the unbind route two tests up. A tenant-A admin
  // could mint a token (a credential that authenticates AS the member) for
  // a tenant-B member.
  it('N1 — refuses (member_not_found) a tenant-A admin minting a token for a tenant-B member', async () => {
    const res = await membersApp.fetch(new Request(`https://pot.example/members/${TARGET_B}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'cross-tenant mint attempt' }),
    }), env)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'member_not_found' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?',
    ).get(TARGET_B)).toEqual({ n: 0 })
  })
})

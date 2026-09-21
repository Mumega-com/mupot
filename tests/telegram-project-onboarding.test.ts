import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  CLAIM_INVITE_SQL,
  MEMBER_BIND_ELIGIBLE_SQL,
  MEMBER_BIND_LANDED_GUARD_SQL,
  MEMBER_BIND_UPDATE_SQL,
  createProjectInvite,
  redeemTelegramProjectInvite,
} from '../src/members/project-invites'
import { membersApp } from '../src/members'
import { handleImMessage, imApp } from '../src/im'
import { requireCapability } from '../src/auth/capability'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const VALID_PAIRING_HASH = 'a'.repeat(64)
const VALID_REQUEST_DIGEST = 'b'.repeat(64)

describe('Telegram project onboarding schema', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => {
    harness.close()
  })

  function createProjectAndSquad(): void {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name)
      VALUES ('department-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-1', 'department-1', 'telegram', 'Telegram');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-1', 'telegram-onboarding', 'Telegram onboarding', 'active'),
        ('project-2', 'other-project', 'Other project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-1', 'squad-1', 'write');
    `)
  }

  function insertProjectInvite(id: string, pairingHash = VALID_PAIRING_HASH): void {
    harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (?, ?, 'project-1', 'squad-1', ?, '2026-09-13T01:00:00Z')
    `).run(id, `${id}@example.com`, pairingHash)
  }

  it('adds project invite columns with project and squad foreign keys', () => {
    const columns = harness.sqlite
      .prepare(`SELECT name FROM pragma_table_info('invites')`)
      .all()
      .map((row) => row.name)

    expect(columns).toEqual(expect.arrayContaining([
      'project_id',
      'squad_id',
      'pairing_hash',
      'pairing_expires_at',
    ]))

    const foreignKeys = harness.sqlite
      .prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('invites')`)
      .all()
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { table: 'projects', from: 'project_id', to: 'id' },
      { table: 'squads', from: 'squad_id', to: 'id' },
    ]))
  })

  it('requires project invite fields to be jointly null or non-null and nonblank on insert', () => {
    createProjectAndSquad()

    harness.sqlite.exec(`
      INSERT INTO invites (id, email) VALUES ('legacy-invite', 'legacy@example.com')
    `)
    expect(() => harness.sqlite.exec(`
      INSERT INTO invites (id, email, project_id)
      VALUES ('partial-invite', 'partial@example.com', 'project-1')
    `)).toThrow(/project invite fields/)
    expect(() => harness.sqlite.exec(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (
        'blank-invite', 'blank@example.com', 'project-1', 'squad-1',
        '${VALID_PAIRING_HASH}', '   '
      )
    `)).toThrow(/project invite fields/)

    insertProjectInvite('complete-invite')
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id, pairing_hash, pairing_expires_at
      FROM invites WHERE id = 'complete-invite'
    `).get()).toEqual({
      project_id: 'project-1',
      squad_id: 'squad-1',
      pairing_hash: VALID_PAIRING_HASH,
      pairing_expires_at: '2026-09-13T01:00:00Z',
    })
  })

  it('enforces the project invite field set on update', () => {
    createProjectAndSquad()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email) VALUES ('invite-update', 'update@example.com')
    `)

    expect(() => harness.sqlite.exec(`
      UPDATE invites SET project_id = 'project-1' WHERE id = 'invite-update'
    `)).toThrow(/project invite fields/)

    harness.sqlite.prepare(`
      UPDATE invites
      SET project_id = 'project-1', squad_id = 'squad-1', pairing_hash = ?,
          pairing_expires_at = '2026-09-13T01:00:00Z'
      WHERE id = 'invite-update'
    `).run(VALID_PAIRING_HASH)
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id FROM invites WHERE id = 'invite-update'
    `).get()).toEqual({ project_id: 'project-1', squad_id: 'squad-1' })
  })

  it('rejects an invite insert whose existing project and squad have no access edge', () => {
    createProjectAndSquad()

    expect(() => harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (
        'mismatched-insert', 'mismatched-insert@example.com', 'project-2', 'squad-1',
        ?, '2026-09-13T01:00:00Z'
      )
    `).run(VALID_PAIRING_HASH)).toThrow(/project invite project-squad mismatch/)
  })

  it('rejects an invite update to an existing project and squad with no access edge', () => {
    createProjectAndSquad()
    insertProjectInvite('mismatched-update')

    expect(() => harness.sqlite.exec(`
      UPDATE invites
      SET project_id = 'project-2'
      WHERE id = 'mismatched-update'
    `)).toThrow(/project invite project-squad mismatch/)
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id FROM invites WHERE id = 'mismatched-update'
    `).get()).toEqual({ project_id: 'project-1', squad_id: 'squad-1' })
  })

  it('requires a project invite pairing hash to be a SHA-256 hex digest', () => {
    createProjectAndSquad()

    expect(() => insertProjectInvite('short-hash', 'a'.repeat(63)))
      .toThrow(/pairing hash/)
    expect(() => insertProjectInvite('non-hex-hash', 'g'.repeat(64)))
      .toThrow(/pairing hash/)
    expect(() => insertProjectInvite('uppercase-hash', 'ABCDEF'.repeat(10) + 'ABCD'))
      .not.toThrow()
  })

  it('requires a member-bind project invite to carry the full project field set', () => {
    createProjectAndSquad()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status)
      VALUES ('member-bind-schema', 'bind-schema@example.com', 'Bind Schema', 'active');
    `)

    // member_id alone, no project fields at all — the pre-existing "jointly
    // null or nonblank" clause already catches project_id, but member_id sat
    // outside that check before this migration; assert this specific clause,
    // not the pre-existing one, is what refuses it.
    expect(() => harness.sqlite.exec(`
      INSERT INTO invites (id, email, member_id)
      VALUES ('member-bind-no-project', 'member-bind-no-project@example.com', 'member-bind-schema')
    `)).toThrow(/project invite member bind requires the full project field set/)

    // A fully-formed project invite plus member_id is accepted.
    expect(() => harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at, member_id
      ) VALUES (
        'member-bind-complete', 'member-bind-complete@example.com', 'project-1', 'squad-1',
        ?, '2026-09-13T01:00:00Z', 'member-bind-schema'
      )
    `).run(VALID_PAIRING_HASH)).not.toThrow()

    // An UPDATE that attaches member_id to a row missing project fields is
    // refused too (the UPDATE trigger lists member_id in its OF clause).
    harness.sqlite.exec(`
      INSERT INTO invites (id, email) VALUES ('member-bind-update-target', 'member-bind-update-target@example.com')
    `)
    expect(() => harness.sqlite.exec(`
      UPDATE invites SET member_id = 'member-bind-schema' WHERE id = 'member-bind-update-target'
    `)).toThrow(/project invite member bind requires the full project field set/)
  })

  // P3 (kasra-review, 2026-09-15): member_id is a bare TEXT column with no
  // CHECK of its own — a whitespace-only value would pass every conjunct
  // above (it IS NOT NULL, and the project fields can be fully present) yet
  // resolve to no real member anywhere. The application layer already trims
  // and rejects this (isNonEmptyString in src/members/project-invites.ts),
  // but the trigger is the schema's OWN backstop against any writer that
  // bypasses the service (a direct migration, a future internal tool).
  it('requires a member-bind project invite member_id to be non-blank', () => {
    createProjectAndSquad()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status)
      VALUES ('member-bind-blank', 'bind-blank@example.com', 'Bind Blank', 'active');
    `)

    expect(() => harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at, member_id
      ) VALUES (
        'member-bind-whitespace', 'member-bind-whitespace@example.com', 'project-1', 'squad-1',
        ?, '2026-09-13T01:00:00Z', '   '
      )
    `).run(VALID_PAIRING_HASH)).toThrow(/project invite member bind requires a non-blank member_id/)

    // A real, non-blank member_id on the same shape is unaffected.
    expect(() => harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at, member_id
      ) VALUES (
        'member-bind-nonblank', 'member-bind-nonblank@example.com', 'project-1', 'squad-1',
        ?, '2026-09-13T01:00:00Z', 'member-bind-blank'
      )
    `).run(VALID_PAIRING_HASH)).not.toThrow()
  })

  it('records webhook receipts once per tenant and update id', () => {
    const insert = harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, response_text, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run(
      'tenant-a',
      'update-1',
      'telegram-user-a',
      VALID_REQUEST_DIGEST,
      'completed',
      'ok',
      '2026-09-13T00:00:00Z',
      '2026-09-13T00:00:01Z',
    )
    expect(() => insert.run(
      'tenant-a',
      'update-1',
      'telegram-user-a',
      VALID_REQUEST_DIGEST,
      'processing',
      null,
      '2026-09-13T00:00:02Z',
      null,
    )).toThrow(/UNIQUE constraint failed/)
    expect(() => insert.run(
      'tenant-b',
      'update-1',
      'telegram-user-b',
      VALID_REQUEST_DIGEST,
      'unknown',
      null,
      '2026-09-13T00:00:03Z',
      null,
    )).not.toThrow()

    expect(harness.sqlite.prepare(`
      SELECT tenant, update_id, telegram_user_id, response_text, completed_at
      FROM telegram_webhook_receipts ORDER BY tenant
    `).all()).toEqual([
      {
        tenant: 'tenant-a',
        update_id: 'update-1',
        telegram_user_id: 'telegram-user-a',
        response_text: 'ok',
        completed_at: '2026-09-13T00:00:01Z',
      },
      {
        tenant: 'tenant-b',
        update_id: 'update-1',
        telegram_user_id: 'telegram-user-b',
        response_text: null,
        completed_at: null,
      },
    ])
  })

  it('requires every webhook receipt to bind a nonblank authenticated Telegram user id', () => {
    const columns = harness.sqlite
      .prepare(`SELECT name, "notnull" FROM pragma_table_info('telegram_webhook_receipts')`)
      .all()
    expect(columns).toEqual(expect.arrayContaining([
      { name: 'telegram_user_id', notnull: 1 },
    ]))

    expect(() => harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES ('tenant-a', 'blank-user', '   ', ?, 'processing', '2026-09-13T00:00:00Z')
    `).run(VALID_REQUEST_DIGEST)).toThrow(/CHECK constraint failed/)
  })

  it('requires webhook request digests to be 64 hex characters', () => {
    const insert = harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES ('tenant-a', ?, 'telegram-user-a', ?, 'processing', '2026-09-13T00:00:00Z')
    `)

    expect(() => insert.run('short', 'a'.repeat(63))).toThrow(/CHECK constraint failed/)
    expect(() => insert.run('non-hex', 'z'.repeat(64))).toThrow(/CHECK constraint failed/)
    expect(() => insert.run('uppercase', 'ABCDEF'.repeat(10) + 'ABCD')).not.toThrow()
  })

  it.each(['processing', 'completed', 'unknown'])('accepts the %s webhook receipt state', (state) => {
    expect(() => harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES ('tenant-a', ?, 'telegram-user-a', ?, ?, '2026-09-13T00:00:00Z')
    `).run(`update-${state}`, VALID_REQUEST_DIGEST, state)).not.toThrow()
  })

  it('rejects webhook receipt states outside the durable state machine', () => {
    expect(() => harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES ('tenant-a', 'update-invalid', 'telegram-user-a', ?, 'failed', '2026-09-13T00:00:00Z')
    `).run(VALID_REQUEST_DIGEST)).toThrow(/CHECK constraint failed/)
  })
})

const TENANT = 'tenant-project-invites'

async function digestPairingCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('Telegram project invitation service', () => {
  let harness: SqliteD1Harness
  let env: Env

  const inviterAuth: AuthContext = {
    userId: 'inviter-user',
    email: 'inviter@example.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'member-inviter',
    capabilities: [{
      member_id: 'member-inviter',
      scope_type: 'squad',
      scope_id: 'squad-participants',
      capability: 'admin',
    }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name)
      VALUES ('department-delivery', 'delivery-project', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-participants', 'department-delivery', 'participants', 'Participants'),
        ('squad-unlinked', 'department-delivery', 'unlinked', 'Unlinked');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-active', 'active-project', 'Active project', 'active'),
        ('project-archived', 'archived-project', 'Archived project', 'archived'),
        ('project-decoy', 'decoy-project', 'Decoy project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('project-active', 'squad-participants', 'write'),
        ('project-decoy', 'squad-unlinked', 'write');
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-inviter', 'inviter@example.test', 'Inviter', 'active', '${TENANT}');
      -- mupot#1411 round 6 (kasra-review adversarial addendum on Athena gate
      -- efdb0b08, P2): inviterAuth's squad-admin standing above is fed
      -- directly as auth.capabilities (simulating an already-resolved
      -- session) — the REAL DB row is needed too now, because
      -- redeemTelegramProjectInvite re-derives minted_by_member_id's CURRENT
      -- squad-scope standing straight from the capabilities TABLE
      -- (currentMemberSquadRank) at redemption time, never from a
      -- caller-supplied auth object. Without this row every net-new
      -- redemption test in this block would refuse with
      -- invite_minter_authority_lost even though nothing changed — the same
      -- collateral fixture gap round 5 found and fixed for the member-bind
      -- describe block's own minter.
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-inviter-squad-admin', 'member-inviter', 'squad', 'squad-participants', 'admin');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  async function createInvite(
    email = 'participant@example.test',
    overrides: Partial<{
      project_id: string
      squad_id: string
      capability: 'owner' | 'admin' | 'lead' | 'member' | 'observer'
      expires_in_seconds: number
    }> = {},
  ) {
    return createProjectInvite(env, inviterAuth, {
      email,
      project_id: 'project-active',
      squad_id: 'squad-participants',
      capability: 'member',
      expires_in_seconds: 3600,
      ...overrides,
    })
  }

  function reserveUpdate(
    updateId: string,
    requestDigest = VALID_REQUEST_DIGEST,
    telegramUserId = 'telegram-user-unbound',
  ): void {
    harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES (?, ?, ?, ?, 'processing', ?)
    `).run(TENANT, updateId, telegramUserId, requestDigest, new Date().toISOString())
  }

  it('creates an active project invite for its exact linked squad and stores only the pairing hash', async () => {
    const result = await createInvite()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pairing_code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.value.access_scope).toEqual({
      scope_type: 'squad',
      scope_id: 'squad-participants',
      includes_all_projects_linked_to_squad: true,
    })
    expect(result.value.invite).not.toHaveProperty('pairing_hash')

    const row = harness.sqlite.prepare(`
      SELECT project_id, squad_id, pairing_hash, pairing_expires_at
      FROM invites WHERE id = ?
    `).get(result.value.invite.id) as Record<string, unknown>
    expect(row.project_id).toBe('project-active')
    expect(row.squad_id).toBe('squad-participants')
    expect(row.pairing_hash).toBe(await digestPairingCode(result.value.pairing_code))
    expect(JSON.stringify(row)).not.toContain(result.value.pairing_code)
  })

  it.each([
    ['missing project', { project_id: 'project-missing' }, 'project_not_found'],
    ['archived project', { project_id: 'project-archived' }, 'archived_project'],
    ['unlinked squad', { squad_id: 'squad-unlinked' }, 'project_squad_not_linked'],
  ] as const)('refuses a %s', async (_name, overrides, expectedError) => {
    const result = await createInvite(`${expectedError}@example.test`, overrides)
    expect(result).toEqual({ ok: false, error: expectedError })
  })

  // Athena's §2e-8 table-exhaustive requirement (Round 2 on #1472): the
  // `capabilities` table has FIVE writers gated against a home target — this
  // is the createProjectInvite one (G-FP1b point 4). A project↔squad edge
  // CAN legitimately exist for a home squad (project_squad_set is the
  // deliberately-untouched grant direction), but minting an INVITE against
  // that edge would let an arbitrary invitee redeem a standing `capabilities`
  // row on the home squad itself — refused regardless of the inviter's own
  // rank on it.
  it('refuses to mint a project invite whose linked squad is kind=home: home_scope_not_invitable', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind)
      VALUES ('squad-someones-home', 'department-delivery', 'home-someone', 'Home', 'home');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-active', 'squad-someones-home', 'write');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-inviter-home-admin', 'member-inviter', 'squad', 'squad-someones-home', 'admin');
    `)

    const before = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }

    const result = await createInvite('home-invitee@example.test', { squad_id: 'squad-someones-home' })
    expect(result).toEqual({ ok: false, error: 'home_scope_not_invitable' })

    const after = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('refuses a capability above the inviter rank on the selected squad', async () => {
    await expect(createInvite('owner@example.test', { capability: 'owner' })).resolves.toEqual({
      ok: false,
      error: 'cannot_grant_above_own_rank',
    })
  })

  // ── P1-1: the coarse org role must never widen past (or substitute for) an
  // explicit, resolved squad grant — mirroring requireCapability's own
  // restriction. Each branch uses a DIFFERENT principal from the fixture
  // inviter above, so none of these can pass by accidentally reusing its
  // admin grant.
  describe('P1-1 — squad rank never widens from the coarse role', () => {
    it('refuses an org admin with resolved-but-empty capabilities and no squad grant', async () => {
      const adminNoGrant: AuthContext = {
        userId: 'admin-no-grant-user',
        email: 'admin-no-grant@example.test',
        role: 'admin',
        tenant: TENANT,
        memberId: 'member-admin-no-grant',
        capabilities: [],
      }
      const result = await createProjectInvite(env, adminNoGrant, {
        email: 'admin-no-grant-target@example.test',
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'member',
        expires_in_seconds: 3600,
      })
      expect(result).toEqual({ ok: false, error: 'forbidden' })
    })

    it('refuses an org owner whose only resolved grant on the squad is narrower than admin', async () => {
      const ownerNarrowGrant: AuthContext = {
        userId: 'owner-narrow-user',
        email: 'owner-narrow@example.test',
        role: 'owner',
        tenant: TENANT,
        memberId: 'member-owner-narrow',
        capabilities: [{
          member_id: 'member-owner-narrow',
          scope_type: 'squad',
          scope_id: 'squad-participants',
          capability: 'observer',
        }],
      }
      const result = await createProjectInvite(env, ownerNarrowGrant, {
        email: 'owner-narrow-target@example.test',
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'owner',
        expires_in_seconds: 3600,
      })
      // Before the fix this minted an OWNER capability outright. After the fix
      // the actor's real rank on this squad is 'observer' (1), so this must
      // refuse — either at the admin floor or the grant ceiling, never ok:true.
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(['forbidden', 'cannot_grant_above_own_rank']).toContain(result.error)
      }
    })

    it('requireCapability itself still admits a legacy admin role at ORG scope with unresolved capabilities (reference, unchanged by this fix)', async () => {
      // This pins what requireCapability does TODAY at org scope so the squad-scope
      // fix above is visibly narrower than, not a copy that drifted from, the rule
      // it borrows from (src/auth/capability.ts:295-338). Unaffected by the
      // project-invites.ts change: no squad scope, no memberId resolution.
      const probe = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
      probe.use('*', async (c, next) => {
        c.set('auth', {
          userId: 'legacy-admin-user',
          email: 'legacy-admin@example.test',
          role: 'admin',
          tenant: TENANT,
          // capabilities intentionally left undefined — the pure web-login shape.
        } as AuthContext)
        await next()
      })
      probe.get('/probe', requireCapability(() => ({ type: 'org', id: null }), 'admin'), (c) => c.json({ ok: true }))

      const res = await probe.fetch(new Request('https://pot.test/probe'), env)
      expect(res.status).toBe(200)
    })

    it('P1-1 parity — refuses an org owner with no memberId on the squad scope, matching requireCapability\'s own refusal', async () => {
      // requireCapability(squad, min) 403s a non-org scope whenever the
      // principal has no memberId (src/auth/capability.ts:315-322) —
      // regardless of role, and regardless of whether capabilities were ever
      // resolved. Before the parity fix, actorRankOnSquad floored this exact
      // shape (no memberId, capabilities undefined, role owner) to
      // legacyRoleRank('owner') = 5 and minted the invite outright.
      const ownerNoMember: AuthContext = {
        userId: 'owner-no-member-user',
        email: 'owner-no-member@example.test',
        role: 'owner',
        tenant: TENANT,
        // memberId intentionally absent — the exact shape requireCapability
        // refuses for any non-org scope.
      }
      const result = await createProjectInvite(env, ownerNoMember, {
        email: 'owner-no-member-target@example.test',
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'member',
        expires_in_seconds: 3600,
      })
      expect(result).toEqual({ ok: false, error: 'forbidden' })
    })
  })

  // ── P1-3: the admin floor at project-invites.ts:254 is the SOLE gate for
  // create — every prior test used the admin fixture inviter, so a deletion of
  // that line was invisible. A real (narrower) squad grant must still refuse.
  it('P1-3 — refuses invite creation from an observer holding a real, narrower squad grant', async () => {
    const observerAuth: AuthContext = {
      userId: 'observer-user',
      email: 'observer@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-observer',
      capabilities: [{
        member_id: 'member-observer',
        scope_type: 'squad',
        scope_id: 'squad-participants',
        capability: 'observer',
      }],
    }
    // Request the SAME capability the actor already holds — with the admin
    // floor removed, this would otherwise fall straight through the "cannot
    // grant above own rank" ceiling too (observer <= observer) and succeed.
    const result = await createProjectInvite(env, observerAuth, {
      email: 'observer-target@example.test',
      project_id: 'project-active',
      squad_id: 'squad-participants',
      capability: 'observer',
      expires_in_seconds: 3600,
    })
    expect(result).toEqual({ ok: false, error: 'forbidden' })
  })

  // ── P1-2: the atomic single-use claim fence, driven directly through the
  // exact exported statement. tests/helpers/sqlite-d1.ts is synchronous
  // node:sqlite, so redeemTelegramProjectInvite's own JS pre-check always
  // agrees with a same-process, non-racing caller — no test that goes through
  // the whole function can ever see this WHERE clause refuse on its own. Only
  // driving CLAIM_INVITE_SQL directly, with a row state the pre-check never
  // saw, proves each guard independently.
  describe('P1-2 — CLAIM_INVITE_SQL fences single-use, expiry, and receipt binding', () => {
    const FENCE_TENANT = 'tenant-claim-fence'
    const FENCE_INVITE_ID = 'fence-invite'
    const FENCE_PAIRING_HASH = 'c'.repeat(64)
    const FENCE_REQUEST_DIGEST = 'd'.repeat(64)
    const FENCE_TELEGRAM_USER = 'fence-telegram-user'
    const FENCE_UPDATE_ID = 'fence-update'
    const FENCE_EMAIL = 'fence@example.test'
    const FENCE_CAPABILITY = 'member'
    let fenceHarness: SqliteD1Harness
    let fenceEnv: Env

    beforeEach(() => {
      fenceHarness = createSqliteD1()
      applyAllMigrations(fenceHarness.sqlite)
      fenceEnv = { DB: fenceHarness.db, TENANT_SLUG: FENCE_TENANT } as Env
      fenceHarness.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-fence', 'dept-fence', 'Dept Fence');
        INSERT INTO squads (id, department_id, slug, name)
        VALUES ('squad-fence', 'dept-fence', 'squad-fence', 'Squad Fence');
        INSERT INTO projects (id, slug, name, status)
        VALUES ('project-fence', 'project-fence', 'Project Fence', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-fence', 'squad-fence', 'write');
      `)
    })

    afterEach(() => {
      fenceHarness.close()
    })

    function insertFenceInvite(overrides: Partial<{ acceptedAt: string | null; expiresAt: string }> = {}): void {
      fenceHarness.sqlite.prepare(`
        INSERT INTO invites (
          id, email, capability, invited_by, project_id, squad_id,
          pairing_hash, pairing_expires_at, accepted_at
        ) VALUES (?, ?, ?, 'fence-inviter', 'project-fence', 'squad-fence', ?, ?, ?)
      `).run(
        FENCE_INVITE_ID,
        FENCE_EMAIL,
        FENCE_CAPABILITY,
        FENCE_PAIRING_HASH,
        overrides.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
        overrides.acceptedAt ?? null,
      )
    }

    function insertFenceReceipt(state = 'processing'): void {
      fenceHarness.sqlite.prepare(`
        INSERT INTO telegram_webhook_receipts (
          tenant, update_id, telegram_user_id, request_digest, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(FENCE_TENANT, FENCE_UPDATE_ID, FENCE_TELEGRAM_USER, FENCE_REQUEST_DIGEST, state, new Date().toISOString())
    }

    // Every bind value defaults to the exact value that matches the fixture
    // rows insertFenceInvite/insertFenceReceipt write, so a caller overriding
    // ONE field is testing that field's own conjunct in isolation — the same
    // shape as mutating the SQL, but proving the caller-supplied bind (not
    // the statement text) is what a mismatch is caught against.
    async function runClaim(overrides: Partial<{
      now: string
      inviteId: string
      pairingHash: string
      projectId: string
      squadId: string
      capability: string
      email: string
      tenant: string
      updateId: string
      requestDigest: string
      telegramUserId: string
    }> = {}): Promise<number> {
      const result = await fenceEnv.DB.prepare(CLAIM_INVITE_SQL).bind(
        new Date().toISOString(),
        overrides.inviteId ?? FENCE_INVITE_ID,
        overrides.pairingHash ?? FENCE_PAIRING_HASH,
        overrides.projectId ?? 'project-fence',
        overrides.squadId ?? 'squad-fence',
        overrides.capability ?? FENCE_CAPABILITY,
        overrides.email ?? FENCE_EMAIL,
        overrides.now ?? new Date().toISOString(),
        overrides.tenant ?? FENCE_TENANT,
        overrides.updateId ?? FENCE_UPDATE_ID,
        overrides.requestDigest ?? FENCE_REQUEST_DIGEST,
        overrides.telegramUserId ?? FENCE_TELEGRAM_USER,
      ).run()
      return result.meta?.changes ?? 0
    }

    it('claims exactly one row when every fence condition holds (baseline)', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      expect(await runClaim()).toBe(1)
    })

    it('M5 — refuses to claim an invite that is already accepted', async () => {
      insertFenceInvite({ acceptedAt: '2020-01-01T00:00:00.000Z' })
      insertFenceReceipt('processing')
      expect(await runClaim()).toBe(0)
    })

    it('M6 — refuses to claim an invite past its pairing expiry', async () => {
      insertFenceInvite({ expiresAt: new Date(Date.now() - 3_600_000).toISOString() })
      insertFenceReceipt('processing')
      expect(await runClaim()).toBe(0)
    })

    it('M7 — refuses to claim without a matching processing receipt', async () => {
      insertFenceInvite()
      insertFenceReceipt('completed')
      expect(await runClaim()).toBe(0)
    })

    // ── P1-A: the project-status and project-squad-access EXISTS conjuncts
    // (:226-229, :230-234) have no JS twin anywhere in the call chain — the
    // JS pre-check in redeemTelegramProjectInvite only reads accepted_at and
    // pairing_expires_at off the invites row itself, never re-checks the
    // project or the edge. These two are the SOLE fence for a project
    // archived, or a project<->squad edge revoked, between invite mint and
    // claim. Proven load-bearing: deleting either conjunct lets the UPDATE
    // succeed (accepted_at gets set) even against an archived project / a
    // revoked edge, which is exactly the state that would then let the
    // batch's remaining INSERTs (member + capabilities) go through too,
    // since they all gate on `invites.accepted_at = <the value just set>`.
    it('M8 — refuses to claim when the project has been archived between invite mint and claim', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      fenceHarness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'project-fence'`)
      expect(await runClaim()).toBe(0)
      // Untouched: no partial claim, no capability row could ever be reached.
      expect(fenceHarness.sqlite.prepare(
        'SELECT accepted_at FROM invites WHERE id = ?',
      ).get(FENCE_INVITE_ID)).toEqual({ accepted_at: null })
      expect(fenceHarness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM capabilities',
      ).get()).toEqual({ count: 0 })
      expect(fenceHarness.sqlite.prepare(
        'SELECT state FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ?',
      ).get(FENCE_TENANT, FENCE_UPDATE_ID)).toEqual({ state: 'processing' })
    })

    it('M9 — refuses to claim when the project_squad_access edge has been revoked between invite mint and claim', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      fenceHarness.sqlite.exec(
        `DELETE FROM project_squad_access WHERE project_id = 'project-fence' AND squad_id = 'squad-fence'`,
      )
      expect(await runClaim()).toBe(0)
      expect(fenceHarness.sqlite.prepare(
        'SELECT accepted_at FROM invites WHERE id = ?',
      ).get(FENCE_INVITE_ID)).toEqual({ accepted_at: null })
      expect(fenceHarness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM capabilities',
      ).get()).toEqual({ count: 0 })
      expect(fenceHarness.sqlite.prepare(
        'SELECT state FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ?',
      ).get(FENCE_TENANT, FENCE_UPDATE_ID)).toEqual({ state: 'processing' })
    })

    // M9's single project_squad_access row means deleting it removes the
    // ONLY row that could ever satisfy the EXISTS — so M9 cannot tell
    // whether `access.project_id = invites.project_id` or
    // `access.squad_id = invites.squad_id` (or both) is doing the work.
    // These two tests each leave a DIFFERENT edge in place that satisfies
    // exactly one of the two conjuncts, so removing either one individually
    // (mutating the SQL) turns the corresponding test red on its own.
    it('M9b — refuses to claim when a DIFFERENT squad on the same project keeps its own edge (squad_id conjunct)', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      // A second squad linked to the SAME project as the invite. If
      // `access.squad_id = invites.squad_id` were dropped, this row alone
      // would satisfy the EXISTS via project_id matching, independent of
      // which squad the invite is actually for.
      fenceHarness.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name)
        VALUES ('squad-fence-b', 'dept-fence', 'squad-fence-b', 'Squad Fence B');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-fence', 'squad-fence-b', 'write');
        DELETE FROM project_squad_access
         WHERE project_id = 'project-fence' AND squad_id = 'squad-fence';
      `)
      expect(await runClaim()).toBe(0)
      expect(fenceHarness.sqlite.prepare(
        'SELECT accepted_at FROM invites WHERE id = ?',
      ).get(FENCE_INVITE_ID)).toEqual({ accepted_at: null })
      expect(fenceHarness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM capabilities',
      ).get()).toEqual({ count: 0 })
      expect(fenceHarness.sqlite.prepare(
        'SELECT state FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ?',
      ).get(FENCE_TENANT, FENCE_UPDATE_ID)).toEqual({ state: 'processing' })
    })

    it('M9c — refuses to claim when the SAME squad keeps an edge on a DIFFERENT project (project_id conjunct)', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      // The invite's own squad, linked to a DIFFERENT active project. If
      // `access.project_id = invites.project_id` were dropped, this row
      // alone would satisfy the EXISTS via squad_id matching, independent
      // of which project the invite is actually for.
      fenceHarness.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status)
        VALUES ('project-fence-b', 'project-fence-b', 'Project Fence B', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-fence-b', 'squad-fence', 'write');
        DELETE FROM project_squad_access
         WHERE project_id = 'project-fence' AND squad_id = 'squad-fence';
      `)
      expect(await runClaim()).toBe(0)
      expect(fenceHarness.sqlite.prepare(
        'SELECT accepted_at FROM invites WHERE id = ?',
      ).get(FENCE_INVITE_ID)).toEqual({ accepted_at: null })
      expect(fenceHarness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM capabilities',
      ).get()).toEqual({ count: 0 })
      expect(fenceHarness.sqlite.prepare(
        'SELECT state FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ?',
      ).get(FENCE_TENANT, FENCE_UPDATE_ID)).toEqual({ state: 'processing' })
    })

    // ── Mutation-testing sweep of every remaining CLAIM_INVITE_SQL conjunct
    // (kasra-review re-gate, 2026-09-14): mutating each one out and re-running
    // this whole describe block showed 6 conjuncts SURVIVED green even with
    // M5-M9 in place — id, pairing_hash, project_id, squad_id, capability,
    // email, and the receipt's own tenant/update_id/digest/telegram_user_id
    // sub-conjuncts (only receipt.state='processing' was independently
    // pinned, by M7). None of these are reachable in production TODAY —
    // redeemTelegramProjectInvite always binds every one of these straight
    // off the SAME invite/receipt row it just read by pairing_hash/update_id,
    // so a mismatch can't occur on the live call path. But the statement is
    // exported specifically so it can be trusted independent of that one
    // caller (P1-2's own stated purpose) — so the ones a future caller could
    // plausibly get wrong on its own (tenant scoping, exact invite identity,
    // project/squad pairing, capability level) are pinned below rather than
    // left to "no test happens to catch it because there's only one caller".
    it('pins the receipt tenant — refuses when the only matching receipt belongs to a different tenant', async () => {
      insertFenceInvite()
      // A receipt for the SAME update_id/digest/telegram_user, but a
      // DIFFERENT tenant. If the tenant conjunct were dropped, this receipt
      // alone would satisfy the EXISTS and the claim would succeed.
      fenceHarness.sqlite.prepare(`
        INSERT INTO telegram_webhook_receipts (
          tenant, update_id, telegram_user_id, request_digest, state, created_at
        ) VALUES (?, ?, ?, ?, 'processing', ?)
      `).run('other-tenant', FENCE_UPDATE_ID, FENCE_TELEGRAM_USER, FENCE_REQUEST_DIGEST, new Date().toISOString())
      expect(await runClaim({ tenant: FENCE_TENANT })).toBe(0)
    })

    it('pins the exact invite id — a second invite sharing the same pairing_hash/project/squad/capability/email is never touched', async () => {
      insertFenceInvite()
      const decoyId = 'fence-invite-decoy'
      // Same pairing_hash, project, squad, capability, and email as the real
      // invite — the ONLY difference is the id. Without the id conjunct, the
      // UPDATE's WHERE would match BOTH rows.
      fenceHarness.sqlite.prepare(`
        INSERT INTO invites (
          id, email, capability, invited_by, project_id, squad_id,
          pairing_hash, pairing_expires_at, accepted_at
        ) VALUES (?, ?, ?, 'fence-inviter', 'project-fence', 'squad-fence', ?, ?, NULL)
      `).run(decoyId, FENCE_EMAIL, FENCE_CAPABILITY, FENCE_PAIRING_HASH, new Date(Date.now() + 3_600_000).toISOString())
      insertFenceReceipt('processing')
      expect(await runClaim({ inviteId: FENCE_INVITE_ID })).toBe(1)
      expect(fenceHarness.sqlite.prepare(
        'SELECT accepted_at FROM invites WHERE id = ?',
      ).get(decoyId)).toEqual({ accepted_at: null })
    })

    it('pins the project_id binding — refuses when the caller\'s project_id mismatches the invite\'s own project', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      expect(await runClaim({ projectId: 'some-other-project' })).toBe(0)
    })

    it('pins the squad_id binding — refuses when the caller\'s squad_id mismatches the invite\'s own squad', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      expect(await runClaim({ squadId: 'some-other-squad' })).toBe(0)
    })

    it('pins the capability binding — refuses when the caller claims a different capability than the invite grants', async () => {
      insertFenceInvite()
      insertFenceReceipt('processing')
      expect(await runClaim({ capability: 'admin' })).toBe(0)
    })
  })

  // ── Athena addendum B: the SAME P1-1 fix, proven over the actual HTTP route
  // (not just the service function) for a real, DB-resolved member grant —
  // one predicate covering both call shapes.
  it('P1-1/B — refuses a project invite over the HTTP route for a real member with only an observer squad grant', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-route-observer', 'route-observer@example.test', 'Route Observer', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-route-observer', 'member-route-observer', 'squad', 'squad-participants', 'observer');
    `)
    const session = JSON.stringify({
      userId: 'route-observer-user',
      email: 'route-observer@example.test',
      role: 'member',
      createdAt: new Date().toISOString(),
    })
    const routeEnv = {
      ...env,
      SESSIONS: {
        get: async (key: string) => key === 'sess:route-observer' ? session : null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as Env

    const response = await membersApp.request('/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mupot_session=route-observer',
      },
      body: JSON.stringify({
        email: 'route-target@example.test',
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'observer',
        expires_in_seconds: 3600,
      }),
    }, routeEnv)

    expect(response.status, await response.clone().text()).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM invites WHERE email = 'route-target@example.test'
    `).get()).toEqual({ count: 0 })
  })

  it('returns the project pairing code once through the authenticated invite route with no-store headers', async () => {
    const session = JSON.stringify({
      userId: 'inviter-user',
      email: 'inviter@example.test',
      role: 'owner',
      createdAt: new Date().toISOString(),
    })
    const routeEnv = {
      ...env,
      SESSIONS: {
        get: async (key: string) => key === 'sess:project-inviter' ? session : null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as Env

    const response = await membersApp.request('/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mupot_session=project-inviter',
      },
      body: JSON.stringify({
        email: 'route-participant@example.test',
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'member',
        expires_in_seconds: 3600,
      }),
    }, routeEnv)

    expect(response.status, await response.clone().text()).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const body = await response.json() as {
      pairing_code: string
      access_notice: string
      invite: { id: string }
    }
    expect(body.pairing_code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.access_notice).toContain('every project linked to the selected squad')
    expect(harness.sqlite.prepare('SELECT pairing_hash FROM invites WHERE id = ?').get(body.invite.id))
      .toEqual({ pairing_hash: await digestPairingCode(body.pairing_code) })
  })

  it('atomically redeems into a tokenless member, squad grant, and completed update receipt', async () => {
    const created = await createInvite()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-success', VALID_REQUEST_DIGEST, '9001001')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001001',
      display_name: 'Project Participant',
      update_id: 'update-success',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({
      ok: true,
      value: {
        member_id: expect.any(String),
        project_id: 'project-active',
        squad_id: 'squad-participants',
        capability: 'member',
      },
    })
    if (!result.ok) return
    expect(harness.sqlite.prepare(`
      SELECT email, display_name, telegram_chat_id, status, tenant
      FROM members WHERE id = ?
    `).get(result.value.member_id)).toEqual({
      email: 'participant@example.test',
      display_name: 'Project Participant',
      telegram_chat_id: '9001001',
      status: 'active',
      tenant: TENANT,
    })
    expect(harness.sqlite.prepare(`
      SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ?
    `).get(result.value.member_id)).toEqual({
      scope_type: 'squad',
      scope_id: 'squad-participants',
      capability: 'member',
    })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM member_tokens WHERE member_id = ?
    `).get(result.value.member_id)).toEqual({ count: 0 })
    const receipt = harness.sqlite.prepare(`
      SELECT state, response_text, completed_at
      FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ?
    `).get(TENANT, 'update-success') as {
      state: string
      response_text: string
      completed_at: string | null
    }
    expect(receipt.state).toBe('completed')
    expect(JSON.parse(receipt.response_text)).toEqual(result.value)
    expect(receipt.completed_at).not.toBeNull()
  })

  it('returns the stored non-secret result for an identical completed Telegram update', async () => {
    const created = await createInvite('replayed-update@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-replay', VALID_REQUEST_DIGEST, '9001010')
    const input = {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001010',
      display_name: 'Replay Participant',
      update_id: 'update-replay',
      request_digest: VALID_REQUEST_DIGEST,
    }

    const first = await redeemTelegramProjectInvite(env, input)
    expect(first.ok).toBe(true)
    const replay = await redeemTelegramProjectInvite(env, input)

    expect(replay).toEqual(first)
    await expect(redeemTelegramProjectInvite(env, {
      ...input,
      telegram_user_id: '9001011',
    })).resolves.toEqual({ ok: false, error: 'update_receipt_invalid' })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM members WHERE email = 'replayed-update@example.test'
    `).get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM capabilities
      WHERE member_id IN (SELECT id FROM members WHERE email = 'replayed-update@example.test')
    `).get()).toEqual({ count: 1 })
    const stored = harness.sqlite.prepare(`
      SELECT response_text FROM telegram_webhook_receipts
      WHERE tenant = ? AND update_id = 'update-replay'
    `).get(TENANT) as { response_text: string }
    expect(stored.response_text.length).toBeLessThanOrEqual(1000)
    expect(stored.response_text).not.toContain(created.value.pairing_code)
    expect(stored.response_text).not.toContain('token')
  })

  it('refuses redemption when the authenticated Telegram user differs from the receipt binding', async () => {
    const created = await createInvite('wrong-receipt-user@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-wrong-user', VALID_REQUEST_DIGEST, 'telegram-user-a')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: 'telegram-user-b',
      display_name: 'Wrong User',
      update_id: 'update-wrong-user',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({ ok: false, error: 'update_receipt_invalid' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare(`
      SELECT state, telegram_user_id FROM telegram_webhook_receipts
      WHERE tenant = ? AND update_id = 'update-wrong-user'
    `).get(TENANT)).toEqual({ state: 'processing', telegram_user_id: 'telegram-user-a' })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM members WHERE email = 'wrong-receipt-user@example.test'
    `).get()).toEqual({ count: 0 })
  })

  it('refuses an expired pairing code without creating a member or completing its receipt', async () => {
    const created = await createInvite('expired@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.prepare('UPDATE invites SET pairing_expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', created.value.invite.id)
    reserveUpdate('update-expired', VALID_REQUEST_DIGEST, '9001002')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001002',
      display_name: 'Expired Participant',
      update_id: 'update-expired',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM members WHERE email = 'expired@example.test'`).get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-expired'`).get())
      .toEqual({ state: 'processing' })
  })

  it('refuses reuse from the same Telegram chat and has no duplicate effect', async () => {
    const created = await createInvite('single-use@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-first', VALID_REQUEST_DIGEST, '9001003')
    const input = {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001003',
      display_name: 'Single Use',
      update_id: 'update-first',
      request_digest: VALID_REQUEST_DIGEST,
    }
    expect((await redeemTelegramProjectInvite(env, input)).ok).toBe(true)
    reserveUpdate('update-duplicate', VALID_REQUEST_DIGEST, '9001003')

    await expect(redeemTelegramProjectInvite(env, {
      ...input,
      update_id: 'update-duplicate',
    })).resolves.toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM members WHERE email = 'single-use@example.test'`).get())
      .toEqual({ count: 1 })
  })

  it('refuses a used code from a different Telegram chat', async () => {
    const created = await createInvite('different-chat@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-chat-owner', VALID_REQUEST_DIGEST, '9001004')
    expect((await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001004',
      display_name: 'Chat Owner',
      update_id: 'update-chat-owner',
      request_digest: VALID_REQUEST_DIGEST,
    })).ok).toBe(true)
    reserveUpdate('update-other-chat', VALID_REQUEST_DIGEST, '9001005')

    await expect(redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001005',
      display_name: 'Other Chat',
      update_id: 'update-other-chat',
      request_digest: VALID_REQUEST_DIGEST,
    })).resolves.toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM members WHERE email = 'different-chat@example.test'`).get())
      .toEqual({ count: 1 })
  })

  it('refuses an ambiguous duplicate pairing hash without claiming either invite', async () => {
    const pairingCode = 'A'.repeat(43)
    const hash = await digestPairingCode(pairingCode)
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    for (const id of ['duplicate-a', 'duplicate-b']) {
      harness.sqlite.prepare(`
        INSERT INTO invites (
          id, email, capability, invited_by, project_id, squad_id,
          pairing_hash, pairing_expires_at
        ) VALUES (?, ?, 'member', 'member-inviter', 'project-active',
                  'squad-participants', ?, ?)
      `).run(id, `${id}@example.test`, hash, expiresAt)
    }
    reserveUpdate('update-ambiguous', VALID_REQUEST_DIGEST, '9001006')

    await expect(redeemTelegramProjectInvite(env, {
      pairing_code: pairingCode,
      telegram_user_id: '9001006',
      display_name: 'Ambiguous',
      update_id: 'update-ambiguous',
      request_digest: VALID_REQUEST_DIGEST,
    })).resolves.toEqual({ ok: false, error: 'ambiguous_pairing_code' })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM invites WHERE accepted_at IS NOT NULL`).get())
      .toEqual({ count: 0 })
  })

  it('rolls back a failed atomic redemption so the invite and receipt remain retryable', async () => {
    const created = await createInvite('retryable@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
      VALUES ('member-conflict', 'conflict@example.test', 'Conflict', '9001007', 'active', '${TENANT}');
    `)
    reserveUpdate('update-retryable', VALID_REQUEST_DIGEST, '9001007')

    await expect(redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001007',
      display_name: 'Retryable',
      update_id: 'update-retryable',
      request_digest: VALID_REQUEST_DIGEST,
    })).resolves.toEqual({ ok: false, error: 'telegram_identity_conflict' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-retryable'`).get())
      .toEqual({ state: 'processing' })

    harness.sqlite.exec(`DELETE FROM members WHERE id = 'member-conflict'`)
    const retry = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001007',
      display_name: 'Retryable',
      update_id: 'update-retryable',
      request_digest: VALID_REQUEST_DIGEST,
    })
    expect(retry.ok).toBe(true)
  })

  // ── round 6 (kasra-review adversarial addendum on Athena gate `efdb0b08`,
  // P2): the NET-NEW (email) path had NO minter re-check at all before this
  // round — only the member-bind path re-derived the minter's standing at
  // redemption. A squad-admin's invite, redeemed after they are suspended or
  // demoted below squad-admin, used to still mint a fresh member at the
  // invited capability with no re-check of who authorized it.
  it('refuses redemption when the NET-NEW invite MINTER is demoted below squad-admin between invite creation and claim (round 6 P2)', async () => {
    const created = await createInvite('net-new-minter-demoted@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec(`
      UPDATE capabilities SET capability = 'observer'
       WHERE member_id = 'member-inviter' AND scope_type = 'squad' AND scope_id = 'squad-participants'
    `)
    reserveUpdate('update-net-new-minter-demoted', VALID_REQUEST_DIGEST, '9001100')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001100',
      display_name: 'Net New Minter Demoted',
      update_id: 'update-net-new-minter-demoted',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM members WHERE email = 'net-new-minter-demoted@example.test'
    `).get()).toEqual({ count: 0 })
  })

  it('refuses redemption when the NET-NEW invite MINTER is suspended between invite creation and claim (round 6 P2)', async () => {
    const created = await createInvite('net-new-minter-suspended@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'member-inviter'`)
    reserveUpdate('update-net-new-minter-suspended', VALID_REQUEST_DIGEST, '9001101')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001101',
      display_name: 'Net New Minter Suspended',
      update_id: 'update-net-new-minter-suspended',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
  })

  it("still allows redemption when the NET-NEW invite minter's standing is a DEPARTMENT-level grant, not a direct squad grant (round 6 P2, currentMemberSquadRank department inheritance)", async () => {
    const DEPARTMENT_MINTER = 'member-department-minter'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('${DEPARTMENT_MINTER}', 'department-minter@example.test', 'Department Minter', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-department-minter', '${DEPARTMENT_MINTER}', 'department', 'department-delivery', 'admin');
    `)
    const departmentMinterAuth: AuthContext = {
      userId: 'department-minter-user',
      email: 'department-minter@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: DEPARTMENT_MINTER,
      capabilities: [{
        member_id: DEPARTMENT_MINTER, scope_type: 'department', scope_id: 'department-delivery', capability: 'admin',
      }],
    }
    const created = await createProjectInvite(env, departmentMinterAuth, {
      email: 'net-new-department-minted@example.test',
      project_id: 'project-active',
      squad_id: 'squad-participants',
      capability: 'member',
      expires_in_seconds: 3600,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-net-new-department-minter-ok', VALID_REQUEST_DIGEST, '9001102')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9001102',
      display_name: 'Net New Department Minted',
      update_id: 'update-net-new-department-minter-ok',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result.ok).toBe(true)
  })

  // ── Athena addendum D: this onboarding slice is net-new humans only.
  // Redeeming an invite whose email already belongs to an existing member
  // (a different Telegram identity, so no telegram_chat_id conflict) must
  // refuse with 'member_already_exists' and leave no partial writes.
  it('refuses redemption when the invited email already belongs to an existing member', async () => {
    const created = await createInvite('existing-member@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
      VALUES ('member-already-exists', 'existing-member@example.test', 'Existing', '9002999', 'active', '${TENANT}');
    `)
    reserveUpdate('update-existing-member', VALID_REQUEST_DIGEST, '9002998')

    const result = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: '9002998',
      display_name: 'New Telegram Identity',
      update_id: 'update-existing-member',
      request_digest: VALID_REQUEST_DIGEST,
    })

    expect(result).toEqual({ ok: false, error: 'member_already_exists' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM members WHERE email = 'existing-member@example.test'
    `).get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-already-exists'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-existing-member'`).get())
      .toEqual({ state: 'processing' })
  })

  it('rejects a browser/API supplied Telegram identity without claiming a legacy invite', async () => {
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, capability, invited_by)
      VALUES ('legacy-forged-chat', 'legacy@example.test', 'member', 'member-inviter')
    `)

    const response = await membersApp.request('/invites/legacy-forged-chat/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Legacy', telegram_chat_id: 'forged-chat' }),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'telegram_identity_requires_authenticated_webhook' })
    expect(harness.sqlite.prepare(`SELECT accepted_at FROM invites WHERE id = 'legacy-forged-chat'`).get())
      .toEqual({ accepted_at: null })
  })

  it('rejects a project invite on the legacy browser redemption route without minting a token', async () => {
    const created = await createInvite('project-route-escape@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const response = await membersApp.request(`/invites/${created.value.invite.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Wrong Door' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'project_invite_requires_telegram' })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
      .toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM members WHERE email = 'project-route-escape@example.test'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM member_tokens`).get())
      .toEqual({ count: 0 })
  })

  it('joins through Telegram and decides only participant-squad Routine and Task work', async () => {
    const participantPolicy = JSON.stringify({
      execution_mode: 'execute_internal', overlap_policy: 'skip',
      responsible_squad_id: 'squad-participants', preferred_agent_id: 'agent-participant',
      budget_micro_usd: 1000, max_attempts: 3, retry_backoff_seconds: 300,
    })
    const otherPolicy = JSON.stringify({
      execution_mode: 'execute_internal', overlap_policy: 'skip',
      responsible_squad_id: 'squad-other', preferred_agent_id: null,
      budget_micro_usd: 1000, max_attempts: 3, retry_backoff_seconds: 300,
    })
    const flightMeta = JSON.stringify({
      schema: 'mupot.flight.meta/v1', goal_id: 'routine-participant',
      objective_id: 'participant-run', squad_ids: ['squad-participants'],
      task_ids: ['participant-control'], done_when: ['Participant decision is recorded.'],
      artifact_refs: [], receipt_refs: ['routine.proposal:participant-run'], confidentiality: 'internal',
      publication_target: 'none', parent_flight_id: null,
      routine_run_id: 'participant-run', routine_revision: 1,
    })
    harness.sqlite.prepare(`
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-other', 'department-delivery', 'other-decisions', 'Other Decisions')
    `).run()
    harness.sqlite.prepare(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-active', 'squad-other', 'write')
    `).run()
    harness.sqlite.prepare(`
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-participant', 'squad-participants', 'participant-agent', 'Participant Agent', 'active')
    `).run()
    harness.sqlite.prepare(`
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-participant-agent', 'agent-participant', 'squad-participants', 'member')
    `).run()
    harness.sqlite.prepare(`
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, timezone,
        overlap_policy, execution_mode, responsible_squad_id, preferred_agent_id,
        budget_micro_usd, max_attempts, retry_backoff_seconds, revision,
        enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES
        ('routine-participant', ?, 'project-active', 'Participant decision', 'Choose safely',
         'enabled', 'manual', 'UTC', 'skip', 'execute_internal', 'squad-participants',
         'agent-participant', 1000, 3, 300, 1, 'member-inviter', ?, 'member-inviter', ?, ?),
        ('routine-other', ?, 'project-active', 'Other decision', 'Remain fenced',
         'enabled', 'manual', 'UTC', 'skip', 'execute_internal', 'squad-other',
         NULL, 1000, 3, 300, 1, 'member-inviter', ?, 'member-inviter', ?, ?)
    `).run(
      TENANT, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z',
      TENANT, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z',
    )
    harness.sqlite.prepare(`
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status,
        assignee_agent_id, gate_owner, created_at, updated_at
      ) VALUES
        ('participant-control', 'squad-participants', 'project-active', 'Participant control', '',
         'Participant decision is recorded.', 'in_progress', 'agent-participant', NULL, ?, ?),
        ('participant-review', 'squad-participants', 'project-active', 'Participant review', '',
         'Participant approves the evidence.', 'review', NULL, 'gate:participant-review', ?, ?),
        ('other-review', 'squad-other', 'project-active', 'Other review', '',
         'Other squad approves the evidence.', 'review', NULL, 'gate:participant-review', ?, ?)
    `).run(
      '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z',
      '2026-09-13T00:00:01.000Z', '2026-09-13T00:00:01.000Z',
      '2026-09-13T00:00:02.000Z', '2026-09-13T00:00:02.000Z',
    )
    harness.sqlite.prepare(`
      INSERT INTO flights (
        id, tenant, project_id, agent, goal, status, trigger_source, gate_verdict,
        score, budget_micro_usd, cost_micro_usd, created_at, started_at, meta
      ) VALUES (
        'participant-flight', ?, 'project-active', 'agent-participant', 'Choose safely',
        'running', 'manual', 'go', 1, 1000, 0, 1789257600000, 1789257600000, ?
      )
    `).run(TENANT, flightMeta)
    harness.sqlite.prepare(`
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json,
        occurrence_key, trigger_kind, status, waiting_reason, attempt,
        assigned_agent_id, task_id, flight_id, proposal_json, created_at, updated_at
      ) VALUES
        ('participant-run', ?, 'project-active', 'routine-participant', 1, ?,
         'manual:participant-run', 'manual', 'waiting', 'answer', 1,
         'agent-participant', 'participant-control', 'participant-flight', ?, ?, ?),
        ('other-run', ?, 'project-active', 'routine-other', 1, ?,
         'manual:other-run', 'manual', 'waiting', 'answer', 1,
         NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      TENANT, participantPolicy, JSON.stringify({ version: 'routine.proposal/v1' }),
      '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z',
      TENANT, otherPolicy, '2026-09-13T00:00:01.000Z', '2026-09-13T00:00:01.000Z',
    )
    harness.sqlite.prepare(`
      INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json,
        validation_status, gate_status, status, source_type, source_id,
        receipt_id, created_at, updated_at
      ) VALUES (
        'participant-question', ?, 'project-active', 'participant-run',
        'participant-question', 'ask_human', ?, 'accepted', 'not_required',
        'waiting', 'question', 'participant-question', 'participant-wait-receipt', ?, ?
      )
    `).run(
      TENANT,
      JSON.stringify({ question: 'Accept the participant decision?', choices: ['Accept', 'Decline'], references: [] }),
      '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z',
    )

    expect(harness.sqlite.prepare(`
      SELECT responsible_squad_id FROM routines WHERE id = 'routine-participant'
    `).get()).toEqual({ responsible_squad_id: 'squad-participants' })
    expect(JSON.parse(participantPolicy)).toMatchObject({ responsible_squad_id: 'squad-participants' })
    expect(harness.sqlite.prepare(`
      SELECT squad_id FROM tasks WHERE id = 'participant-review'
    `).get()).toEqual({ squad_id: 'squad-participants' })

    const created = await createInvite('integrated-participant@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const telegramEnv = {
      ...env,
      IM_WEBHOOK_SECRET: 'integration-webhook-secret',
      BUS: { send: async () => undefined },
    } as Env
    let updateId = 7000
    const telegram = async (text: string) => {
      const response = await imApp.fetch(new Request('https://pot.test/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'integration-webhook-secret',
        },
        body: JSON.stringify({
          update_id: updateId++,
          message: { from: { id: 9002001 }, chat: { id: 9002001, type: 'private' }, text },
        }),
      }), telegramEnv)
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json() as { reply: string }).reply
    }

    await expect(telegram(`/start ${created.value.pairing_code}`))
      .resolves.toContain('Joined project project-active')
    const joined = harness.sqlite.prepare(`
      SELECT id FROM members WHERE telegram_chat_id = '9002001' AND tenant = ?
    `).get(TENANT) as { id: string }
    expect(harness.sqlite.prepare(`
      SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ?
    `).all(joined.id)).toEqual([{
      scope_type: 'squad', scope_id: 'squad-participants', capability: 'member',
    }])
    harness.sqlite.prepare(`
      INSERT INTO gate_grants (
        id, capability, principal_type, principal_id, granted_by, created_at
      ) VALUES (
        'participant-review-grant', 'gate:participant-review', 'member', ?,
        'member-inviter', '2026-09-13T00:00:03.000Z'
      )
    `).run(joined.id)
    expect(harness.sqlite.prepare(`
      SELECT capability, principal_type, principal_id FROM gate_grants WHERE id = 'participant-review-grant'
    `).get()).toEqual({
      capability: 'gate:participant-review', principal_type: 'member', principal_id: joined.id,
    })

    const needs = await telegram('/needs project-active')
    expect(needs).toContain('/answer participant-run <choice>')
    expect(needs).toContain('/approve participant-review')
    expect(needs).toContain('/reject participant-review <reason>')
    expect(needs).not.toContain('/answer other-run')
    expect(needs).not.toContain('/approve other-review')
    expect(needs).not.toContain('/reject other-review')

    await expect(telegram('/answer participant-run Accept')).resolves.toContain('Answer recorded')
    await expect(telegram('/approve participant-review')).resolves.toContain('Approved')
    await expect(telegram('/answer other-run Accept')).resolves.toContain('forbidden')
    await expect(telegram('/approve other-review')).resolves.toContain('permission')

    expect(harness.sqlite.prepare(`
      SELECT status FROM tasks WHERE id = 'participant-review'
    `).get()).toEqual({ status: 'approved' })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM task_verdicts WHERE task_id = 'participant-review'
    `).get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare(`
      SELECT status FROM tasks WHERE id = 'other-review'
    `).get()).toEqual({ status: 'review' })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM task_verdicts WHERE task_id = 'other-review'
    `).get()).toEqual({ count: 0 })
  })

  // ── P2: a distinct chat reply per redemption failure is a weak enumeration
  // oracle over a secret pairing code. Two different underlying causes must
  // produce the IDENTICAL generic chat text.
  // ── Athena addendum E: Telegram's self-reported first_name/username become
  // the stored, COSMETIC-ONLY display_name — never a hardcoded 'Telegram
  // member' when the update actually carries a name, and never authority.
  it('E — threads the Telegram first_name/username through as the display_name label only', async () => {
    const created = await createInvite('display-name-participant@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const telegramEnv = {
      ...env,
      IM_WEBHOOK_SECRET: 'display-name-webhook-secret',
      BUS: { send: async () => undefined },
    } as Env

    const response = await imApp.fetch(new Request('https://pot.test/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'display-name-webhook-secret',
      },
      body: JSON.stringify({
        update_id: 8000,
        message: {
          from: { id: 9003001, first_name: 'Ada ', username: 'ada_lovelace' },
          chat: { id: 9003001, type: 'private' },
          text: `/start ${created.value.pairing_code}`,
        },
      }),
    }), telegramEnv)
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ reply: expect.stringContaining('Joined project') })

    expect(harness.sqlite.prepare(`
      SELECT display_name FROM members WHERE telegram_chat_id = '9003001'
    `).get()).toEqual({ display_name: 'Ada (@ada_lovelace)' })
  })

  it('E — falls back to the generic label when Telegram supplies no usable name', async () => {
    const created = await createInvite('no-name-participant@example.test')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const telegramEnv = {
      ...env,
      IM_WEBHOOK_SECRET: 'no-name-webhook-secret',
      BUS: { send: async () => undefined },
    } as Env

    const response = await imApp.fetch(new Request('https://pot.test/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'no-name-webhook-secret',
      },
      body: JSON.stringify({
        update_id: 8001,
        message: {
          from: { id: 9003002 },
          chat: { id: 9003002, type: 'private' },
          text: `/start ${created.value.pairing_code}`,
        },
      }),
    }), telegramEnv)
    expect(response.status, await response.clone().text()).toBe(200)

    expect(harness.sqlite.prepare(`
      SELECT display_name FROM members WHERE telegram_chat_id = '9003002'
    `).get()).toEqual({ display_name: 'Telegram member' })
  })

  it('P2 — never echoes the raw redemption error enum into the Telegram chat reply', async () => {
    const expired = await createInvite('join-error-expired@example.test')
    expect(expired.ok).toBe(true)
    if (!expired.ok) return
    harness.sqlite.prepare('UPDATE invites SET pairing_expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', expired.value.invite.id)
    reserveUpdate('update-join-expired', VALID_REQUEST_DIGEST, '9099001')

    const expiredReply = await handleImMessage(env, '9099001', `/start ${expired.value.pairing_code}`, {
      telegram: { update_id: 'update-join-expired', telegram_user_id: '9099001', request_digest: VALID_REQUEST_DIGEST },
    })

    const conflicted = await createInvite('join-error-conflict@example.test')
    expect(conflicted.ok).toBe(true)
    if (!conflicted.ok) return
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
      VALUES ('member-join-conflict', 'join-conflict-existing@example.test', 'Existing', '9099002', 'active', '${TENANT}');
    `)
    reserveUpdate('update-join-conflict', VALID_REQUEST_DIGEST, '9099002')

    const conflictReply = await handleImMessage(env, '9099002', `/start ${conflicted.value.pairing_code}`, {
      telegram: { update_id: 'update-join-conflict', telegram_user_id: '9099002', request_digest: VALID_REQUEST_DIGEST },
    })

    const GENERIC = 'Could not join. Ask an admin for a new invitation.'
    expect(expiredReply).toBe(GENERIC)
    expect(conflictReply).toBe(GENERIC)
    for (const reply of [expiredReply, conflictReply]) {
      expect(reply).not.toMatch(
        /invalid_or_expired_pairing_code|ambiguous_pairing_code|telegram_identity_conflict|member_already_exists|redemption_failed|update_receipt_invalid/,
      )
    }
  })
})

// ── Bind-existing-member project invites (mupot#1407 follow-up) ────────────
//
// PR #1407 shipped project invites for net-new humans only: redemption always
// INSERTs a fresh members row, so an existing member's own email collides
// with members.email's UNIQUE constraint and returns member_already_exists.
// This slice adds an optional member_id on invite creation: when set, the
// invite binds an EXISTING active member's Telegram identity at redemption
// (UPDATE, never INSERT) instead of minting a net-new one. One claim
// statement (CLAIM_INVITE_SQL, unchanged), one new conditional bind
// statement inside the SAME atomic batch, one capability ceiling path
// (actorRankOnSquad, unchanged) — not a second copy of any of the three.

describe('Telegram project invite — bind existing member', () => {
  let harness: SqliteD1Harness
  let env: Env

  // mupot#1411 P0-1 (kasra-review, 2026-09-15): a member-bind invite mints a
  // credential that authenticates AS the target, so it now requires the SAME
  // authority as a token mint — org-scope admin, not squad-admin. This actor
  // carries an org-scope 'admin' grant (rank 4), not a squad grant, matching
  // the new floor every test in this describe block exercises by default.
  const ownerAuth: AuthContext = {
    userId: 'bind-owner-user',
    email: 'bind-owner@example.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'member-bind-owner',
    capabilities: [{
      member_id: 'member-bind-owner',
      scope_type: 'org',
      scope_id: null,
      capability: 'admin',
    }],
  }

  // A squad-admin with NO org-scope standing at all — used to prove
  // squad-admin alone is no longer sufficient for a member-bind invite
  // (P0-1 fix (a)).
  const squadOnlyAdminAuth: AuthContext = {
    userId: 'squad-only-admin-user',
    email: 'squad-only-admin@example.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'member-squad-only-admin',
    capabilities: [{
      member_id: 'member-squad-only-admin',
      scope_type: 'squad',
      scope_id: 'squad-bind',
      capability: 'admin',
    }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name)
      VALUES ('department-bind', 'delivery-bind', 'Delivery Bind');
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-bind', 'department-bind', 'bind', 'Bind Squad');
      INSERT INTO projects (id, slug, name, status)
      VALUES ('project-bind', 'bind-project', 'Bind project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-bind', 'squad-bind', 'write');
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-bind-owner', 'bind-owner@example.test', 'Bind Owner', 'active', '${TENANT}');
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-squad-only-admin', 'squad-only-admin@example.test', 'Squad Only Admin', 'active', '${TENANT}');
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-existing', 'existing-human@example.test', 'Existing Human', 'active', '${TENANT}');
      -- mupot#1411 P2 round 5 (kasra-review adversarial addendum, 2026-09-15),
      -- corrected round 6 (F3): ownerAuth's org-admin standing above is fed
      -- directly as auth.capabilities (simulating an already-resolved
      -- session) — that alone is NOT what redemption re-checks.
      -- redeemTelegramProjectInvite re-derives minted_by_member_id's CURRENT
      -- standing straight from the capabilities TABLE (currentMemberOrgRank),
      -- never from a caller-supplied auth object, so this row is the REAL
      -- authority every member-bind redemption test in this block relies on
      -- — not a workaround for an unrelated fixture quirk. It is also
      -- EXACTLY the shape a session-role-only minter (standing from
      -- auth.role alone, no capabilities row, no bridged users row) does
      -- NOT have — see the dedicated test below proving that gap mints but
      -- cannot redeem, and the docstring on currentMemberOrgRank
      -- (src/members/project-invites.ts) for why it cannot be closed here.
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-bind-owner-org', 'member-bind-owner', 'org', NULL, 'admin');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  function reserveUpdate(
    updateId: string,
    requestDigest = VALID_REQUEST_DIGEST,
    telegramUserId = 'telegram-user-bind',
  ): void {
    harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, telegram_user_id, request_digest, state, created_at
      ) VALUES (?, ?, ?, ?, 'processing', ?)
    `).run(TENANT, updateId, telegramUserId, requestDigest, new Date().toISOString())
  }

  async function createMemberInvite(
    overrides: Partial<{
      member_id: string
      project_id: string
      squad_id: string
      capability: 'owner' | 'admin' | 'lead' | 'member' | 'observer'
      expires_in_seconds: number
    }> = {},
  ) {
    return createProjectInvite(env, ownerAuth, {
      member_id: 'member-existing',
      project_id: 'project-bind',
      squad_id: 'squad-bind',
      capability: 'member',
      expires_in_seconds: 3600,
      ...overrides,
    })
  }

  // ── createProjectInvite (creation side) ──────────────────────────────────

  describe('createProjectInvite — member_id', () => {
    it('creates a project invite bound to an existing member, deriving email server-side', async () => {
      const result = await createMemberInvite()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.invite.email).toBe('existing-human@example.test')

      const row = harness.sqlite.prepare(
        'SELECT email, member_id FROM invites WHERE id = ?',
      ).get(result.value.invite.id) as Record<string, unknown>
      expect(row).toEqual({ email: 'existing-human@example.test', member_id: 'member-existing' })
    })

    it('rejects an empty member_id as invalid_member_id', async () => {
      await expect(createMemberInvite({ member_id: '   ' })).resolves.toEqual({
        ok: false,
        error: 'invalid_member_id',
      })
    })

    // P2-2 (kasra-review, 2026-09-15): the HTTP route's parseInvite already
    // refuses member_id + email together, but createProjectInvite is called
    // directly by non-HTTP callers too — calling it DIRECTLY here (bypassing
    // parseInvite entirely) proves the SERVICE itself refuses, not only the
    // one HTTP entry point.
    it('P2-2 — the SERVICE itself refuses member_id and email supplied together, bypassing the HTTP route entirely', async () => {
      await expect(createProjectInvite(env, ownerAuth, {
        member_id: 'member-existing',
        email: 'someone-else@example.test',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })).resolves.toEqual({ ok: false, error: 'invalid_invite_scope' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-existing')).toEqual({ count: 0 })
    })

    it('collapses a member from another tenant to member_not_found (no cross-tenant existence oracle)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-other-tenant', 'other-tenant@example.test', 'Other Tenant', 'active', 'a-different-tenant');
      `)
      await expect(createMemberInvite({ member_id: 'member-other-tenant' })).resolves.toEqual({
        ok: false,
        error: 'member_not_found',
      })
    })

    it('refuses a nonexistent member with member_not_found', async () => {
      await expect(createMemberInvite({ member_id: 'member-does-not-exist' })).resolves.toEqual({
        ok: false,
        error: 'member_not_found',
      })
    })

    it('refuses a suspended member with member_not_active', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-suspended', 'suspended@example.test', 'Suspended', 'suspended', '${TENANT}');
      `)
      await expect(createMemberInvite({ member_id: 'member-suspended' })).resolves.toEqual({
        ok: false,
        error: 'member_not_active',
      })
    })

    it('refuses a member with no email on file with member_missing_email', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
        VALUES ('member-im-only', NULL, 'IM Only', '9200001', 'active', '${TENANT}');
      `)
      await expect(createMemberInvite({ member_id: 'member-im-only' })).resolves.toEqual({
        ok: false,
        error: 'member_missing_email',
      })
    })

    it('still enforces the actor rank ceiling on a member-bind invite (no second predicate)', async () => {
      await expect(createMemberInvite({ capability: 'owner' })).resolves.toEqual({
        ok: false,
        error: 'cannot_grant_above_own_rank',
      })
    })

    // ── P0-1 (kasra-review, 2026-09-15): identity takeover ──────────────────
    // A member-bind invite mints a Telegram credential that authenticates AS
    // the target. A squad-admin ceiling never looked at the TARGET's real
    // standing, so a squad-admin could member-bind an org OWNER (or any
    // higher-ranked principal) onto their own squad at a LOW capability, then
    // redeem it from THEIR OWN Telegram id and resolve through memberForChat
    // AS that member — with no route to ever undo the bind.

    it('P0-1a — refuses a squad-admin actor (no org-scope standing) for a member-bind invite', async () => {
      await expect(createProjectInvite(env, squadOnlyAdminAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })).resolves.toEqual({ ok: false, error: 'forbidden' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-existing')).toEqual({ count: 0 })
    })

    // mupot#1411 P2-D round 4 (kasra-review, 2026-09-15): the coarse
    // "does the actor hold admin standing AT ALL" check used to run AFTER
    // the member lookup, so a zero-standing caller got a DIFFERENT error per
    // target (member_not_found / member_not_active / member_missing_email)
    // — an enumeration oracle available to anyone, not only an admin. Moved
    // above the lookup; every target shape below now gets the IDENTICAL
    // 'forbidden' refusal from the SAME zero-standing actor.
    it('P2-D — a zero-standing actor gets the IDENTICAL refusal regardless of target existence/state/email', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-p2d-suspended', 'p2d-suspended@example.test', 'P2D Suspended', 'suspended', '${TENANT}');
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-p2d-no-email', NULL, 'P2D No Email', 'active', '${TENANT}');
      `)
      const invite = (memberId: string) => createProjectInvite(env, squadOnlyAdminAuth, {
        member_id: memberId,
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })

      const nonexistent = await invite('member-p2d-does-not-exist')
      const active = await invite('member-existing')
      const suspended = await invite('member-p2d-suspended')
      const noEmail = await invite('member-p2d-no-email')

      expect(nonexistent).toEqual({ ok: false, error: 'forbidden' })
      expect(active).toEqual({ ok: false, error: 'forbidden' })
      expect(suspended).toEqual({ ok: false, error: 'forbidden' })
      expect(noEmail).toEqual({ ok: false, error: 'forbidden' })
      // Not merely the same error CODE — no invite row exists for any of them.
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM invites').get())
        .toEqual({ count: 0 })
    })

    // N2 round 4 (Athena, 2026-09-15): self-exemption on the member-bind
    // path too, not only the HTTP routes in src/members/index.ts.
    it('N2 — an org admin may member-bind THEIR OWN Telegram identity even while holding elevated standing elsewhere', async () => {
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-bind-owner-elsewhere-owner', 'member-bind-owner', 'squad', 'squad-bind', 'owner');
      `)
      // ownerAuth's own memberId is 'member-bind-owner' — binding member_id
      // = itself. Its global standing (owner, rank 5, via the extra squad
      // grant just inserted) now exceeds its org-scope-local rank (admin,
      // rank 4) — exactly the local-vs-global mismatch N2 fixes — but
      // self-exemption means the comparison never even runs.
      const result = await createMemberInvite({ member_id: 'member-bind-owner', capability: 'member' })
      expect(result.ok).toBe(true)
    })

    it('P0-1b — refuses an org-admin actor targeting a member who outranks them via a DIFFERENT, unrelated scope (target-rank ceiling, across ALL scopes)', async () => {
      harness.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('department-secret', 'secret', 'Secret Dept');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-secret', 'department-secret', 'secret', 'Secret Squad');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-secret-owner', 'member-existing', 'squad', 'squad-secret', 'owner');
      `)
      // ownerAuth is org-admin (rank 4). member-existing holds NOTHING on
      // squad-bind (the invited squad) but 'owner' (rank 5) on a totally
      // unrelated squad — the OLD per-scope ceiling never looked there.
      await expect(createMemberInvite()).resolves.toEqual({ ok: false, error: 'forbidden' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-existing')).toEqual({ count: 0 })
    })

    it('P0-1c — an org OWNER may still member-bind a target who is merely an admin elsewhere', async () => {
      const orgOwnerAuth: AuthContext = {
        userId: 'org-owner-user',
        email: 'org-owner@example.test',
        role: 'member',
        tenant: TENANT,
        memberId: 'member-org-owner',
        capabilities: [{
          member_id: 'member-org-owner',
          scope_type: 'org',
          scope_id: null,
          capability: 'owner',
        }],
      }
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-org-owner', 'org-owner@example.test', 'Org Owner', 'active', '${TENANT}');
        INSERT INTO departments (id, slug, name) VALUES ('department-other', 'other', 'Other Dept');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-other', 'department-other', 'other', 'Other Squad');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-other-admin', 'member-existing', 'squad', 'squad-other', 'admin');
      `)
      const result = await createProjectInvite(env, orgOwnerAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })
      expect(result.ok).toBe(true)
    })

    // mupot#1411 P0-A round 4 (kasra-review, 2026-09-15): re-run of the
    // executed takeover probe from the round-4 gate — an org admin mints a
    // member_id invite for the bootstrap owner. The owner here has ZERO
    // capability rows (the characteristic shape, src/auth/index.ts:917-923)
    // and standing ONLY via `users.role`, bridged by email. Before the fix,
    // targetMaxRankAcrossScopes measured the grants plane alone and returned
    // 0 for this target, so the invite MINTED, was redeemable, and a
    // subsequent `PATCH .../status=suspended` on the owner returned 200 —
    // the exact #1337 lockout this ceiling exists to prevent.
    it('P0-A — refuses an org admin minting a member_id invite for the bootstrap owner (role-plane only, zero capability rows)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-bootstrap-owner', 'bootstrap-owner@example.test', 'Bootstrap Owner', 'active', '${TENANT}');
        INSERT INTO users (id, email, role)
        VALUES ('user-bootstrap-owner', 'bootstrap-owner@example.test', 'owner');
      `)
      const result = await createMemberInvite({ member_id: 'member-bootstrap-owner' })
      expect(result).toEqual({ ok: false, error: 'forbidden' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-bootstrap-owner')).toEqual({ count: 0 })
    })

    it('does not create an invite row when member validation refuses', async () => {
      await createMemberInvite({ member_id: 'member-does-not-exist' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-does-not-exist')).toEqual({ count: 0 })
    })
  })

  // ── redeemTelegramProjectInvite (redemption side) ────────────────────────

  describe('redeemTelegramProjectInvite — member_id', () => {
    it('binds the Telegram identity to the existing member instead of inserting a new one', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-success', VALID_REQUEST_DIGEST, '9200100')

      const before = harness.sqlite.prepare('SELECT COUNT(*) AS count FROM members').get()

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200100',
        display_name: 'Ignored Cosmetic Name',
        update_id: 'update-bind-success',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({
        ok: true,
        value: {
          member_id: 'member-existing',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
        },
      })

      const after = harness.sqlite.prepare('SELECT COUNT(*) AS count FROM members').get()
      expect(after).toEqual(before) // no new member row minted

      expect(harness.sqlite.prepare(`
        SELECT email, display_name, telegram_chat_id, status
        FROM members WHERE id = 'member-existing'
      `).get()).toEqual({
        email: 'existing-human@example.test',
        display_name: 'Existing Human', // unchanged — display_name threading stays cosmetic-only
        telegram_chat_id: '9200100',
        status: 'active',
      })

      expect(harness.sqlite.prepare(`
        SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ scope_type: 'squad', scope_id: 'squad-bind', capability: 'member' })

      const receipt = harness.sqlite.prepare(`
        SELECT state, response_text FROM telegram_webhook_receipts
        WHERE tenant = ? AND update_id = 'update-bind-success'
      `).get(TENANT) as { state: string; response_text: string }
      expect(receipt.state).toBe('completed')
      expect(JSON.parse(receipt.response_text)).toEqual(result.value)
    })

    // mupot#1411 P2-E round 4 (kasra-review, 2026-09-15): P2-3 from round 2
    // was left NOT FIXED — any PRE-EXISTING grant on the invited squad
    // (the MOST common shape for binding an existing member: they usually
    // already work on that squad) hit `UNIQUE(member_id, scope_type,
    // scope_id)` and threw, permanently bricking the invite as
    // `redemption_failed`. ON CONFLICT DO UPDATE now upgrades to the HIGHER
    // of the two ranks — never downgrades, never exceeds the invite's own
    // capability (itself already capped at mint time to <= the minter's
    // rank).
    it('P2-E — an existing OBSERVER grant on the invited squad is UPGRADED to the invited capability, not thrown away', async () => {
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-existing-observer', 'member-existing', 'squad', 'squad-bind', 'observer');
      `)
      const created = await createMemberInvite({ capability: 'member' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-upgrade-observer', VALID_REQUEST_DIGEST, '9200300')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200300',
        display_name: 'Upgrade Observer',
        update_id: 'update-bind-upgrade-observer',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result.ok).toBe(true)
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing' AND scope_type = 'squad' AND scope_id = 'squad-bind'
      `).get()).toEqual({ count: 1 }) // upgraded IN PLACE, not a second row
      expect(harness.sqlite.prepare(`
        SELECT capability FROM capabilities WHERE member_id = 'member-existing' AND scope_type = 'squad' AND scope_id = 'squad-bind'
      `).get()).toEqual({ capability: 'member' }) // observer(1) -> member(2), upgraded
    })

    it('P2-E — an existing ADMIN grant on the invited squad is KEPT (never downgraded) when the invite is for a LOWER capability', async () => {
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-existing-admin', 'member-existing', 'squad', 'squad-bind', 'admin');
      `)
      const created = await createMemberInvite({ capability: 'observer' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-keep-admin', VALID_REQUEST_DIGEST, '9200301')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200301',
        display_name: 'Keep Admin',
        update_id: 'update-bind-keep-admin',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result.ok).toBe(true)
      expect(harness.sqlite.prepare(`
        SELECT capability FROM capabilities WHERE member_id = 'member-existing' AND scope_type = 'squad' AND scope_id = 'squad-bind'
      `).get()).toEqual({ capability: 'admin' }) // NEVER downgraded to the invited 'observer'
    })

    it('refuses when the member already has a DIFFERENT Telegram identity bound', async () => {
      harness.sqlite.exec(`
        UPDATE members SET telegram_chat_id = '9200200' WHERE id = 'member-existing'
      `)
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-self-conflict', VALID_REQUEST_DIGEST, '9200201')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200201',
        display_name: 'Wrong New Identity',
        update_id: 'update-bind-self-conflict',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'telegram_identity_conflict' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: '9200200' }) // unchanged
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
    })

    it('refuses when the Telegram identity is already bound to a DIFFERENT member (reverse conflict)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
        VALUES ('member-holds-telegram', 'holder@example.test', 'Holder', '9200300', 'active', '${TENANT}');
      `)
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-reverse-conflict', VALID_REQUEST_DIGEST, '9200300')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200300',
        display_name: 'Reverse Conflict',
        update_id: 'update-bind-reverse-conflict',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'telegram_identity_conflict' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
    })

    it('refuses redemption when the target member is suspended between invite creation and claim', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'member-existing'`)
      reserveUpdate('update-bind-suspended', VALID_REQUEST_DIGEST, '9200400')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200400',
        display_name: 'Suspended At Claim',
        update_id: 'update-bind-suspended',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
      expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-bind-suspended'`).get())
        .toEqual({ state: 'processing' })
    })

    // ── P2 round 5 (kasra-review adversarial addendum, 2026-09-15) ──────────
    //
    // A member-bind invite's capability must not outlive the MINTER's own
    // authority to have minted it. minted_by_member_id (0154) records the
    // minter; redemption re-derives their CURRENT org-scope-local rank fresh
    // from the capabilities table (currentMemberOrgRank) rather than trusting
    // whatever standing they had at mint time.
    it('refuses redemption when the invite MINTER is demoted between invite creation and claim', async () => {
      const created = await createMemberInvite({ capability: 'admin' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      // member-bind-owner's org-admin grant is downgraded to 'observer' —
      // no longer enough to have authorized an 'admin' bind invite.
      harness.sqlite.exec(`
        UPDATE capabilities SET capability = 'observer'
         WHERE member_id = 'member-bind-owner' AND scope_type = 'org'
      `)
      reserveUpdate('update-bind-minter-demoted', VALID_REQUEST_DIGEST, '9200600')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200600',
        display_name: 'Minter Demoted',
        update_id: 'update-bind-minter-demoted',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
    })

    it('refuses redemption when the invite MINTER is suspended between invite creation and claim', async () => {
      const created = await createMemberInvite({ capability: 'admin' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'member-bind-owner'`)
      reserveUpdate('update-bind-minter-suspended', VALID_REQUEST_DIGEST, '9200700')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200700',
        display_name: 'Minter Suspended',
        update_id: 'update-bind-minter-suspended',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
    })

    it('still allows redemption when the invite MINTER retains sufficient authority (no regression)', async () => {
      const created = await createMemberInvite({ capability: 'admin' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-minter-ok', VALID_REQUEST_DIGEST, '9200800')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200800',
        display_name: 'Minter Still Admin',
        update_id: 'update-bind-minter-ok',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result.ok).toBe(true)
    })

    // ── round 6 (kasra-review adversarial addendum on Athena gate
    // `efdb0b08`) — the minter re-check above only ever compared the
    // capability being GRANTED against the minter's current rank. It never
    // re-derived the TARGET's standing (P1-A), and never re-checked the
    // BASELINE admin-or-above authority every member-bind mint actually
    // requires (P1-B) — a minter demoted to 'observer' minting an
    // 'observer'-capability invite passed the old check unchanged.
    it('refuses redemption when the TARGET is promoted to org owner between invite creation and claim (round 6 P1-A)', async () => {
      const created = await createMemberInvite({ capability: 'member' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-promoted', 'member-existing', 'org', NULL, 'owner')
      `)
      reserveUpdate('update-bind-target-promoted', VALID_REQUEST_DIGEST, '9200900')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200900',
        display_name: 'Target Promoted',
        update_id: 'update-bind-target-promoted',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
    })

    it("refuses redemption when the MINTER is demoted below admin, even for an 'observer'-capability invite the old check could not see (round 6 P1-B)", async () => {
      const created = await createMemberInvite({ capability: 'observer' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`
        UPDATE capabilities SET capability = 'observer'
         WHERE member_id = 'member-bind-owner' AND scope_type = 'org'
      `)
      reserveUpdate('update-bind-minter-below-admin', VALID_REQUEST_DIGEST, '9201000')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201000',
        display_name: 'Minter Below Admin',
        update_id: 'update-bind-minter-below-admin',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    })

    it('still allows redemption when the minter member-binds THEMSELVES — self-exempt from the target-promotion ceiling (round 6 P1-A)', async () => {
      // member-bind-owner's GLOBAL rank (5, via this squad-owner grant on an
      // UNRELATED squad) exceeds their own ORG-scope-local rank (4, admin) —
      // so WITHOUT the self-exemption, targetOutgrewMinter would compute
      // target(5) > minter(4) and incorrectly refuse a principal acting on
      // themselves. This is the discriminating fixture: it fails if the
      // self-exemption is ever dropped, unlike a same-rank self-target.
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-bind-owner-unrelated-squad-owner', 'member-bind-owner', 'squad', 'squad-unrelated-to-bind', 'owner')
      `)
      const created = await createProjectInvite(env, ownerAuth, {
        member_id: 'member-bind-owner',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'admin',
        expires_in_seconds: 3600,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-self-mint', VALID_REQUEST_DIGEST, '9201100')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201100',
        display_name: 'Self Mint',
        update_id: 'update-bind-self-mint',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result.ok).toBe(true)
    })

    // ── round 7 (kasra-review adversarial gate on `dd9a7d52`) — round 6's
    // target re-check ran only inside `if (invite.minted_by_member_id !==
    // null)`, so it never applied when the minter is unknown. A legacy
    // web-login admin (role plane only, no member row at all) can mint a
    // member-bind invite — `actorRankOnScopeFor` floors 'admin' role to rank
    // 4 with no memberId required — and `minted_by_member_id` records NULL
    // for exactly that principal. The net-new path is separately refused for
    // this same principal (`actorRankOnSquad` returns 0 with no memberId),
    // so member-bind was the only reachable shape for the takeover.
    it('refuses redemption when the TARGET is promoted to org owner after a NULL-minter (legacy web-login) invite (round 7 P1)', async () => {
      const legacyWebLoginAdminAuth: AuthContext = {
        userId: 'legacy-web-login-admin-user',
        email: 'legacy-web-login-admin@example.test',
        role: 'admin',
        tenant: TENANT,
        // memberId and capabilities intentionally absent — the pure
        // web-login shape; minted_by_member_id will record NULL for it.
      } as AuthContext

      const created = await createProjectInvite(env, legacyWebLoginAdminAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(harness.sqlite.prepare('SELECT minted_by_member_id FROM invites WHERE id = ?')
        .get(created.value.invite.id)).toEqual({ minted_by_member_id: null })

      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-promoted-null-minter', 'member-existing', 'org', NULL, 'owner')
      `)
      reserveUpdate('update-bind-null-minter-target-promoted', VALID_REQUEST_DIGEST, '9201300')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201300',
        display_name: 'Null Minter Target Promoted',
        update_id: 'update-bind-null-minter-target-promoted',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing' AND id != 'cap-target-promoted-null-minter'
      `).get()).toEqual({ count: 0 })
    })

    it('still allows a NULL-minter (legacy web-login) invite to redeem when the target never grew past the mint-time floor (round 7 P1)', async () => {
      const legacyWebLoginAdminAuth: AuthContext = {
        userId: 'legacy-web-login-admin-user-2',
        email: 'legacy-web-login-admin-2@example.test',
        role: 'admin',
        tenant: TENANT,
      } as AuthContext

      const created = await createProjectInvite(env, legacyWebLoginAdminAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'member',
        expires_in_seconds: 3600,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(harness.sqlite.prepare('SELECT minted_by_member_id FROM invites WHERE id = ?')
        .get(created.value.invite.id)).toEqual({ minted_by_member_id: null })
      reserveUpdate('update-bind-null-minter-ok', VALID_REQUEST_DIGEST, '9201400')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201400',
        display_name: 'Null Minter Ok',
        update_id: 'update-bind-null-minter-ok',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result.ok).toBe(true)
    })

    // ── M4 (round 6 survivor, closed round 7): baselineAuthorityLost's
    // second disjunct (`capabilityRank(invite.capability) > minterRank`) had
    // no discriminating test — an owner mints an 'owner'-capability invite,
    // is demoted to 'admin' (still clears the FIRST disjunct's admin floor:
    // 4 < 4 is false), and the invite's capability (owner, rank 5) now
    // exceeds the demoted minter's rank (4). Only the second disjunct
    // catches this.
    it('refuses redemption when the minter is demoted from owner to admin and the invite capability (owner) now exceeds their rank (M4)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-org-owner-minter', 'org-owner-minter@example.test', 'Org Owner Minter', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-org-owner-minter', 'member-org-owner-minter', 'org', NULL, 'owner');
      `)
      const orgOwnerMinterAuth: AuthContext = {
        userId: 'org-owner-minter-user',
        email: 'org-owner-minter@example.test',
        role: 'member',
        tenant: TENANT,
        memberId: 'member-org-owner-minter',
        capabilities: [{
          member_id: 'member-org-owner-minter',
          scope_type: 'org',
          scope_id: null,
          capability: 'owner',
        }],
      }

      const created = await createProjectInvite(env, orgOwnerMinterAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'owner',
        expires_in_seconds: 3600,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      harness.sqlite.exec(`
        UPDATE capabilities SET capability = 'admin'
         WHERE member_id = 'member-org-owner-minter' AND scope_type = 'org'
      `)
      reserveUpdate('update-bind-owner-invite-minter-demoted', VALID_REQUEST_DIGEST, '9201500')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201500',
        display_name: 'Owner Invite Minter Demoted',
        update_id: 'update-bind-owner-invite-minter-demoted',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
    })

    // ── F3 disclosure (round 6, kept as a documented, NOT-fixed-this-round
    // gap — see docs/architecture/human-decision-channel-contract.md and the
    // currentMemberOrgRank docstring above): a minter whose org-scope
    // standing at MINT time came ONLY from the live session's `auth.role`
    // (owner/admin), with NO backing `capabilities` row and NO `users` row
    // reachable from their OWN member email, mints successfully but is
    // refused at redemption — currentMemberOrgRank has no D1 plane left to
    // recover a role that only ever existed on the minting session object.
    it('mints via a SESSION-ROLE-ONLY minter (auth.role floor with no backing D1 row) but redemption then refuses — documented gap, not fixed this round', async () => {
      const SESSION_ROLE_ONLY_MINTER = 'member-session-role-only-minter'
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${SESSION_ROLE_ONLY_MINTER}', 'session-role-only-minter@example.test', 'Session Role Only Minter', 'active', '${TENANT}');
      `)
      const sessionRoleOnlyAuth: AuthContext = {
        userId: 'session-role-only-user',
        email: 'session-role-only-minter@example.test',
        role: 'owner',
        tenant: TENANT,
        memberId: SESSION_ROLE_ONLY_MINTER,
        capabilities: [],
      }

      const created = await createProjectInvite(env, sessionRoleOnlyAuth, {
        member_id: 'member-existing',
        project_id: 'project-bind',
        squad_id: 'squad-bind',
        capability: 'admin',
        expires_in_seconds: 3600,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      reserveUpdate('update-bind-session-role-only', VALID_REQUEST_DIGEST, '9201200')
      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201200',
        display_name: 'Session Role Only Redeemer',
        update_id: 'update-bind-session-role-only',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    })

    it('refuses a second redemption of the same member-bind invite (single-use fence still holds)', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-first', VALID_REQUEST_DIGEST, '9200500')
      const first = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200500',
        display_name: 'First',
        update_id: 'update-bind-first',
        request_digest: VALID_REQUEST_DIGEST,
      })
      expect(first.ok).toBe(true)

      reserveUpdate('update-bind-second', VALID_REQUEST_DIGEST, '9200500')
      await expect(redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200500',
        display_name: 'Second',
        update_id: 'update-bind-second',
        request_digest: VALID_REQUEST_DIGEST,
      })).resolves.toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })

      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 1 })
    })

    it('returns the stored non-secret result for an identical completed Telegram update (replay-safe)', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-replay', VALID_REQUEST_DIGEST, '9200600')
      const input = {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200600',
        display_name: 'Replay',
        update_id: 'update-bind-replay',
        request_digest: VALID_REQUEST_DIGEST,
      }
      const first = await redeemTelegramProjectInvite(env, input)
      expect(first.ok).toBe(true)
      const replay = await redeemTelegramProjectInvite(env, input)
      expect(replay).toEqual(first)
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 1 })
    })

    it('joins through Telegram with the same generic reply text as the net-new path', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      reserveUpdate('update-bind-im', VALID_REQUEST_DIGEST, '9200700')

      const reply = await handleImMessage(env, '9200700', `/start ${created.value.pairing_code}`, {
        telegram: { update_id: 'update-bind-im', telegram_user_id: '9200700', request_digest: VALID_REQUEST_DIGEST },
      })

      expect(reply).toBe('Joined project project-bind. Use /needs to see what needs your attention.')
    })

    it('does not burn the invite when the target member is suspended — it is retryable once reactivated', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'member-existing'`)
      reserveUpdate('update-bind-suspended-retry-1', VALID_REQUEST_DIGEST, '9200800')
      await expect(redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200800',
        display_name: 'First Attempt',
        update_id: 'update-bind-suspended-retry-1',
        request_digest: VALID_REQUEST_DIGEST,
      })).resolves.toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })

      harness.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = 'member-existing'`)
      reserveUpdate('update-bind-suspended-retry-2', VALID_REQUEST_DIGEST, '9200800')
      const retry = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200800',
        display_name: 'Retry After Reactivation',
        update_id: 'update-bind-suspended-retry-2',
        request_digest: VALID_REQUEST_DIGEST,
      })
      expect(retry.ok).toBe(true)
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: '9200800' })
    })

    // Round 2 (Athena BLOCK, mupot#1411): CLAIM_INVITE_SQL's own bind_target
    // EXISTES now shares MEMBER_BIND_ELIGIBLE_SQL with bindMemberStatement —
    // an EXACT, non-NULL tenant match, the SAME fragment, the SAME bound
    // values. So a member reassigned to another tenant mid-flight is refused
    // at the CLAIM itself (statement 1), not merely at the downstream bind
    // statement — the invite is left INTACT and retryable, exactly like the
    // suspended-member case above, instead of being permanently burned for a
    // transient operator action. Replaces the round-1 "burns the invite, a
    // judgment call" behavior and its test.
    it('refuses at the claim (invite stays intact) when the target member is reassigned to another tenant mid-flight', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`UPDATE members SET tenant = 'a-different-tenant' WHERE id = 'member-existing'`)
      reserveUpdate('update-bind-tenant-reassigned', VALID_REQUEST_DIGEST, '9200900')

      const result = await redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9200900',
        display_name: 'Tenant Reassigned',
        update_id: 'update-bind-tenant-reassigned',
        request_digest: VALID_REQUEST_DIGEST,
      })

      expect(result).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
      expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-bind-tenant-reassigned'`).get())
        .toEqual({ state: 'processing' })
      // Invite INTACT — the claim itself refused, unlike round 1's behavior.
      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
    })

    // F1 / N4 (Athena BLOCK, round 2; Athena N4, round 4): a NULL-tenant
    // member can never be resolved by memberForChat (src/im/index.ts:95-97,
    // no NULL fallback), so binding one would silently grant a capability an
    // operator could never reach through Telegram. Round 2 made
    // MEMBER_BIND_ELIGIBLE_SQL's `tenant = ?` an exact, non-NULL match, so
    // redemption always refused — but CREATION still used the GET
    // /members/:id collapse shape (tenant = ? OR tenant IS NULL), so the
    // invite minted successfully and could then NEVER be redeemed: a
    // silent, permanent dead invite with no distinguishing error. Round 4
    // closes it at the SOURCE — creation now uses the same exact-tenant
    // predicate the eligibility fence enforces, so a NULL-tenant target is
    // refused immediately with member_not_found and no invite row is ever
    // created for it.
    it('N4 — refuses at CREATION (member_not_found), never mints a dead invite, when the target member has a NULL tenant', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-null-tenant', 'null-tenant@example.test', 'Null Tenant', 'active', NULL);
      `)
      const created = await createMemberInvite({ member_id: 'member-null-tenant' })
      expect(created).toEqual({ ok: false, error: 'member_not_found' })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM invites WHERE member_id = ?',
      ).get('member-null-tenant')).toEqual({ count: 0 })
    })

    // F2 (Athena BLOCK): a member ALREADY carrying the redeeming Telegram id
    // (from some unrelated history) plus a mid-flight tenant reassignment used
    // to slip past a state-only guard. With the shared MEMBER_BIND_ELIGIBLE_SQL
    // predicate, the claim itself refuses on the tenant mismatch — zero
    // capability rows, receipt left processing (never marked completed with a
    // success payload), and a replay of the SAME update_id returns the SAME
    // refusal, never a stored `ok:true` completion.
    it('F2 — refuses at the claim, grants nothing, when the target already carries the redeeming Telegram id AND was reassigned to another tenant', async () => {
      const created = await createMemberInvite()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      harness.sqlite.exec(`
        UPDATE members SET telegram_chat_id = '9201000', tenant = 'a-different-tenant'
         WHERE id = 'member-existing'
      `)
      reserveUpdate('update-bind-f2', VALID_REQUEST_DIGEST, '9201000')

      const attempt = () => redeemTelegramProjectInvite(env, {
        pairing_code: created.value.pairing_code,
        telegram_user_id: '9201000',
        display_name: 'F2',
        update_id: 'update-bind-f2',
        request_digest: VALID_REQUEST_DIGEST,
      })

      const first = await attempt()
      expect(first).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
      // Replay of the SAME update_id — receipt never flipped to 'completed',
      // so this re-runs the whole claim rather than short-circuiting to a
      // stored ok:true.
      const replay = await attempt()
      expect(replay).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })

      expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id))
        .toEqual({ accepted_at: null })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM capabilities WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
      expect(harness.sqlite.prepare(`SELECT state FROM telegram_webhook_receipts WHERE update_id = 'update-bind-f2'`).get())
        .toEqual({ state: 'processing' })
    })
  })

  // ── Seam test: the ONE eligibility predicate cannot drift ────────────────

  it('seam — the claim and the bind statement interpolate the IDENTICAL member-eligibility fragment', () => {
    expect(CLAIM_INVITE_SQL).toContain(MEMBER_BIND_ELIGIBLE_SQL)
    expect(MEMBER_BIND_UPDATE_SQL).toContain(MEMBER_BIND_ELIGIBLE_SQL)
  })

  // mupot#1411 N5 round 4 (Athena, 2026-09-15): identical SQL TEXT is not
  // proof the two call sites bind the SAME VALUES in the SAME ORDER into
  // that text's 3 placeholders (id, tenant, telegram_chat_id-compare) — a
  // transposed bind at only ONE of the two sites would still pass the text-
  // only seam test above while comparing the wrong facts at runtime. Spies
  // on both statements' real `.bind()` calls during one genuine redemption
  // and asserts the exact 3-tuple each site binds into the shared fragment.
  it('N5 — the claim and the bind statement bind the SAME (id, tenant, telegram) tuple, in the SAME order', async () => {
    const created = await createMemberInvite()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    reserveUpdate('update-bind-param-order', VALID_REQUEST_DIGEST, 'telegram-order-check')

    const captured: Record<string, unknown[]> = {}
    const realDb = env.DB
    const spyDb = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql === CLAIM_INVITE_SQL || sql === MEMBER_BIND_UPDATE_SQL) {
              captured[sql] = values
            }
            return realDb.prepare(sql).bind(...values)
          },
          first: (...args: unknown[]) => realDb.prepare(sql).first(...(args as [])),
          all: (...args: unknown[]) => realDb.prepare(sql).all(...(args as [])),
          run: (...args: unknown[]) => realDb.prepare(sql).run(...(args as [])),
        }
      },
      batch: realDb.batch.bind(realDb),
    } as unknown as Env['DB']
    const spyEnv: Env = { ...env, DB: spyDb }

    const result = await redeemTelegramProjectInvite(spyEnv, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: 'telegram-order-check',
      display_name: 'Order Check',
      update_id: 'update-bind-param-order',
      request_digest: VALID_REQUEST_DIGEST,
    })
    expect(result.ok).toBe(true)

    // CLAIM_INVITE_SQL's bind_target EXISTS is the LAST clause it
    // interpolates the shared fragment into -> the last 3 bound values.
    const claimValues = captured[CLAIM_INVITE_SQL]
    expect(claimValues).toBeDefined()
    expect(claimValues.slice(-3)).toEqual(['member-existing', TENANT, 'telegram-order-check'])

    // MEMBER_BIND_UPDATE_SQL binds its SET clause (2 values) first, then the
    // shared fragment's WHERE (3 values), then its own trailing EXISTS (2
    // values) -> the fragment's 3-tuple sits at index [2, 5).
    const bindValues = captured[MEMBER_BIND_UPDATE_SQL]
    expect(bindValues).toBeDefined()
    expect(bindValues.slice(2, 5)).toEqual(['member-existing', TENANT, 'telegram-order-check'])

    // And both sites agree with each other, not merely with the fixture —
    // the actual assertion N5 asks for.
    expect(claimValues.slice(-3)).toEqual(bindValues.slice(2, 5))
  })

  // ── Bind-landed proof: a stamp, not a state test ──────────────────────────

  it('MEMBER_BIND_LANDED_GUARD_SQL requires THIS claim\'s own stamp, not a pre-existing matching identity', () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, telegram_chat_id, telegram_bound_at, status, tenant)
      VALUES ('member-stale-stamp', 'stale@example.test', 'Stale Stamp', '9300000', '2020-01-01T00:00:00.000000Z', 'active', '${TENANT}')
    `)
    const thisClaimTimestamp = '2026-09-14T00:00:00.000000Z'
    // The member already carries the identity — a STATE test on
    // telegram_chat_id would already be satisfied here, before THIS claim's
    // own bindMemberStatement has run at all.
    const stateCheckWouldPass = harness.sqlite.prepare(
      `SELECT EXISTS (SELECT 1 FROM members WHERE id = ? AND telegram_chat_id = ?) AS landed`,
    ).get('member-stale-stamp', '9300000') as { landed: number }
    expect(stateCheckWouldPass.landed).toBe(1)

    // The exported, PRODUCTION guard — bound the same way bindMemberStatement
    // is — refuses: the stale stamp does not match THIS claim's timestamp.
    const stampGuardBefore = harness.sqlite.prepare(
      `SELECT ${MEMBER_BIND_LANDED_GUARD_SQL} AS landed`,
    ).get('member-stale-stamp', thisClaimTimestamp) as { landed: number }
    expect(stampGuardBefore.landed).toBe(0)

    // Only after THIS claim's own write lands does the production guard pass.
    harness.sqlite.exec(
      `UPDATE members SET telegram_bound_at = '${thisClaimTimestamp}' WHERE id = 'member-stale-stamp'`,
    )
    const stampGuardAfter = harness.sqlite.prepare(
      `SELECT ${MEMBER_BIND_LANDED_GUARD_SQL} AS landed`,
    ).get('member-stale-stamp', thisClaimTimestamp) as { landed: number }
    expect(stampGuardAfter.landed).toBe(1)
  })

  // ── HTTP route (POST /invites, member_id) ────────────────────────────────

  describe('POST /invites — member_id', () => {
    function ownerSession(): Env {
      const session = JSON.stringify({
        userId: 'bind-owner-user',
        email: 'bind-owner@example.test',
        role: 'owner',
        createdAt: new Date().toISOString(),
      })
      return {
        ...env,
        SESSIONS: {
          get: async (key: string) => key === 'sess:bind-owner' ? session : null,
          put: async () => undefined,
          delete: async () => undefined,
        },
      } as Env
    }

    it('mints a project invite for an existing member as admin/owner (201)', async () => {
      const response = await membersApp.request('/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
        body: JSON.stringify({
          kind: 'project',
          member_id: 'member-existing',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
          expires_in_seconds: 3600,
        }),
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(201)
      const body = await response.json() as { invite: { email: string; id: string } }
      expect(body.invite.email).toBe('existing-human@example.test')
    })

    it('refuses a non-admin caller (403 forbidden)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-route-nonadmin', 'route-nonadmin@example.test', 'Route Nonadmin', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-route-nonadmin', 'member-route-nonadmin', 'squad', 'squad-bind', 'member');
      `)
      const session = JSON.stringify({
        userId: 'route-nonadmin-user',
        email: 'route-nonadmin@example.test',
        role: 'member',
        createdAt: new Date().toISOString(),
      })
      const routeEnv = {
        ...env,
        SESSIONS: {
          get: async (key: string) => key === 'sess:route-nonadmin' ? session : null,
          put: async () => undefined,
          delete: async () => undefined,
        },
      } as Env

      const response = await membersApp.request('/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=route-nonadmin' },
        body: JSON.stringify({
          kind: 'project',
          member_id: 'member-existing',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
          expires_in_seconds: 3600,
        }),
      }, routeEnv)

      expect(response.status, await response.clone().text()).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM invites WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
    })

    it('refuses a member_id from another tenant (404)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-route-other-tenant', 'route-other-tenant@example.test', 'Other Tenant', 'active', 'a-different-tenant');
      `)
      const response = await membersApp.request('/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
        body: JSON.stringify({
          kind: 'project',
          member_id: 'member-route-other-tenant',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
          expires_in_seconds: 3600,
        }),
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(404)
      await expect(response.json()).resolves.toEqual({ error: 'member_not_found' })
    })

    it('refuses an inactive member (403)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-route-suspended', 'route-suspended@example.test', 'Route Suspended', 'suspended', '${TENANT}');
      `)
      const response = await membersApp.request('/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
        body: JSON.stringify({
          kind: 'project',
          member_id: 'member-route-suspended',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
          expires_in_seconds: 3600,
        }),
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: 'member_not_active' })
    })

    it('rejects a body supplying both member_id and email as an ambiguous scope (400)', async () => {
      const response = await membersApp.request('/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
        body: JSON.stringify({
          kind: 'project',
          member_id: 'member-existing',
          email: 'someone-else@example.test',
          project_id: 'project-bind',
          squad_id: 'squad-bind',
          capability: 'member',
          expires_in_seconds: 3600,
        }),
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'invalid_invite_scope' })
      expect(harness.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM invites WHERE member_id = 'member-existing'
      `).get()).toEqual({ count: 0 })
    })
  })

  // ── DELETE /members/:id/telegram (P0-1(d): bind must be reversible) ──────

  describe('DELETE /members/:id/telegram — admin unbind', () => {
    function ownerSession(): Env {
      const session = JSON.stringify({
        userId: 'bind-owner-user',
        email: 'bind-owner@example.test',
        role: 'owner',
        createdAt: new Date().toISOString(),
      })
      return {
        ...env,
        SESSIONS: {
          get: async (key: string) => key === 'sess:bind-owner' ? session : null,
          put: async () => undefined,
          delete: async () => undefined,
        },
      } as Env
    }

    function nonAdminSession(): Env {
      const session = JSON.stringify({
        userId: 'route-nonadmin-user',
        email: 'route-nonadmin@example.test',
        role: 'member',
        createdAt: new Date().toISOString(),
      })
      return {
        ...env,
        SESSIONS: {
          get: async (key: string) => key === 'sess:route-nonadmin' ? session : null,
          put: async () => undefined,
          delete: async () => undefined,
        },
      } as Env
    }

    it('an org admin unbinds a bound member\'s Telegram identity', async () => {
      harness.sqlite.exec(`
        UPDATE members SET telegram_chat_id = '9400000', telegram_bound_at = '2026-09-14T00:00:00.000000Z'
         WHERE id = 'member-existing'
      `)
      const response = await membersApp.request('/members/member-existing/telegram', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(200)
      await expect(response.json()).resolves.toEqual({ member_id: 'member-existing', telegram_unbound: true })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: null, telegram_bound_at: null })
    })

    it('404s when the member has no Telegram identity bound', async () => {
      const response = await membersApp.request('/members/member-existing/telegram', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(404)
      await expect(response.json()).resolves.toEqual({ error: 'telegram_not_bound' })
    })

    it('404s for a nonexistent member', async () => {
      const response = await membersApp.request('/members/member-does-not-exist/telegram', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=bind-owner' },
      }, ownerSession())

      expect(response.status, await response.clone().text()).toBe(404)
      await expect(response.json()).resolves.toEqual({ error: 'member_not_found' })
    })

    it('refuses a non-admin caller (403)', async () => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-route-nonadmin', 'route-nonadmin@example.test', 'Route Nonadmin', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-route-nonadmin', 'member-route-nonadmin', 'squad', 'squad-bind', 'member');
        UPDATE members SET telegram_chat_id = '9400100', telegram_bound_at = '2026-09-14T00:00:00.000000Z'
         WHERE id = 'member-existing';
      `)
      const response = await membersApp.request('/members/member-existing/telegram', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=route-nonadmin' },
      }, nonAdminSession())

      expect(response.status, await response.clone().text()).toBe(403)
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: '9400100' })
    })

    // Same target-rank ceiling as the mint/suspend/grant routes: an admin
    // cannot unbind a principal who outranks them EITHER — this is an act ON
    // that member, and the ceiling now looks at their standing everywhere.
    it('refuses an org admin unbinding a member who outranks them via a DIFFERENT scope', async () => {
      const adminAuth = JSON.stringify({
        userId: 'route-admin-user',
        email: 'route-admin@example.test',
        role: 'member',
        createdAt: new Date().toISOString(),
      })
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-route-admin', 'route-admin@example.test', 'Route Admin', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-route-admin-org', 'member-route-admin', 'org', NULL, 'admin');
        INSERT INTO departments (id, slug, name) VALUES ('department-unbind-secret', 'unbind-secret', 'Unbind Secret Dept');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-unbind-secret', 'department-unbind-secret', 'unbind-secret', 'Unbind Secret Squad');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-existing-secret-owner', 'member-existing', 'squad', 'squad-unbind-secret', 'owner');
        UPDATE members SET telegram_chat_id = '9400200', telegram_bound_at = '2026-09-14T00:00:00.000000Z'
         WHERE id = 'member-existing';
      `)
      const routeEnv = {
        ...env,
        SESSIONS: {
          get: async (key: string) => key === 'sess:route-admin' ? adminAuth : null,
          put: async () => undefined,
          delete: async () => undefined,
        },
      } as Env

      const response = await membersApp.request('/members/member-existing/telegram', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=route-admin' },
      }, routeEnv)

      expect(response.status, await response.clone().text()).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ reason: 'cannot_affect_higher_rank' })
      expect(harness.sqlite.prepare(`
        SELECT telegram_chat_id FROM members WHERE id = 'member-existing'
      `).get()).toEqual({ telegram_chat_id: '9400200' })
    })
  })
})

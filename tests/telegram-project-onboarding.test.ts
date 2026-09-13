import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectInvite,
  redeemTelegramProjectInvite,
} from '../src/members/project-invites'
import { membersApp } from '../src/members'
import { imApp } from '../src/im'
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
        ('project-archived', 'archived-project', 'Archived project', 'archived');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-active', 'squad-participants', 'write');
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-inviter', 'inviter@example.test', 'Inviter', 'active', '${TENANT}');
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

  it('refuses a capability above the inviter rank on the selected squad', async () => {
    await expect(createInvite('owner@example.test', { capability: 'owner' })).resolves.toEqual({
      ok: false,
      error: 'cannot_grant_above_own_rank',
    })
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
})

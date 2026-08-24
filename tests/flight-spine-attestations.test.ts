import { createHmac } from 'node:crypto'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  issueTokenBindingAttestation,
} from '../src/flight-spine/attestations'
import type { AuthContext, Capability } from '../src/types'
import type { MemberTokenFingerprintEnv } from '../src/members/service'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-attestations'
const NOW = '2026-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-command-seat'
const AGENT_ID = '087a0000-0000-4000-8000-000000000001'
const TOKEN_ID = 'token-command-seat'
const TOKEN_HASH = 'a'.repeat(64)
const FINGERPRINT_SECRET = 'dedicated-test-member-token-fingerprint-secret'
const TOKEN_EXPIRES_AT = '2099-08-24T16:00:00.000Z'

let harness: SqliteD1Harness
let env: MemberTokenFingerprintEnv

function envWithBeforeAttestationInsert(mutate: () => void): MemberTokenFingerprintEnv {
  const committedDb = env.DB
  let injected = false
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return wrap(statement.bind(...values))
    },
    async all<T>() {
      if (!injected) {
        injected = true
        mutate()
      }
      return statement.all<T>()
    },
  }) as D1PreparedStatement
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        const statement = committedDb.prepare(sql)
        return sql.includes('INSERT INTO token_binding_attestations')
          ? wrap(statement)
          : statement
      },
      batch: committedDb.batch.bind(committedDb),
    } as D1Database,
  }
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'command-seat@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
    ...overrides,
  }
}

function squadCapability(capability: Capability): NonNullable<AuthContext['capabilities']> {
  return [{
    member_id: MEMBER_ID,
    scope_type: 'squad',
    scope_id: 'squad-command',
    capability,
  }]
}

function seedIdentity(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-command', 'command', 'Command');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-command', 'department-command', 'command', 'Command');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES (
        '${AGENT_ID}', 'squad-command', 'hadi-codex', 'Hadi Codex',
        'member', 'test', 'active'
      );
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-command', '${AGENT_ID}', 'squad-command', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Hadi Codex Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-command', '${MEMBER_ID}', 'squad', 'squad-command', 'member');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${TOKEN_HASH}', 'hadi-codex-cli',
      'workspace', '2020-08-23T15:00:00.000Z', NULL, '${AGENT_ID}',
      '${TENANT}', '${TOKEN_EXPIRES_AT}'
    );
  `)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedIdentity()
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    MEMBER_TOKEN_FINGERPRINT_SECRET: FINGERPRINT_SECRET,
  } as MemberTokenFingerprintEnv
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine token-binding attestations', () => {
  it('derives a versioned HMAC fingerprint without returning plaintext or the stored token hash', async () => {
    const attestation = await issueTokenBindingAttestation(env, auth())
    const expected = `v1:${createHmac('sha256', FINGERPRINT_SECRET)
      .update(`mupot:member-token-fingerprint:v1:${TOKEN_HASH}`)
      .digest('hex')}`

    expect(attestation).toEqual({
      id: expect.any(String),
      tenant: TENANT,
      tokenId: TOKEN_ID,
      memberId: MEMBER_ID,
      agentId: AGENT_ID,
      channel: 'workspace',
      credentialFingerprint: expected,
      issuedAt: NOW,
      expiresAt: TOKEN_EXPIRES_AT,
      createdAt: NOW,
    })
    expect(attestation.credentialFingerprint).toMatch(/^v1:[0-9a-f]{64}$/)
    expect(attestation.credentialFingerprint).not.toBe(`v1:${TOKEN_HASH}`)
    expect(JSON.stringify(attestation)).not.toContain(TOKEN_HASH)
    expect(JSON.stringify(attestation)).not.toContain('mupot_')
    expect(harness.sqlite.prepare(`
      SELECT credential_fingerprint FROM token_binding_attestations
       WHERE tenant = ? AND token_id = ?
    `).get(TENANT, TOKEN_ID)).toEqual({ credential_fingerprint: expected })
  })

  it('fails closed when the dedicated fingerprint secret binding is absent', async () => {
    const unconfigured = {
      ...env,
      SOS_SECRET: 'must-not-be-used-as-a-fallback',
    } as Partial<MemberTokenFingerprintEnv>
    delete unconfigured.MEMBER_TOKEN_FINGERPRINT_SECRET

    await expect(issueTokenBindingAttestation(
      unconfigured as MemberTokenFingerprintEnv,
      auth(),
    )).rejects.toMatchObject({ code: 'fingerprint_not_configured' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it.each([
    ['workspace channel', () => auth({ channel: 'im' })],
    ['exact member', () => auth({ memberId: 'member-other', userId: 'member-other' })],
    ['exact agent', () => auth({ boundAgentId: 'agent-other' })],
    ['exact token', () => auth({ tokenId: 'token-other' })],
  ])('rereads and rejects a mismatched %s fact', async (_label, buildAuth) => {
    await expect(issueTokenBindingAttestation(env, buildAuth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
  })

  it.each([
    ['suspended member', `UPDATE members SET status = 'suspended' WHERE id = '${MEMBER_ID}'`],
    ['paused agent', `UPDATE agents SET status = 'paused' WHERE id = '${AGENT_ID}'`],
    ['revoked token', `UPDATE member_tokens SET revoked_at = '${NOW}' WHERE id = '${TOKEN_ID}'`],
    ['expired token', `UPDATE member_tokens SET expires_at = '2026-08-23T15:59:59.000Z' WHERE id = '${TOKEN_ID}'`],
  ])('rejects a %s rather than trusting an earlier authentication result', async (_label, sql) => {
    harness.sqlite.exec(sql)

    await expect(issueTokenBindingAttestation(env, auth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
  })

  it.each([
    ['directory zero ceiling', auth({ channel: 'directory', capabilities: [] })],
    ['workspace empty ceiling', auth({ capabilities: [] })],
    ['workspace observer ceiling', auth({ capabilities: squadCapability('observer') })],
  ])('denies a %s before issuing an attestation', async (_label, deniedAuth) => {
    await expect(issueTokenBindingAttestation(env, deniedAuth))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it('uses SQLite statement time when token expiry elapses between preflight and insert', async () => {
    const sqliteNow = new Date((harness.sqlite.prepare(`
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now
    `).get() as { now: string }).now).getTime()
    const preflight = new Date(sqliteNow - 60_000)
    const elapsedExpiry = new Date(sqliteNow - 1_000).toISOString()
    vi.setSystemTime(preflight)
    const racedEnv = envWithBeforeAttestationInsert(() => {
      harness.sqlite.prepare(`
        UPDATE member_tokens SET expires_at = ? WHERE id = ?
      `).run(elapsedExpiry, TOKEN_ID)
    })

    await expect(issueTokenBindingAttestation(racedEnv, auth({
      capabilities: squadCapability('member'),
    }))).rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it.each([
    ['removed agent membership', `DELETE FROM memberships WHERE id = 'membership-command'`],
    ['downgraded agent membership', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
    ['revoked human grant', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['downgraded human grant', `UPDATE capabilities SET capability = 'observer' WHERE id = 'capability-command'`],
  ])('denies a %s before issuing an attestation', async (_label, mutation) => {
    harness.sqlite.exec(mutation)

    await expect(issueTokenBindingAttestation(env, auth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it.each([
    ['removed agent membership', `DELETE FROM memberships WHERE id = 'membership-command'`],
    ['downgraded agent membership', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
    ['revoked human grant', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['downgraded human grant', `UPDATE capabilities SET capability = 'observer' WHERE id = 'capability-command'`],
  ])('does not replay an existing attestation after %s', async (_label, mutation) => {
    const first = await issueTokenBindingAttestation(env, auth())
    harness.sqlite.exec(mutation)

    await expect(issueTokenBindingAttestation(env, auth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(`
      SELECT id FROM token_binding_attestations WHERE token_id = ?
    `).get(TOKEN_ID)).toEqual({ id: first.id })
  })

  it.each([
    ['agent membership removal', `DELETE FROM memberships WHERE id = 'membership-command'`],
    ['agent membership downgrade', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
    ['human grant revocation', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['human grant downgrade', `UPDATE capabilities SET capability = 'observer' WHERE id = 'capability-command'`],
  ])('rejects %s between authority preflight and immutable insert', async (_label, mutation) => {
    const racedEnv = envWithBeforeAttestationInsert(() => harness.sqlite.exec(mutation))

    await expect(issueTokenBindingAttestation(racedEnv, auth({
      capabilities: squadCapability('member'),
    }))).rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it('rechecks liveness before replaying an existing immutable attestation', async () => {
    const first = await issueTokenBindingAttestation(env, auth())
    const replay = await issueTokenBindingAttestation(env, auth())
    expect(replay).toEqual(first)

    harness.sqlite.exec(
      `UPDATE member_tokens SET revoked_at = '${NOW}' WHERE id = '${TOKEN_ID}'`,
    )
    await expect(issueTokenBindingAttestation(env, auth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
  })

  it('rejects a token-hash replacement between HMAC preflight and immutable insert', async () => {
    const racedEnv = envWithBeforeAttestationInsert(() => {
      harness.sqlite.prepare(`
        UPDATE member_tokens SET token_hash = ? WHERE id = ?
      `).run('b'.repeat(64), TOKEN_ID)
    })

    await expect(issueTokenBindingAttestation(racedEnv, auth()))
      .rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 0 })
  })

  it('persists immutable token-binding attestations', async () => {
    const attestation = await issueTokenBindingAttestation(env, auth())

    expect(() => harness.sqlite.prepare(`
      UPDATE token_binding_attestations SET expires_at = NULL WHERE id = ?
    `).run(attestation.id)).toThrow(/token binding attestations are immutable/i)
    expect(() => harness.sqlite.prepare(`
      DELETE FROM token_binding_attestations WHERE id = ?
    `).run(attestation.id)).toThrow(/token binding attestations are immutable/i)
  })
})

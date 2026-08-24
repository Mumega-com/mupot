import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireRuntimeSeatLease,
  registerPendingRuntimeSeat,
  releaseRuntimeSeatLease,
  renewRuntimeSeatLease,
} from '../src/flight-spine/seats'
import { appendExecutionReceipt } from '../src/flight-spine/receipts'
import type { AuthContext, Capability } from '../src/types'
import type { MemberTokenFingerprintEnv } from '../src/members/service'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-seats'
const NOW = '2030-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-command-seat'
const AGENT_ID = '087a0000-0000-4000-8000-000000000001'
const TOKEN_ID = 'token-command-seat'
const TOKEN_HASH = 'a'.repeat(64)
const FINGERPRINT_SECRET = 'dedicated-test-member-token-fingerprint-secret'
const LEASE_HASH_A = 'b'.repeat(64)
const LEASE_HASH_B = 'c'.repeat(64)

let harness: SqliteD1Harness
let env: MemberTokenFingerprintEnv

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

function count(table: string): number {
  return Number((harness.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number }).count)
}

function sqliteClockWindow(): {
  preflight: Date
  elapsedExpiry: string
  futureExpiry: string
  laterFutureExpiry: string
} {
  const row = harness.sqlite.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now
  `).get() as { now: string }
  const sqliteNow = new Date(row.now).getTime()
  return {
    preflight: new Date(sqliteNow - 60_000),
    elapsedExpiry: new Date(sqliteNow - 1_000).toISOString(),
    futureExpiry: new Date(sqliteNow + 10 * 60_000).toISOString(),
    laterFutureExpiry: new Date(sqliteNow + 20 * 60_000).toISOString(),
  }
}

function envWithBeforeBatch(mutate: () => void): MemberTokenFingerprintEnv {
  const committedDb = env.DB
  let injected = false
  return {
    ...env,
    DB: {
      prepare: committedDb.prepare.bind(committedDb),
      async batch(statements) {
        if (!injected) {
          injected = true
          mutate()
        }
        return committedDb.batch(statements)
      },
    } as D1Database,
  }
}

function envWithBeforeAll(pattern: RegExp, mutate: () => void): MemberTokenFingerprintEnv {
  const committedDb = env.DB
  let injected = false
  const wrap = (statement: D1PreparedStatement, matches: boolean): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return wrap(statement.bind(...values), matches)
    },
    async all<T>() {
      if (matches && !injected) {
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
        return pattern.test(sql) ? wrap(statement, true) : statement
      },
      batch: committedDb.batch.bind(committedDb),
    } as D1Database,
  }
}

function pendingInput(seatName: string) {
  return {
    seatName,
    hostId: 'hadi-mac',
    adapterKind: 'codex-desktop',
    capabilities: ['command'],
  }
}

function activateSeat(id = 'seat-live'): void {
  harness.sqlite.prepare(`
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, process_public_key,
      credential_fingerprint, capabilities_json, last_heartbeat_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 'hadi-mac', 'codex-desktop', 'active',
      1, 0, 'public-key-generation-1', NULL, '["command"]', ?, ?, ?
    )
  `).run(id, TENANT, AGENT_ID, `codex-desktop-${id}`, NOW, NOW, NOW)
  harness.sqlite.prepare(`
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (?, ?, ?, 1, 'hadi-mac', 'pid-1', 'uid-1', 'sandbox-1', ?,
              'public-key-generation-1', ?, ?, ?)
  `).run(`generation:${id}:1`, TENANT, id, 'd'.repeat(64), 'e'.repeat(64), NOW, NOW)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
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
      '${TENANT}', '2099-08-24T16:00:00.000Z'
    );
  `)
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

describe('Flight Spine pending runtime seats', () => {
  it('registers multiple named pending seats to the authenticated agent, never the local token label', async () => {
    const command = await registerPendingRuntimeSeat(
      env,
      auth(),
      pendingInput('codex-desktop-command'),
    )
    const review = await registerPendingRuntimeSeat(
      env,
      auth(),
      pendingInput('codex-desktop-review'),
    )

    expect(command.seat).toMatchObject({
      tenant: TENANT,
      agentId: AGENT_ID,
      seatName: 'codex-desktop-command',
      state: 'pending',
      currentGeneration: 0,
      currentFencingEpoch: 0,
      processPublicKey: null,
    })
    expect(command.seat.agentId).not.toBe('hadi-codex-cli')
    expect(JSON.stringify(command)).not.toContain(TOKEN_HASH)
    expect(review.seat).toMatchObject({
      agentId: AGENT_ID,
      seatName: 'codex-desktop-review',
      state: 'pending',
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM runtime_seats WHERE agent_id = ?',
    ).get(AGENT_ID)).toEqual({ count: 2 })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM token_binding_attestations',
    ).get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM seat_attestations',
    ).get()).toEqual({ count: 2 })
  })

  it('rejects a duplicate seat name for the same agent without a second seat fact', async () => {
    await registerPendingRuntimeSeat(env, auth(), pendingInput('codex-desktop-command'))

    await expect(registerPendingRuntimeSeat(
      env,
      auth(),
      pendingInput('codex-desktop-command'),
    )).rejects.toMatchObject({ code: 'duplicate_seat' })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM runtime_seats',
    ).get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM seat_attestations',
    ).get()).toEqual({ count: 1 })
  })

  it('rejects caller-supplied live-runtime claims and never leases a pending seat', async () => {
    await expect(registerPendingRuntimeSeat(env, auth(), {
      ...pendingInput('codex-desktop-command'),
      state: 'active',
      currentGeneration: 1,
      processPublicKey: 'caller-key',
    } as unknown as Parameters<typeof registerPendingRuntimeSeat>[2]))
      .rejects.toMatchObject({ code: 'invalid_seat' })

    const registered = await registerPendingRuntimeSeat(
      env,
      auth(),
      pendingInput('codex-desktop-command'),
    )
    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: registered.seat.id,
      generation: 1,
      consumerId: 'consumer-command',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })).rejects.toMatchObject({ code: 'seat_not_active' })
  })

  it('persists immutable pending-seat attestations', async () => {
    const registered = await registerPendingRuntimeSeat(
      env,
      auth(),
      pendingInput('codex-desktop-command'),
    )

    expect(() => harness.sqlite.prepare(`
      UPDATE seat_attestations SET expires_at = NULL WHERE id = ?
    `).run(registered.attestation.id)).toThrow(/seat attestations are immutable/i)
    expect(() => harness.sqlite.prepare(`
      DELETE FROM seat_attestations WHERE id = ?
    `).run(registered.attestation.id)).toThrow(/seat attestations are immutable/i)
  })

  it.each([
    ['directory zero ceiling', auth({ channel: 'directory', capabilities: [] })],
    ['workspace empty ceiling', auth({ capabilities: [] })],
    ['workspace observer ceiling', auth({ capabilities: squadCapability('observer') })],
  ])('denies %s without creating any registration facts', async (_label, deniedAuth) => {
    await expect(registerPendingRuntimeSeat(
      env,
      deniedAuth,
      pendingInput('codex-desktop-denied'),
    )).rejects.toMatchObject({ code: 'workspace_token_required' })
    expect(count('token_binding_attestations')).toBe(0)
    expect(count('runtime_seats')).toBe(0)
    expect(count('seat_attestations')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it.each([
    ['agent membership removal', `DELETE FROM memberships WHERE id = 'membership-command'`],
    ['agent membership downgrade', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
    ['human grant revocation', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['human grant downgrade', `UPDATE capabilities SET capability = 'observer' WHERE id = 'capability-command'`],
    ['token hash replacement', `UPDATE member_tokens SET token_hash = '${'f'.repeat(64)}' WHERE id = '${TOKEN_ID}'`],
  ])('rolls registration back when %s wins after attestation preflight', async (_label, mutation) => {
    const racedEnv = envWithBeforeBatch(() => harness.sqlite.exec(mutation))

    await expect(registerPendingRuntimeSeat(
      racedEnv,
      auth({ capabilities: squadCapability('member') }),
      pendingInput('codex-desktop-raced'),
    )).rejects.toBeTruthy()
    expect(count('token_binding_attestations')).toBe(1)
    expect(count('runtime_seats')).toBe(0)
    expect(count('seat_attestations')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('uses SQLite statement time when token expiry elapses before the registration batch', async () => {
    const clock = sqliteClockWindow()
    vi.setSystemTime(clock.preflight)
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`
        UPDATE member_tokens SET expires_at = ? WHERE id = ?
      `).run(clock.elapsedExpiry, TOKEN_ID)
    })

    await expect(registerPendingRuntimeSeat(
      racedEnv,
      auth({ capabilities: squadCapability('member') }),
      pendingInput('codex-desktop-expired-race'),
    )).rejects.toBeTruthy()
    expect(count('token_binding_attestations')).toBe(1)
    expect(count('runtime_seats')).toBe(0)
    expect(count('seat_attestations')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })
})

describe('Flight Spine server-only runtime-seat fencing', () => {
  it.each([
    ['directory zero ceiling', auth({ channel: 'directory', capabilities: [] })],
    ['workspace empty ceiling', auth({ capabilities: [] })],
    ['workspace observer ceiling', auth({ capabilities: squadCapability('observer') })],
  ])('denies %s even while the database still holds member authority', async (_label, deniedAuth) => {
    activateSeat()

    await expect(acquireRuntimeSeatLease(env, deniedAuth, {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-denied',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })).rejects.toMatchObject({ code: 'lease_forbidden' })
    expect(count('runtime_seat_leases')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('accepts an explicit member ceiling and a legacy undefined capability view with a live grant', async () => {
    activateSeat('seat-member-view')
    activateSeat('seat-legacy-view')

    const explicit = await acquireRuntimeSeatLease(env, auth({
      capabilities: squadCapability('member'),
    }), {
      runtimeSeatId: 'seat-member-view',
      generation: 1,
      consumerId: 'consumer-explicit-member',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })
    const legacy = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-legacy-view',
      generation: 1,
      consumerId: 'consumer-legacy-member',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })

    expect(explicit.state).toBe('active')
    expect(legacy.state).toBe('active')
  })

  it.each([
    ['member grant revoke', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['agent membership downgrade', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
  ])('rolls acquisition back when %s wins between preflight and DML', async (_label, mutation) => {
    activateSeat()
    const racedEnv = envWithBeforeBatch(() => harness.sqlite.exec(mutation))

    await expect(acquireRuntimeSeatLease(racedEnv, auth({
      capabilities: squadCapability('member'),
    }), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-raced-authority',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })).rejects.toBeTruthy()
    expect(count('runtime_seat_leases')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it.each([
    '2030-08-23T16:10:00Z',
    '2030-08-23 16:10:00.000Z',
    'Fri, 23 Aug 2030 16:10:00 GMT',
    '8/23/2030, 4:10:00 PM',
    '2030-08-23T12:10:00.000-04:00',
    'not-a-date',
  ])('rejects noncanonical acquisition and renewal expiry %s', async (expiresAt) => {
    activateSeat()
    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-invalid-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt,
    })).rejects.toMatchObject({ code: 'invalid_seat' })
    expect(count('runtime_seat_leases')).toBe(0)

    const active = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-valid-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })
    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: active.fencingEpoch,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt,
    })).rejects.toMatchObject({ code: 'invalid_seat' })
    expect(harness.sqlite.prepare(`
      SELECT expires_at, renewed_at FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)).toEqual({
      expires_at: '2030-08-23T16:10:00.000Z',
      renewed_at: null,
    })
  })

  it('uses SQLite statement time to roll back an acquisition whose lease expiry already elapsed', async () => {
    activateSeat()
    const clock = sqliteClockWindow()
    vi.setSystemTime(clock.preflight)

    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-sqlite-lease-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.elapsedExpiry,
    })).rejects.toBeTruthy()
    expect(count('runtime_seat_leases')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('uses SQLite statement time to roll back acquisition after the exact token expires', async () => {
    activateSeat()
    const clock = sqliteClockWindow()
    harness.sqlite.prepare(`
      UPDATE member_tokens SET expires_at = ? WHERE id = ?
    `).run(clock.elapsedExpiry, TOKEN_ID)
    vi.setSystemTime(clock.preflight)

    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-sqlite-token-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.futureExpiry,
    })).rejects.toBeTruthy()
    expect(count('runtime_seat_leases')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('uses SQLite statement time to reject renewal of an already expired active lease', async () => {
    activateSeat()
    const clock = sqliteClockWindow()
    vi.setSystemTime(clock.preflight)
    const active = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-sqlite-renew-lease-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.futureExpiry,
    })
    harness.sqlite.prepare(`
      UPDATE runtime_seat_leases SET expires_at = ? WHERE id = ?
    `).run(clock.elapsedExpiry, active.id)
    const beforeLease = harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)
    const beforeReceipts = count('execution_receipts')
    const beforeAudits = count('mutation_audit_entries')
    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: active.fencingEpoch,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.laterFutureExpiry,
    })).rejects.toMatchObject({ code: 'stale_lease' })
    expect(harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)).toEqual(beforeLease)
    expect(count('execution_receipts')).toBe(beforeReceipts)
    expect(count('mutation_audit_entries')).toBe(beforeAudits)
  })

  it('uses SQLite statement time to reject renewal after the exact token expires', async () => {
    activateSeat()
    const clock = sqliteClockWindow()
    vi.setSystemTime(clock.preflight)
    const active = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-sqlite-renew-token-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.futureExpiry,
    })
    harness.sqlite.prepare(`
      UPDATE member_tokens SET expires_at = ? WHERE id = ?
    `).run(clock.elapsedExpiry, TOKEN_ID)
    const beforeLease = harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)
    const beforeReceipts = count('execution_receipts')
    const beforeAudits = count('mutation_audit_entries')
    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: active.fencingEpoch,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.laterFutureExpiry,
    })).rejects.toMatchObject({ code: 'stale_lease' })
    expect(harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)).toEqual(beforeLease)
    expect(count('execution_receipts')).toBe(beforeReceipts)
    expect(count('mutation_audit_entries')).toBe(beforeAudits)
  })

  it('uses SQLite statement time to reject release after the exact token expires', async () => {
    activateSeat()
    const clock = sqliteClockWindow()
    vi.setSystemTime(clock.preflight)
    const active = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-sqlite-release-token-expiry',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: clock.futureExpiry,
    })
    harness.sqlite.prepare(`
      UPDATE member_tokens SET expires_at = ? WHERE id = ?
    `).run(clock.elapsedExpiry, TOKEN_ID)
    const beforeLease = harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)
    const beforeReceipts = count('execution_receipts')
    const beforeAudits = count('mutation_audit_entries')
    await expect(releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: active.fencingEpoch,
      leaseTokenHash: LEASE_HASH_A,
    })).rejects.toMatchObject({ code: 'stale_lease' })
    expect(harness.sqlite.prepare(`
      SELECT state, expires_at, renewed_at, released_at
        FROM runtime_seat_leases WHERE id = ?
    `).get(active.id)).toEqual(beforeLease)
    expect(count('execution_receipts')).toBe(beforeReceipts)
    expect(count('mutation_audit_entries')).toBe(beforeAudits)
  })

  it('persists and loads the exact acquired receipt ID despite a competing same-tuple receipt', async () => {
    activateSeat()
    const competing = await appendExecutionReceipt(env, auth(), {
      type: 'seat.leased',
      idempotencyKey: 'competing-seat-lease-receipt',
      seatId: 'seat-live',
      seatGeneration: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_B,
      claims: { competing: true },
    })

    const acquired = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-exact-receipt',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })

    expect(acquired.receiptId).not.toBe(competing.id)
    expect(acquired.id).toBe(acquired.receiptId)
    expect(harness.sqlite.prepare(`
      SELECT id FROM runtime_seat_leases WHERE id = ?
    `).get(acquired.receiptId)).toEqual({ id: acquired.receiptId })
  })

  it('records the frozen internal lease origin and exact handler', async () => {
    activateSeat()
    const acquired = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-origin',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })

    expect(harness.sqlite.prepare(`
      SELECT origin, handler, target_id FROM mutation_audit_entries
       WHERE target_kind = 'runtime_seat_lease'
    `).get()).toEqual({
      origin: 'worker_callback',
      handler: 'flight_spine.acquire_runtime_seat_lease',
      target_id: acquired.id,
    })
  })

  it('allows one active lease and advances fencing epochs only after exact release', async () => {
    activateSeat()
    const first = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-command',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })

    expect(first).toMatchObject({
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      consumerId: 'consumer-command',
      state: 'active',
      receiptId: expect.any(String),
    })
    expect(JSON.stringify(first)).not.toContain(LEASE_HASH_A)
    expect(harness.sqlite.prepare(`
      SELECT type, seat_id, seat_generation, fencing_epoch, lease_token_hash
        FROM execution_receipts WHERE id = ?
    `).get(first.receiptId)).toEqual({
      type: 'seat.leased',
      seat_id: 'seat-live',
      seat_generation: 1,
      fencing_epoch: 1,
      lease_token_hash: LEASE_HASH_A,
    })

    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-review',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })).rejects.toMatchObject({ code: 'active_lease_exists' })

    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:20:00.000Z',
    })).rejects.toMatchObject({ code: 'stale_lease' })
    const renewed = await renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:20:00.000Z',
    })
    expect(renewed).toMatchObject({
      fencingEpoch: 1,
      expiresAt: '2030-08-23T16:20:00.000Z',
      renewedAt: NOW,
    })

    await expect(releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 2,
      leaseTokenHash: LEASE_HASH_A,
    })).rejects.toMatchObject({ code: 'stale_lease' })
    const released = await releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_A,
    })
    expect(released).toMatchObject({ state: 'released', releasedAt: NOW })
    expect(harness.sqlite.prepare(`
      SELECT current_fencing_epoch FROM runtime_seats WHERE id = 'seat-live'
    `).get()).toEqual({ current_fencing_epoch: 1 })
    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:30:00.000Z',
    })).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_A,
    })).rejects.toMatchObject({ code: 'stale_lease' })

    const second = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-review',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:30:00.000Z',
    })
    expect(second.fencingEpoch).toBe(2)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM runtime_seat_leases
       WHERE runtime_seat_id = 'seat-live' AND state = 'active'
    `).get()).toEqual({ count: 1 })
  })

  it('rejects stale generations and revoked seats without changing a live lease', async () => {
    activateSeat()
    const first = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-command',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2030-08-23T16:10:00.000Z',
    })
    await releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: first.fencingEpoch,
      leaseTokenHash: LEASE_HASH_A,
    })
    harness.sqlite.prepare(`
      INSERT INTO runtime_seat_generations (
        id, tenant, runtime_seat_id, generation, host_id, process_id,
        process_uid, sandbox_id, executable_digest, public_key,
        broker_attestation_digest, started_at, created_at
      ) VALUES ('generation:seat-live:2', ?, 'seat-live', 2, 'hadi-mac',
                'pid-2', 'uid-2', 'sandbox-2', ?, 'public-key-generation-2',
                ?, ?, ?)
    `).run(TENANT, '1'.repeat(64), '2'.repeat(64), NOW, NOW)
    harness.sqlite.prepare(`
      UPDATE runtime_seats
         SET current_generation = 2, process_public_key = 'public-key-generation-2'
       WHERE id = 'seat-live'
    `).run()

    await expect(acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-stale',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:20:00.000Z',
    })).rejects.toMatchObject({ code: 'stale_generation' })
    const current = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 2,
      consumerId: 'consumer-current',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:20:00.000Z',
    })
    expect(current.fencingEpoch).toBe(2)
    expect(() => harness.sqlite.prepare(`
      UPDATE runtime_seats SET current_generation = 1 WHERE id = 'seat-live'
    `).run()).toThrow(/generation must be monotonic/i)
    expect(() => harness.sqlite.prepare(`
      UPDATE runtime_seats SET current_fencing_epoch = 0 WHERE id = 'seat-live'
    `).run()).toThrow(/fencing epoch must be monotonic/i)

    harness.sqlite.prepare(`
      UPDATE runtime_seats SET state = 'revoked', revoked_at = ? WHERE id = 'seat-live'
    `).run(NOW)
    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 2,
      fencingEpoch: current.fencingEpoch,
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2030-08-23T16:30:00.000Z',
    })).rejects.toMatchObject({ code: 'seat_revoked' })
    await expect(releaseRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 2,
      fencingEpoch: current.fencingEpoch,
      leaseTokenHash: LEASE_HASH_B,
    })).rejects.toMatchObject({ code: 'seat_revoked' })
    expect(harness.sqlite.prepare(`
      SELECT state FROM runtime_seat_leases WHERE id = ?
    `).get(current.id)).toEqual({ state: 'active' })
  })

  const identityRaces = [
    ['token revoke', `UPDATE member_tokens SET revoked_at = '${NOW}' WHERE id = '${TOKEN_ID}'`],
    ['token hash replacement', `UPDATE member_tokens SET token_hash = '${'f'.repeat(64)}' WHERE id = '${TOKEN_ID}'`],
    ['member suspension', `UPDATE members SET status = 'suspended' WHERE id = '${MEMBER_ID}'`],
    ['agent pause', `UPDATE agents SET status = 'paused' WHERE id = '${AGENT_ID}'`],
    ['member grant revoke', `DELETE FROM capabilities WHERE id = 'capability-command'`],
    ['agent membership downgrade', `UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'`],
  ] as const

  for (const operation of ['renew', 'release'] as const) {
    it.each(identityRaces)(
      `${operation} rejects a %s race with zero lease, audit, or receipt change`,
      async (_label, mutation) => {
        activateSeat()
        const active = await acquireRuntimeSeatLease(env, auth(), {
          runtimeSeatId: 'seat-live',
          generation: 1,
          consumerId: `consumer-${operation}-race`,
          leaseTokenHash: LEASE_HASH_A,
          expiresAt: '2030-08-23T16:10:00.000Z',
        })
        const beforeLease = harness.sqlite.prepare(`
          SELECT state, expires_at, renewed_at, released_at
            FROM runtime_seat_leases WHERE id = ?
        `).get(active.id)
        const beforeReceipts = count('execution_receipts')
        const beforeAudits = count('mutation_audit_entries')
        const racedEnv = operation === 'renew'
          ? envWithBeforeAll(
              /UPDATE runtime_seat_leases AS lease/,
              () => harness.sqlite.exec(mutation),
            )
          : envWithBeforeBatch(() => harness.sqlite.exec(mutation))

        const attempt = operation === 'renew'
          ? renewRuntimeSeatLease(racedEnv, auth(), {
              runtimeSeatId: 'seat-live',
              generation: 1,
              fencingEpoch: active.fencingEpoch,
              leaseTokenHash: LEASE_HASH_A,
              expiresAt: '2030-08-23T16:20:00.000Z',
            })
          : releaseRuntimeSeatLease(racedEnv, auth(), {
              runtimeSeatId: 'seat-live',
              generation: 1,
              fencingEpoch: active.fencingEpoch,
              leaseTokenHash: LEASE_HASH_A,
            })
        await expect(attempt).rejects.toBeTruthy()
        expect(harness.sqlite.prepare(`
          SELECT state, expires_at, renewed_at, released_at
            FROM runtime_seat_leases WHERE id = ?
        `).get(active.id)).toEqual(beforeLease)
        expect(count('execution_receipts')).toBe(beforeReceipts)
        expect(count('mutation_audit_entries')).toBe(beforeAudits)
      },
    )
  }
})

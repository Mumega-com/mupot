import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireRuntimeSeatLease,
  registerPendingRuntimeSeat,
  releaseRuntimeSeatLease,
  renewRuntimeSeatLease,
} from '../src/flight-spine/seats'
import type { AuthContext } from '../src/types'
import type { MemberTokenFingerprintEnv } from '../src/members/service'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-seats'
const NOW = '2026-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-command-seat'
const AGENT_ID = '087a0000-0000-4000-8000-000000000001'
const TOKEN_ID = 'token-command-seat'
const TOKEN_HASH = 'a'.repeat(64)
const FINGERPRINT_SECRET = 'dedicated-test-member-token-fingerprint-secret'
const LEASE_HASH_A = 'b'.repeat(64)
const LEASE_HASH_B = 'c'.repeat(64)

let harness: SqliteD1Harness
let env: MemberTokenFingerprintEnv

function auth(): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'command-seat@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
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
      ?, ?, ?, 'codex-desktop-live', 'hadi-mac', 'codex-desktop', 'active',
      1, 0, 'public-key-generation-1', NULL, '["command"]', ?, ?, ?
    )
  `).run(id, TENANT, AGENT_ID, NOW, NOW, NOW)
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
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${TOKEN_HASH}', 'hadi-codex-cli',
      'workspace', '2026-08-23T15:00:00.000Z', NULL, '${AGENT_ID}',
      '${TENANT}', '2026-08-24T16:00:00.000Z'
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
      expiresAt: '2026-08-23T16:10:00.000Z',
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
})

describe('Flight Spine server-only runtime-seat fencing', () => {
  it('allows one active lease and advances fencing epochs only after exact release', async () => {
    activateSeat()
    const first = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      consumerId: 'consumer-command',
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2026-08-23T16:10:00.000Z',
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
      expiresAt: '2026-08-23T16:10:00.000Z',
    })).rejects.toMatchObject({ code: 'active_lease_exists' })

    await expect(renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2026-08-23T16:20:00.000Z',
    })).rejects.toMatchObject({ code: 'stale_lease' })
    const renewed = await renewRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 1,
      fencingEpoch: 1,
      leaseTokenHash: LEASE_HASH_A,
      expiresAt: '2026-08-23T16:20:00.000Z',
    })
    expect(renewed).toMatchObject({
      fencingEpoch: 1,
      expiresAt: '2026-08-23T16:20:00.000Z',
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
      expiresAt: '2026-08-23T16:30:00.000Z',
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
      expiresAt: '2026-08-23T16:30:00.000Z',
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
      expiresAt: '2026-08-23T16:10:00.000Z',
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
      expiresAt: '2026-08-23T16:20:00.000Z',
    })).rejects.toMatchObject({ code: 'stale_generation' })
    const current = await acquireRuntimeSeatLease(env, auth(), {
      runtimeSeatId: 'seat-live',
      generation: 2,
      consumerId: 'consumer-current',
      leaseTokenHash: LEASE_HASH_B,
      expiresAt: '2026-08-23T16:20:00.000Z',
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
      expiresAt: '2026-08-23T16:30:00.000Z',
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
})

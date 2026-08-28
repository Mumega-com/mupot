// tests/delivery-turn-fencing.test.ts — Verification of FLIGHT DELIV-03 / #1031 & #1050.
//
// Invariants verified:
//   1. Thread-bound dynamic delivery consumption tool (`mupot_delivery_consumed_v1`) with SQLite-backed fencing.
//   2. Strict validation of 5-tuple: {threadId, turnId, generation, correlation, nonce_hash}.
//   3. Cross-turn rejection: earlier/later turn attempts fail with 409 cross_turn_rejection.
//   4. Cross-thread rejection: calls from a different threadId fail with 409 cross_thread_rejection.
//   5. Stale generation rejection: bumped seat generation calls fail with 409 stale_generation.
//   6. Nonce replay prevention: repeat consumption fails with 409 already_consumed.
//   7. Presence session epoch & lease TTL storage and propagation (#1031).
//   8. Seat dispatchability & undispatchable state derivation on blank labels (#1050).

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  registerDeliveryTurnFence,
  consumeDeliveryTurnFence,
  invalidateThreadTurnFences,
} from '../src/flight-spine/delivery-turn-fencing'
import { registerModule, heartbeatModule, listPresence } from '../src/registry/service'
import { recordCheckin } from '../src/fleet/presence'
import { classify } from '../src/dashboard/fleet'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT DELIV-03: Thread-Bound Delivery Turn Fencing & Presence Leases (#1031 & #1050)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env

  const TENANT = 'mumega'
  const AGENT_ID = '96e85516-720b-47fd-9cb6-655eecc919aa'
  const MEMBER_ID = 'member-river-lead'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env
  })

  describe('1. Thread-Bound Delivery Turn Fencing Service', () => {
    it('successfully consumes a delivery turn fence when exact 5-tuple matches', async () => {
      const deliveryId = 'deliv-001'
      const threadId = 'thread-chat-1'
      const turnId = 'turn-10'
      const generation = 1
      const correlation = 'corr-req-123'
      const nonce = 'random-nonce-sec-12345678'

      // Register active fence
      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlationId: correlation,
        nonce,
      })

      // Consume fence
      const outcome = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlation,
        nonce,
        summary: 'Completed execution turn successfully',
      })

      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.deliveryId).toBe(deliveryId)
        expect(outcome.status).toBe('consumed')
      }

      // Verify row in database
      const row = await harness.db.prepare(
        'SELECT status, consumed_at FROM delivery_turn_fences WHERE delivery_id = ?1'
      ).bind(deliveryId).first<{ status: string; consumed_at: string | null }>()
      expect(row?.status).toBe('consumed')
      expect(row?.consumed_at).not.toBeNull()
    })

    it('rejects cross-turn consumption when turnId does not match active turn', async () => {
      const deliveryId = 'deliv-002'
      const threadId = 'thread-chat-1'
      const activeTurnId = 'turn-2'
      const generation = 1
      const correlation = 'corr-req-200'
      const nonce = 'nonce-for-turn-2'

      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId: activeTurnId,
        generation,
        correlationId: correlation,
        nonce,
      })

      // Attempt to consume from an earlier/different turn
      const outcome = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId: 'turn-1', // Stale turn
        generation,
        correlation,
        nonce,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toBe('cross_turn_rejection')
        expect(outcome.status).toBe(409)
      }
    })

    it('rejects cross-thread consumption when threadId does not match active thread', async () => {
      const deliveryId = 'deliv-003'
      const threadId = 'thread-main'
      const turnId = 'turn-1'
      const generation = 1
      const correlation = 'corr-req-300'
      const nonce = 'nonce-thread-main'

      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlationId: correlation,
        nonce,
      })

      // Attempt to consume from another thread
      const outcome = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId: 'thread-fork', // Wrong thread
        turnId,
        generation,
        correlation,
        nonce,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toBe('cross_thread_rejection')
        expect(outcome.status).toBe(409)
      }
    })

    it('rejects stale generation consumption', async () => {
      const deliveryId = 'deliv-004'
      const threadId = 'thread-main'
      const turnId = 'turn-1'
      const activeGeneration = 2
      const correlation = 'corr-req-400'
      const nonce = 'nonce-gen-2'

      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation: activeGeneration,
        correlationId: correlation,
        nonce,
      })

      const outcome = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation: 1, // Stale generation
        correlation,
        nonce,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toBe('stale_generation')
        expect(outcome.status).toBe(409)
      }
    })

    it('rejects replay attempts after delivery has already been consumed', async () => {
      const deliveryId = 'deliv-005'
      const threadId = 'thread-main'
      const turnId = 'turn-1'
      const generation = 1
      const correlation = 'corr-req-500'
      const nonce = 'nonce-unique-500'

      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlationId: correlation,
        nonce,
      })

      // First consume: OK
      const first = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlation,
        nonce,
      })
      expect(first.ok).toBe(true)

      // Replay attempt: Rejected with already_consumed
      const replay = await consumeDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlation,
        nonce,
      })
      expect(replay.ok).toBe(false)
      if (!replay.ok) {
        expect(replay.error).toBe('already_consumed')
        expect(replay.status).toBe(409)
      }
    })

    it('invalidates prior active turn fences when turn advances in thread', async () => {
      const threadId = 'thread-chat-advancing'
      await registerDeliveryTurnFence(env, {
        deliveryId: 'deliv-turn-1',
        threadId,
        turnId: 'turn-1',
        generation: 1,
        correlationId: 'c1',
        nonce: 'n1',
      })

      // Turn advances to turn-2 -> invalidate prior turn-1
      const invalidatedCount = await invalidateThreadTurnFences(env, threadId, 'turn-2')
      expect(invalidatedCount).toBe(1)

      const row = await harness.db.prepare(
        'SELECT status FROM delivery_turn_fences WHERE delivery_id = ?1'
      ).bind('deliv-turn-1').first<{ status: string }>()
      expect(row?.status).toBe('invalidated')
    })
  })

  describe('2. MCP Dynamic Tool `mupot_delivery_consumed_v1`', () => {
    it('executes mupot_delivery_consumed_v1 tool and returns success', async () => {
      const deliveryId = 'mcp-deliv-101'
      const threadId = 'mcp-thread-1'
      const turnId = 'mcp-turn-1'
      const generation = 1
      const correlation = 'corr-mcp-101'
      const nonce = 'mcp-nonce-secret-101'

      await registerDeliveryTurnFence(env, {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlationId: correlation,
        nonce,
      })

      const auth: AuthContext = {
        memberId: MEMBER_ID,
        boundAgentId: AGENT_ID,
        role: 'member',
        tenant: TENANT,
      }

      const res = await invokeTool(auth, env, 'mupot_delivery_consumed_v1', {
        deliveryId,
        threadId,
        turnId,
        generation,
        correlation,
        nonce,
        summary: 'MCP tool completed work in active turn',
      })

      expect(res.ok).toBe(true)
      if (res.ok) {
        const data = res.result as { ok: boolean; deliveryId: string; status: string }
        expect(data.ok).toBe(true)
        expect(data.deliveryId).toBe(deliveryId)
        expect(data.status).toBe('consumed')
      }
    })

    it('rejects MCP call when delivery fence does not exist (loaded-idle rejection)', async () => {
      const auth: AuthContext = {
        memberId: MEMBER_ID,
        boundAgentId: AGENT_ID,
        role: 'member',
        tenant: TENANT,
      }

      const res = await invokeTool(auth, env, 'mupot_delivery_consumed_v1', {
        deliveryId: 'non-existent-delivery',
        threadId: 'idle-thread',
        turnId: 'idle-turn',
        generation: 1,
        correlation: 'idle-corr',
        nonce: 'idle-nonce',
      })

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toBe('delivery_not_found')
        expect(res.status).toBe(404)
      }
    })
  })

  describe('3. Presence Session Epoch & Lease Extensions (#1031)', () => {
    it('registers module presence with custom session_epoch and lease_ttl_sec', async () => {
      const reg = await registerModule(env, {
        identity: 'agent-river-epoch',
        kind: 'agent_system',
        adapter: 'prime-agent',
        projectId: null,
        sessionEpoch: 5,
        leaseTtlSec: 60,
      })

      expect(reg.ok).toBe(true)
      if (reg.ok) {
        expect(reg.value.session_epoch).toBe(5)
        expect(reg.value.lease_ttl_sec).toBe(60)
        expect(reg.value.status).toBe('online')
      }

      const list = await listPresence(env, { projectId: null }, new Date())
      const found = list.find((m) => m.identity === 'agent-river-epoch')
      expect(found).toBeDefined()
      expect(found?.session_epoch).toBe(5)
      expect(found?.lease_ttl_sec).toBe(60)
    })

    it('heartbeats module presence and updates epoch/lease', async () => {
      await registerModule(env, {
        identity: 'agent-river-hb',
        kind: 'agent_system',
        adapter: 'prime-agent',
        projectId: null,
        sessionEpoch: 1,
        leaseTtlSec: 120,
      })

      const hbOk = await heartbeatModule(env, 'agent-river-hb', null, new Date(), undefined, {
        sessionEpoch: 2,
        leaseTtlSec: 90,
      })
      expect(hbOk).toBe(true)

      const list = await listPresence(env, { projectId: null }, new Date())
      const found = list.find((m) => m.identity === 'agent-river-hb')
      expect(found?.session_epoch).toBe(2)
      expect(found?.lease_ttl_sec).toBe(90)
    })

    it('records 7-axis checkin with session_epoch and lease_ttl_sec in presence table', async () => {
      await recordCheckin(env, { memberId: MEMBER_ID, displayName: 'River', boundAgentId: AGENT_ID }, {
        seat: 'river-mac-wB:p1',
        harness: 'prime',
        machine: 'hadi-mac',
        model: 'gemini-3.7-flash',
        provider: 'google',
        effort: 'high',
        continuum_name: 'river',
        session_epoch: 3,
        lease_ttl_sec: 180,
      })

      const row = await harness.db.prepare(
        'SELECT session_epoch, lease_ttl_sec, continuum_name FROM presence WHERE member_id = ?1 AND seat = ?2'
      ).bind(MEMBER_ID, 'river-mac-wB:p1').first<{ session_epoch: number; lease_ttl_sec: number; continuum_name: string }>()

      expect(row?.session_epoch).toBe(3)
      expect(row?.lease_ttl_sec).toBe(180)
      expect(row?.continuum_name).toBe('river')
    })
  })

  describe('4. Seat Dispatchability & Undispatchable State (#1050)', () => {
    it('classifies empty or blank label seat as undispatchable rather than idle', () => {
      const nowMs = Date.now()
      const fiveMinsAgoMs = nowMs - 5 * 60 * 1000

      // Normal seat with label is active
      expect(classify(fiveMinsAgoMs, nowMs, 'hadi-grok')).toBe('active')

      // Seat with blank or empty label must report undispatchable
      expect(classify(fiveMinsAgoMs, nowMs, '')).toBe('undispatchable')
      expect(classify(fiveMinsAgoMs, nowMs, '   ')).toBe('undispatchable')
    })
  })
})

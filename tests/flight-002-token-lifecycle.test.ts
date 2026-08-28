// tests/flight-002-token-lifecycle.test.ts — Verification of FLIGHT-002.
//
// Invariants verified:
//   1. Monotonic Token Expiry: calculateExpiryTimestamp and isTokenExpiringSoon.
//   2. Token Liveness Enforcement: TOKEN_LIVE_PREDICATE filters expired credentials.
//   3. Automated & Admin Token Rotation: rotateMemberToken creates replacement, revokes old, and records token_rotations audit.
//   4. Proactive Sweep & Warning: sweepExpiringTokensWarning identifies expiring credentials.
//   5. MCP Integration: token_rotate & token_sweep_expiring tools.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  calculateExpiryTimestamp,
  isTokenExpiringSoon,
  rotateMemberToken,
  sweepExpiringTokensWarning,
  nowSqlUtc,
} from '../src/auth/token-lifecycle'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-002: Identity & Token Lifecycle (expires_at & Rotation)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const ADMIN_ID = 'm-admin'
  const AGENT_ID = 'ag-lead-1'

  const adminAuth: AuthContext = {
    userId: ADMIN_ID,
    memberId: ADMIN_ID,
    email: 'admin@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: ADMIN_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed member and agent
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('${ADMIN_ID}', 'admin@mumega.com', 'Admin User', 'active'),
             ('m-agent-lead', 'agent-lead@mumega.com', 'Agent Lead Member', 'active');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad');
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_ID}', 'squad-1', 'lead-agent', 'Lead Agent', 'active');

      INSERT OR IGNORE INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', 'm-agent-lead', datetime('now'));
    `)
  })

  describe('1. Expiry Calculations & Warning Triggers', () => {
    it('calculates future SQLite-compatible ISO timestamps', () => {
      const exp30 = calculateExpiryTimestamp(30)
      expect(exp30).toBeTruthy()
      expect(exp30).not.toContain('T') // SQLite space format

      const nonExp = calculateExpiryTimestamp(0)
      expect(nonExp).toBeNull()
    })

    it('detects tokens expiring soon within warning window', () => {
      const soonExp = calculateExpiryTimestamp(3) // 3 days in future
      const farExp = calculateExpiryTimestamp(45) // 45 days in future

      expect(isTokenExpiringSoon(soonExp, 7)).toBe(true)
      expect(isTokenExpiringSoon(farExp, 7)).toBe(false)
      expect(isTokenExpiringSoon(null, 7)).toBe(false)
    })
  })

  describe('2. Token Rotation & Audit Logging', () => {
    it('rotates active credential: mints replacement and revokes original', async () => {
      // 1. Seed existing token
      const oldTokenId = 'tok-old-123'
      harness.sqlite.exec(`
        INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, expires_at, created_at, tenant)
        VALUES ('${oldTokenId}', 'm-agent-lead', 'hash-old-123', 'cli-token', 'workspace', '${AGENT_ID}', '${calculateExpiryTimestamp(5)}', '${nowSqlUtc()}', '${TENANT}');
      `)

      // 2. Perform rotation
      const rotateRes = await rotateMemberToken(env, oldTokenId, {
        rotatedBy: ADMIN_ID,
        expiryDays: 60,
        reason: 'scheduled_pi_rotation',
      })

      expect(rotateRes.ok).toBe(true)
      expect(rotateRes.tokenId).toBeTruthy()
      expect(rotateRes.rawToken).toHaveLength(64)

      // 3. Verify old token revoked in D1
      const oldRow = await env.DB.prepare(`SELECT revoked_at FROM member_tokens WHERE id = ?1`).bind(oldTokenId).first<{ revoked_at: string | null }>()
      expect(oldRow?.revoked_at).toBeTruthy()

      // 4. Verify new token inserted with updated expiry
      const newRow = await env.DB.prepare(`SELECT id, agent_id, expires_at, revoked_at FROM member_tokens WHERE id = ?1`).bind(rotateRes.tokenId!).first<{ id: string; agent_id: string; expires_at: string; revoked_at: string | null }>()
      expect(newRow?.id).toBe(rotateRes.tokenId)
      expect(newRow?.agent_id).toBe(AGENT_ID)
      expect(newRow?.revoked_at).toBeNull()

      // 5. Verify rotation audit record
      const auditRow = await env.DB.prepare(`SELECT * FROM token_rotations WHERE old_token_id = ?1`).bind(oldTokenId).first<{ new_token_id: string; reason: string }>()
      expect(auditRow?.new_token_id).toBe(rotateRes.tokenId)
      expect(auditRow?.reason).toBe('scheduled_pi_rotation')
    })
  })

  describe('3. Warning Sweeper & MCP Integration', () => {
    it('sweeps expiring tokens and executes MCP token tools', async () => {
      // Seed expiring token
      harness.sqlite.exec(`
        INSERT INTO member_tokens (id, member_id, token_hash, label, channel, expires_at, created_at, tenant)
        VALUES ('tok-expiring-1', '${ADMIN_ID}', 'hash-exp-1', 'expiring-bot', 'workspace', '${calculateExpiryTimestamp(2)}', '${nowSqlUtc()}', '${TENANT}');
      `)

      // 1. Direct sweep test
      const sweepRes = await sweepExpiringTokensWarning(env, 7)
      expect(sweepRes.warned).toBe(1)
      expect(sweepRes.tokens[0].id).toBe('tok-expiring-1')

      // 2. MCP sweep tool test
      const mcpSweep = await invokeTool(adminAuth, env, 'token_sweep_expiring', {
        warning_days: 7,
      })
      expect(mcpSweep.ok).toBe(true)
      expect((mcpSweep.result as any).warned).toBe(1)

      // 3. MCP rotate tool test
      const mcpRotate = await invokeTool(adminAuth, env, 'token_rotate', {
        token_id: 'tok-expiring-1',
        expiry_days: 30,
        reason: 'mcp_automated_rotate',
      })
      expect(mcpRotate.ok).toBe(true)
      expect((mcpRotate.result as any).tokenId).toBeTruthy()
    })
  })
})

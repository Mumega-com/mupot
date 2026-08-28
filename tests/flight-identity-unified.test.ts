// tests/flight-identity-unified.test.ts — Verification of FLIGHT IDENTITY-UNIFIED / #584.
//
// Invariants verified:
//   1. Principals View: Unifies humans and agents into kind-filtered view.
//   2. Token-Scoped Grants: token_grants table with project/squad/org scopes.
//   3. Intersection Math: effective = intersect(principal, token_grants) enforces least-privilege ceiling.
//   4. createAccessKey Service: Single mint flow bundling show-once token, MCP endpoint, and configs (Claude Code, Cursor, Codex, curl).
//   5. MCP Integration: create_access_key tool.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  resolveCapabilities,
  resolveTokenGrants,
  intersectCapabilities,
  hasCapability,
} from '../src/auth/capability'
import { createAccessKey } from '../src/auth/unified-access'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext, CapabilityGrant } from '../src/types'

describe('FLIGHT IDENTITY-UNIFIED (#584): Unified Principals & Token-Scoped Grants', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const OPERATOR_ID = 'm-operator'
  const AGENT_ID = 'ag-worker-1'
  const SQUAD_A = 'squad-core'
  const PROJECT_X = 'project-mupot'

  const adminAuth: AuthContext = {
    userId: OPERATOR_ID,
    memberId: OPERATOR_ID,
    email: 'operator@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: OPERATOR_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    } as unknown as Env

    // Seed test principal, departments, squads, projects, and agents
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('${OPERATOR_ID}', 'operator@mumega.com', 'Operator User', 'active');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_A}', 'dept-1', 'core', 'Core Squad');
      INSERT OR IGNORE INTO projects (id, slug, name, status, created_at, updated_at)
      VALUES ('${PROJECT_X}', 'mupot', 'Mupot Project', 'active', datetime('now'), datetime('now'));

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_ID}', '${SQUAD_A}', 'worker-agent', 'Worker Agent', 'active');

      -- Operator has org:owner in capabilities table
      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-op-org', '${OPERATOR_ID}', 'org', NULL, 'owner');
    `)
  })

  describe('1. Principals View Unified Identity', () => {
    it('queries principals view for both human members and agents', async () => {
      const rows = await env.DB.prepare(`SELECT id, kind, handle, display_name FROM principals ORDER BY kind`).all<{ id: string; kind: string; handle: string; display_name: string }>()
      const principals = rows.results ?? []

      expect(principals.length).toBeGreaterThanOrEqual(2)
      expect(principals.some((p) => p.kind === 'human' && p.id === OPERATOR_ID)).toBe(true)
      expect(principals.some((p) => p.kind === 'agent' && p.id === AGENT_ID)).toBe(true)
    })
  })

  describe('2. Capability Intersection Engine (Least-Privilege Ceiling)', () => {
    it('restricts a full-owner principal token to only project-scoped or squad-scoped grants', () => {
      const principalGrants: CapabilityGrant[] = [
        { member_id: OPERATOR_ID, scope_type: 'org', scope_id: null, capability: 'owner' },
      ]

      const tokenGrants: CapabilityGrant[] = [
        { member_id: 'token-1', scope_type: 'project', scope_id: PROJECT_X, capability: 'lead' },
        { member_id: 'token-1', scope_type: 'squad', scope_id: SQUAD_A, capability: 'member' },
      ]

      const effective = intersectCapabilities(principalGrants, tokenGrants)
      expect(effective).toHaveLength(2)
      expect(hasCapability(effective, 'project', PROJECT_X, 'lead')).toBe(true)
      expect(hasCapability(effective, 'squad', SQUAD_A, 'member')).toBe(true)
      // Cannot act as org-admin even though principal holds org-owner
      expect(hasCapability(effective, 'org', null, 'admin')).toBe(false)
    })

    it('clamps token grant if principal capability is lower than requested token scope', () => {
      const principalGrants: CapabilityGrant[] = [
        { member_id: OPERATOR_ID, scope_type: 'squad', scope_id: SQUAD_A, capability: 'member' },
      ]

      const tokenGrants: CapabilityGrant[] = [
        { member_id: 'token-2', scope_type: 'squad', scope_id: SQUAD_A, capability: 'lead' }, // requests lead
      ]

      const effective = intersectCapabilities(principalGrants, tokenGrants)
      expect(effective[0].capability).toBe('member') // Clamped to principal's rank
      expect(hasCapability(effective, 'squad', SQUAD_A, 'lead')).toBe(false)
      expect(hasCapability(effective, 'squad', SQUAD_A, 'member')).toBe(true)
    })
  })

  describe('3. Unified createAccessKey Service & Config Bundling', () => {
    it('mints token-scoped key, persists grants, and returns paste-ready configs', async () => {
      const result = await createAccessKey(env, {
        principalId: OPERATOR_ID,
        label: 'project-worker-key',
        expiryDays: 14,
        grants: [
          { scope_type: 'project', scope_id: PROJECT_X, capability: 'lead' },
          { scope_type: 'squad', scope_id: SQUAD_A, capability: 'member' },
        ],
      })

      expect(result.tokenId).toBeTruthy()
      expect(result.rawToken).toHaveLength(64)
      expect(result.mcpEndpoint).toBe('https://mupot.mumega.com/mcp')
      expect(result.configs.claudeCodeJson).toContain('https://mupot.mumega.com/mcp')
      expect(result.configs.claudeCodeJson).toContain(result.rawToken)
      expect(result.configs.cursorJson).toContain(result.rawToken)
      expect(result.configs.codexToml).toContain(result.rawToken)

      // Verify token_grants stored in D1
      const tokenGrants = await resolveTokenGrants(env, result.tokenId)
      expect(tokenGrants).toHaveLength(2)

      // Verify effective intersection
      expect(hasCapability(result.effectiveGrants, 'project', PROJECT_X, 'lead')).toBe(true)
      expect(hasCapability(result.effectiveGrants, 'org', null, 'owner')).toBe(false)
    })
  })

  describe('4. MCP Tool create_access_key', () => {
    it('executes create_access_key tool via MCP', async () => {
      const toolRes = await invokeTool(adminAuth, env, 'create_access_key', {
        principal_id: OPERATOR_ID,
        label: 'mcp-minted-key',
        expiry_days: 30,
        grants: [
          { scope_type: 'squad', scope_id: SQUAD_A, capability: 'lead' },
        ],
      })

      expect(toolRes.ok).toBe(true)
      if (!toolRes.ok) throw new Error('Unreachable')
      expect((toolRes.result as any).mcpEndpoint).toBeTruthy()
      expect((toolRes.result as any).configs.cursorJson).toBeTruthy()
    })
  })
})

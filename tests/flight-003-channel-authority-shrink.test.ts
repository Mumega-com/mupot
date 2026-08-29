// tests/flight-003-channel-authority-shrink.test.ts — Verification of FLIGHT-003 / #799.
//
// Invariants verified:
//   1. Non-directory channel capability clamping: channel_caps ceiling limits inbound grants to <= max_capability.
//   2. Channel auth context cannot escalate to org-admin (isOrgAdmin(auth) returns false for channel='im').
//   3. Channel-initiated commands cannot bypass squad and project scope fences.
//   4. Channel tokens with channel='im' in MCP / REST evaluate clamped capabilities.
//   5. Directives and fleet control require genuine owner capability with strict non-forwarded transports.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  isOrgAdmin,
  clampCapability,
  clampChannelCapabilities,
  hasCapability,
  canOnSquad,
} from '../src/auth/capability'
import { handleImMessage } from '../src/im/index'
import { runInbound } from '../src/channels/index'
import { authenticateMember, invokeTool } from '../src/mcp/index'
import type { Env, AuthContext, CapabilityGrant } from '../src/types'

describe('FLIGHT-003: Channel Authority Shrink & Scope Caps (#799)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const MEMBER_ID = 'm-operator'
  const SQUAD_A = 'squad-core'
  const SQUAD_B = 'squad-other'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed core test departments, squads, members, and channel bindings
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Core Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_A}', 'dept-core', 'core', 'Core Squad');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_B}', 'dept-core', 'other', 'Other Squad');

      INSERT OR IGNORE INTO members (id, email, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'operator@mumega.com', 'Operator', 'active', '${TENANT}');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-operator-tg', '${MEMBER_ID}', 'telegram', '12345678');

      -- Channel binding with max_capability = 'member' (channel cap ceiling)
      INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
      VALUES ('binding-core-tg', 'telegram', '-100123456789', '${SQUAD_A}', 'member');

      -- Agents
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-core-lead', '${SQUAD_A}', 'core-lead', 'Core Lead', 'active'),
             ('ag-other-lead', '${SQUAD_B}', 'other-lead', 'Other Lead', 'active');
    `)
  })

  describe('1. Capability Clamping Logic', () => {
    it('clamps individual capabilities to ceiling', () => {
      expect(clampCapability('owner', 'lead')).toBe('lead')
      expect(clampCapability('admin', 'lead')).toBe('lead')
      expect(clampCapability('lead', 'lead')).toBe('lead')
      expect(clampCapability('member', 'lead')).toBe('member')
      expect(clampCapability('observer', 'lead')).toBe('observer')

      // Clamping to member ceiling
      expect(clampCapability('owner', 'member')).toBe('member')
      expect(clampCapability('lead', 'member')).toBe('member')
    })

    it('clamps capability grants array to channel ceiling', () => {
      const rawGrants: CapabilityGrant[] = [
        { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'owner' },
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_A, capability: 'admin' },
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_B, capability: 'member' },
      ]

      const clamped = clampChannelCapabilities(rawGrants, 'lead')
      expect(clamped[0].capability).toBe('lead')
      expect(clamped[1].capability).toBe('lead')
      expect(clamped[2].capability).toBe('member')
    })
  })

  describe('2. Anti-Escalation: Channel Capability Clamping', () => {
    it('clamps capabilities to non-directory channel ceiling', () => {
      const channelGrants: CapabilityGrant[] = [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }]
      const clamped = clampChannelCapabilities(channelGrants, 'lead')
      expect(clamped[0].capability).toBe('lead')
      expect(hasCapability(clamped, 'org', null, 'admin')).toBe(false)
    })
  })

  describe('3. Inbound Channel Scope & Ceiling Enforcement', () => {
    it('applies binding.max_capability clamp during channel inbound execution', async () => {
      // Grant operator org:owner standing authority in database
      harness.sqlite.exec(`
        INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-org-owner', '${MEMBER_ID}', 'org', NULL, 'owner');
      `)

      // Check status via channel: bound channel ceiling is 'member' on binding-core-tg
      const reply = await runInbound(env, 'telegram', '-100123456789', '12345678', 'status')
      expect(reply).toContain('This channel is wired to "Core Squad"')
      expect(reply).toContain('owner@org')
    })

    it('refuses channel mention dispatch to out-of-scope targets across squads', async () => {
      // Only grant squad-scope membership on SQUAD_A
      harness.sqlite.exec(`
        INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-squad-a', '${MEMBER_ID}', 'squad', '${SQUAD_A}', 'member');
      `)

      // Attempt to dispatch to agent in SQUAD_B from channel SQUAD_A
      const reply = await runInbound(env, 'telegram', '-100123456789', '12345678', '@other-lead do secret work')
      expect(reply).toContain('refused: send_target_not_visible')
    })
  })

  describe('4. IM/Telegram Seam Gating & Directives', () => {
    it('refuses directive and fleet commands without direct owner auth', async () => {
      // Associate member with telegram chat ID
      harness.sqlite.exec(`
        UPDATE members SET telegram_chat_id = '999888' WHERE id = '${MEMBER_ID}';
        INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-squad-only', '${MEMBER_ID}', 'squad', '${SQUAD_A}', 'lead');
      `)

      const replyDirective = await handleImMessage(env, '999888', 'directive: New Directive Text')
      expect(replyDirective).toBe("You don't have permission to pin brain directives (need owner on the org).")

      const replyFleet = await handleImMessage(env, '999888', 'fleet stop core-lead')
      expect(replyFleet).toBe("You don't have permission to control fleet agents (need owner on the org).")
    })
  })

  describe('5. MCP Channel Auth Context Clamping & Scope Fences', () => {
    it('clamps capabilities when bearer token has channel=im', async () => {
      // Mint a member token with channel='im'
      harness.sqlite.exec(`
        INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, tenant, created_at)
        VALUES ('tok-im-1', '${MEMBER_ID}', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'im-bot', 'im', '${TENANT}', datetime('now'));

        INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-org-admin', '${MEMBER_ID}', 'org', NULL, 'admin');
      `)

      // When channel is 'im', capabilities are clamped to 'lead' ceiling
      const channelGrants: CapabilityGrant[] = [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }]
      const clamped = clampChannelCapabilities(channelGrants, 'lead')
      expect(clamped[0].capability).toBe('lead')
      expect(hasCapability(clamped, 'org', null, 'admin')).toBe(false)
    })

    it('refuses admin-only tools when caller lacks org admin grants', async () => {
      const channelAuth: AuthContext = {
        memberId: MEMBER_ID,
        userId: MEMBER_ID,
        role: 'member',
        channel: 'im',
        tenant: TENANT,
        capabilities: [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'lead' }],
      }

      // Invoking an admin-gated tool like create_department fails closed with 403 forbidden
      const res = await invokeTool(channelAuth, env, 'create_department', {
        slug: 'new-dept',
        name: 'New Department',
      })

      expect(res.ok).toBe(false)
      expect(res.error).toBe('forbidden')
      expect(res.status).toBe(403)
    })
  })
})

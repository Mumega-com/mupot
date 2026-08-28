// tests/flight-untrusted-ingress.test.ts — Verification of FLIGHT-UNTRUSTED (F6).
//
// Invariants verified:
//   1. Ingress Trust Separation: Directive vs Untrusted Data classification.
//   2. Structural Ingress Envelopes: wrapIngressContent and assertDirectiveAuthority.
//   3. Untrusted tag invariant preservation without double-tagging.
//   4. Ingress integration on channel commands.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  isDirectiveSender,
  wrapIngressContent,
  assertDirectiveAuthority,
} from '../src/ingress/guards'
import { runInbound } from '../src/channels/index'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

describe('FLIGHT-UNTRUSTED (F6): Structural Ingress & Untrusted-Content Fencing', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: 'mumega',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
    } as unknown as Env

    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-hadi', 'hadi@mumega.com', 'Hadi', 'active'),
             ('m-user', 'user@mumega.com', 'User', 'active');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-hadi', 'm-hadi', 'telegram', '765204057'),
             ('id-user', 'm-user', 'telegram', '999999999');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-1', 'core', 'Core Squad');

      INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
      VALUES ('binding-core', 'telegram', '-100', 'squad-core', 'member');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-mubot', 'squad-core', 'mubot', 'Mubot', 'active');

      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-hadi', 'm-hadi', 'squad', 'squad-core', 'member'),
             ('cap-user', 'm-user', 'squad', 'squad-core', 'member');
    `)
  })

  describe('1. Ingress Classification & Envelopes', () => {
    it('recognizes verified Hadi sender as directive authority', () => {
      expect(isDirectiveSender('telegram', '765204057')).toBe(true)
      expect(isDirectiveSender('telegram', '999999999')).toBe(false)
      expect(isDirectiveSender('discord', '765204057')).toBe(false)
    })

    it('wraps untrusted ingress with structural tags without double-tagging', () => {
      const wrapped1 = wrapIngressContent('telegram', '999999999', 'Hello bot')
      expect(wrapped1.isDirective).toBe(false)
      expect(wrapped1.trustLevel).toBe('untrusted_data')
      expect(wrapped1.sanitizedBody).toBe('[UNTRUSTED-INGRESS] Hello bot')

      // Pre-tagged text is not double-tagged
      const wrapped2 = wrapIngressContent('telegram', '999999999', '[UNTRUSTED-INGRESS] Hello bot')
      expect(wrapped2.sanitizedBody).toBe('[UNTRUSTED-INGRESS] Hello bot')

      // Verified sender has directive authority and clean text
      const wrappedHadi = wrapIngressContent('telegram', '765204057', 'Hello bot')
      expect(wrappedHadi.isDirective).toBe(true)
      expect(wrappedHadi.trustLevel).toBe('directive')
      expect(wrappedHadi.sanitizedBody).toBe('Hello bot')
    })

    it('assertDirectiveAuthority fails closed on non-directive ingress', () => {
      const untrusted = wrapIngressContent('telegram', '999999999', 'Deploy now')
      expect(() => assertDirectiveAuthority(untrusted)).toThrow('Directive-required')

      const directive = wrapIngressContent('telegram', '765204057', 'Deploy now')
      expect(() => assertDirectiveAuthority(directive)).not.toThrow()
    })
  })

  describe('2. Inbound Channel Integration', () => {
    it('dispatches mentions with structural untrusted tag for external senders', async () => {
      const res = await runInbound(env, 'telegram', '-100', '999999999', '@mubot ping test')
      expect(res).toContain('[UNTRUSTED-INGRESS]')

      const msg = await env.DB.prepare(`SELECT body FROM agent_messages WHERE from_member = 'm-user'`).first<{ body: string }>()
      expect(msg?.body).toContain('[UNTRUSTED-INGRESS]')
    })

    it('allows clean dispatch for verified directive sender', async () => {
      const res = await runInbound(env, 'telegram', '-100', '765204057', '@mubot deploy release')
      expect(res).not.toContain('[UNTRUSTED-INGRESS]')

      const msg = await env.DB.prepare(`SELECT body FROM agent_messages WHERE from_member = 'm-hadi'`).first<{ body: string }>()
      expect(msg?.body).toBe('@mubot deploy release')
    })
  })
})

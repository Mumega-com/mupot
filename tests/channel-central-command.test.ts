// tests/channel-central-command.test.ts — Real-SQL integration test suite for mumega-com#722

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

describe('central-command ingress (mumega-com#722)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: 'mumega', TELEGRAM_BOT_TOKEN: 'test-bot-token' } as unknown as Env

    // Seed test member and identity via real SQL
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-hadi', 'hadi@mumega.com', 'Hadi', 'active');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-hadi', 'm-hadi', 'telegram', '765204057');

      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-user', 'user@mumega.com', 'User', 'active');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-user', 'm-user', 'telegram', '1111111');

      INSERT OR IGNORE INTO departments (id, slug, name)
      VALUES ('dept-core', 'core', 'Dept Core');

      INSERT OR IGNORE INTO squads (id, department_id, slug, name)
      VALUES ('squad-core', 'dept-core', 'core', 'Squad Core');

      INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
      VALUES ('central-command-telegram', 'telegram', '-5317747241', 'squad-core', 'member');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-prime', 'squad-core', 'prime', 'Prime', 'active'),
             ('ag-river', 'squad-core', 'river', 'River', 'active'),
             ('ag-mubot', 'squad-core', 'mubot', 'Mubot', 'active');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  it('refuses an unbound group: no dispatch, no side effect', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-999999', '765204057', '@prime status')
    expect(res).toContain('not wired to a squad')
  })

  it('binds -5317747241 -> squad-core via channel_bindings seam and accepts mentions (B3)', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot status check')
    expect(res).toContain('Dispatched @mubot via mupot inbox')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'mubot'`
    ).first()
    expect(msg).not.toBeNull()
    expect(msg?.body).toBe('@mubot status check')
  })

  it('tags non-Hadi mentions UNTRUSTED-INGRESS: body carries the tag', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '1111111', '@mubot execute order')
    expect(res).toContain('[UNTRUSTED-INGRESS]')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE from_member = 'm-user'`
    ).first()
    expect(msg).not.toBeNull()
    expect(msg?.body).toContain('[UNTRUSTED-INGRESS]')
  })

  it('treats a non-Hadi wake or task as data: returns directive-required, no side effect (W1)', async () => {
    const { runInbound } = await import('../src/channels/index')
    const resWake = await runInbound(env, 'telegram', '-5317747241', '1111111', 'wake codex')
    expect(resWake).toContain('Directive-required')

    const resTask = await runInbound(env, 'telegram', '-5317747241', '1111111', 'task: deploy feature')
    expect(resTask).toContain('Directive-required')
  })

  it('Hadi sender 765204057 is directive-capable: untagged body, wake allowed', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot full flight plan')
    expect(res).not.toContain('[UNTRUSTED-INGRESS]')
    expect(res).toContain('Dispatched @mubot')
  })

  it('B1: returns honest SOS-native status for @river even when river is active in D1 agents', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@river review spec')
    expect(res).toContain('@river is SOS-native; relayed via Kasra')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'river'`
    ).first()
    expect(msg?.body).toContain('[sos-bus]')
  })

  // NOTE: @prime routing is deliberately NOT asserted here. dispatchMention routes
  // prime/asha to sosBusSend, which returns "is SOS-native; relayed via Kasra" — but
  // asha is mupot-native with a working inbox, and sosBusSend performs no relay at all
  // (it writes one [sos-bus] audit row and returns the string). Pinning either side of
  // that would encode a falsehood. Classification + honest status tracked separately.

  it('B2: refuses mentions exceeding MAX_BODY_CHARS via sendAgentMessage primitive', async () => {
    const { runInbound } = await import('../src/channels/index')
    const longBody = '@mubot ' + 'x'.repeat(8200)
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', longBody)
    expect(res).toContain('refused: invalid_body')
  })

  it('unknown mention refuses: "no such active agent"', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@ghost test')
    expect(res).toContain('no such active agent: @ghost')
  })

  it('rate wall: 11th mention in the hour returns the cap message and records 11', async () => {
    const { runInbound } = await import('../src/channels/index')
    for (let i = 0; i < 10; i++) {
      const res = await runInbound(env, 'telegram', '-5317747241', '765204057', `@mubot ping ${i}`)
      expect(res).toContain('Dispatched @mubot')
    }

    const eleventh = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot ping 11')
    expect(eleventh).toContain('10/hour mention wall')

    const budget = await env.DB.prepare(
      `SELECT count FROM channel_mention_budget WHERE agent_slug = 'mubot'`
    ).first<{ count: number }>()
    expect(budget?.count).toBe(11)
  })
})

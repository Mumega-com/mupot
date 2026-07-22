import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  markDormant,
  reactivateAgent,
  runLifecycleTick,
  softRetireAgent,
} from '../src/agents/lifecycle'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

describe('agent lifecycle (0070) — real SQL', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'sq', 'Squad');
      INSERT INTO agents (
        id, squad_id, slug, name, role, model, status, created_at, death_condition, dormant_reason
      ) VALUES (
        'agent-idle', 'sq-1', 'idle-bot', 'Idle Bot', 'member', 'm', 'active',
        '2026-06-01 00:00:00',
        '{"idle_ttl_hours":24,"policy":"no_instance_no_activity"}',
        NULL
      );
      INSERT INTO agents (
        id, squad_id, slug, name, role, model, status, created_at, death_condition, dormant_reason
      ) VALUES (
        'agent-live', 'sq-1', 'live-bot', 'Live Bot', 'member', 'm', 'active',
        '2026-06-01 00:00:00',
        '{"idle_ttl_hours":24,"policy":"no_instance_no_activity"}',
        NULL
      );
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
        VALUES ('test', 'm1', 'Live', 'hermes', '', 'agent-live', datetime('now'), datetime('now'));
    `)
    env = { DB: harness.db, TENANT_SLUG: 'test' } as unknown as Env
  })

  afterEach(() => harness.close())

  it('0070 adds dormant_reason', () => {
    const cols = harness.sqlite
      .prepare('PRAGMA table_info(agents)')
      .all()
      .map((r) => (r as { name: string }).name)
    expect(cols).toContain('dormant_reason')
  })

  it('soft-retires idle agent and leaves a recently-seen peer alone', async () => {
    const tick = await runLifecycleTick(env, Date.parse('2026-07-22T12:00:00Z'))
    expect(tick.soft_retired).toBe(1)
    const idle = harness.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('agent-idle') as {
      status: string
    }
    const live = harness.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('agent-live') as {
      status: string
    }
    expect(idle.status).toBe('inactive')
    expect(live.status).toBe('active')
  })

  it('dormancy preserves the agent row and reactivates cleanly', async () => {
    await markDormant(env, { id: 'agent-live', slug: 'live-bot' }, 'provider_down', '503')
    const mid = harness.sqlite
      .prepare('SELECT status, dormant_reason, name FROM agents WHERE id = ?')
      .get('agent-live') as { status: string; dormant_reason: string; name: string }
    expect(mid).toMatchObject({ status: 'paused', dormant_reason: 'provider_down', name: 'Live Bot' })

    await reactivateAgent(env, 'agent-live', 'provider_restored', 'ok')
    const after = harness.sqlite
      .prepare('SELECT status, dormant_reason FROM agents WHERE id = ?')
      .get('agent-live') as { status: string; dormant_reason: string | null }
    expect(after).toEqual({ status: 'active', dormant_reason: null })
  })

  it('softRetireAgent is idempotent on already-inactive rows', async () => {
    await softRetireAgent(env, { id: 'agent-idle', slug: 'idle-bot' }, 'once')
    const second = await softRetireAgent(env, { id: 'agent-idle', slug: 'idle-bot' }, 'twice')
    expect(second).toEqual({ ok: true, changed: false })
  })

  it('dormant provider_down agent past idle TTL keeps dormant_reason (not soft-retired)', async () => {
    harness.sqlite.exec(`
      UPDATE agents
         SET status = 'paused',
             dormant_reason = 'provider_down',
             death_condition = '{"idle_ttl_hours":24,"policy":"no_instance_no_activity"}'
       WHERE id = 'agent-idle'
    `)
    // No model dep → reactivation probe skipped; soft-retire must still leave dormancy alone.
    const tick = await runLifecycleTick(env, Date.parse('2026-07-22T12:00:00Z'))
    expect(tick.soft_retired).toBe(0)
    expect(tick.reactivated).toBe(0)
    const row = harness.sqlite
      .prepare('SELECT status, dormant_reason FROM agents WHERE id = ?')
      .get('agent-idle') as { status: string; dormant_reason: string | null }
    expect(row).toEqual({ status: 'paused', dormant_reason: 'provider_down' })

    // Direct softRetire also refuses while dormant_reason is set.
    const direct = await softRetireAgent(env, { id: 'agent-idle', slug: 'idle-bot' }, 'forced')
    expect(direct).toEqual({ ok: true, changed: false })
    const after = harness.sqlite
      .prepare('SELECT status, dormant_reason FROM agents WHERE id = ?')
      .get('agent-idle') as { status: string; dormant_reason: string | null }
    expect(after).toEqual({ status: 'paused', dormant_reason: 'provider_down' })
  })
})

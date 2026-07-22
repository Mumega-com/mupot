import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgent, findAgentsByName, getAgentProfile } from '../src/org/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// Port 1.3 agent profile (0068_agent_profile.sql). Real SQLite, ALL migrations
// applied in order (incl. 0068) — so this exercises the actual production write/read
// path, not a JS-reimplemented mock. This is the anti-pattern guard from
// feedback_test_real_production_path_not_isolation: prove the columns exist, the
// INSERT binds them, and resolve reads them back across squads.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-1', 'sqa', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-b', 'dept-1', 'sqb', 'Squad B');
    -- 'scale' tier → unlimited maxAgents, so the entitlement gate doesn't cap the
    -- multi-agent sprawl test (free tier would block the 3rd create).
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
  `)
}

describe('Port 1.3 agent profile (0068) — real SQL', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    seed(harness.sqlite)
    env = { DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  it('0068 adds the profile columns to the agents table', () => {
    const cols = harness.sqlite
      .prepare('PRAGMA table_info(agents)')
      .all()
      .map((r) => (r as { name: string }).name)
    for (const c of [
      'purpose',
      'owner',
      'model_fallback',
      'capabilities',
      'skills',
      'parent_agent_id',
      'qnft_ref',
      'death_condition',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('persists a full profile and reads it back with arrays parsed', async () => {
    const res = await createAgent(env, 'sq-a', {
      slug: 'kayhermes',
      name: 'KayHermes',
      role: 'concierge',
      model: 'gpt-5.6-sol',
      purpose: 'the canonical Hermes runtime / concierge',
      owner: 'member-hadi',
      model_fallback: 'claude-sonnet-5',
      capabilities: ['presence', 'task', 'recall', 'comms'],
      skills: ['dispatch', 'triage'],
      qnft_ref: 'qnft:942e2845',
      death_condition: { idle_ttl_hours: 168, policy: 'no_instance_no_activity' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.capabilities).toEqual(['presence', 'task', 'recall', 'comms'])
    expect(res.value.skills).toEqual(['dispatch', 'triage'])

    // read back through the production read path
    const profile = await getAgentProfile(env, res.value.id)
    expect(profile).not.toBeNull()
    expect(profile?.purpose).toBe('the canonical Hermes runtime / concierge')
    expect(profile?.owner).toBe('member-hadi')
    expect(profile?.model_fallback).toBe('claude-sonnet-5')
    expect(profile?.capabilities).toEqual(['presence', 'task', 'recall', 'comms'])
    expect(profile?.qnft_ref).toBe('qnft:942e2845')
    expect(JSON.parse(profile?.death_condition ?? '{}')).toEqual({
      idle_ttl_hours: 168,
      policy: 'no_instance_no_activity',
    })
  })

  it('a minimal create (no profile) leaves every profile field null', async () => {
    const res = await createAgent(env, 'sq-a', { slug: 'bare', name: 'Bare' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.purpose).toBeNull()
    expect(res.value.capabilities).toBeNull()
    expect(res.value.death_condition).toBeNull()
    const profile = await getAgentProfile(env, res.value.id)
    expect(profile?.capabilities).toBeNull()
    expect(profile?.owner).toBeNull()
  })

  it('resolve-before-mint finds same-named agents ACROSS squads (the sprawl case)', async () => {
    // three distinct "hermes" agents in different squads — the 2026-07-21 incident.
    await createAgent(env, 'sq-a', { slug: 'kayhermes', name: 'KayHermes', role: 'concierge' })
    await createAgent(env, 'sq-b', { slug: 'agent-hermes', name: 'Agent Hermes', role: 'represents-hadi' })
    await createAgent(env, 'sq-b', { slug: 'hadi-hermes', name: 'Hadi Hermes', role: 'macbook' })

    const matches = await findAgentsByName(env, 'hermes')
    expect(matches).toHaveLength(3)
    // the roles are visible — the whole point of resolve-before-mint
    const roles = matches.map((m) => m.role).sort()
    expect(roles).toEqual(['concierge', 'macbook', 'represents-hadi'])
  })

  it('resolve is case-insensitive and matches slug too', async () => {
    await createAgent(env, 'sq-a', { slug: 'growth-lead', name: 'Growth Lead' })
    expect(await findAgentsByName(env, 'GROWTH')).toHaveLength(1) // name, upper
    expect(await findAgentsByName(env, 'growth-lead')).toHaveLength(1) // slug
    expect(await findAgentsByName(env, 'nonexistent')).toHaveLength(0)
  })

  it('resolve excludes inactive agents by default, includes them on request', async () => {
    const res = await createAgent(env, 'sq-a', { slug: 'retired', name: 'Retired One' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    harness.sqlite.prepare("UPDATE agents SET status = 'inactive' WHERE id = ?").run(res.value.id)
    expect(await findAgentsByName(env, 'retired')).toHaveLength(0)
    expect(await findAgentsByName(env, 'retired', { includeInactive: true })).toHaveLength(1)
  })

  it('rejects invalid profile shapes', async () => {
    const bad = [
      { capabilities: ['ok', 42] as unknown, expected: 'invalid_capabilities' },
      { capabilities: 'not-an-array' as unknown, expected: 'invalid_capabilities' },
      { skills: [{}] as unknown, expected: 'invalid_skills' },
      { death_condition: 'not json{' as unknown, expected: 'invalid_death_condition' },
      { death_condition: [1, 2] as unknown, expected: 'invalid_death_condition' }, // array not object
      { death_condition: '42' as unknown, expected: 'invalid_death_condition' }, // scalar JSON string
      { death_condition: '"null"' as unknown, expected: 'invalid_death_condition' }, // JSON scalar
      { purpose: 123 as unknown, expected: 'invalid_purpose' },
    ]
    for (const [i, c] of bad.entries()) {
      const res = await createAgent(env, 'sq-a', { slug: `bad-${i}`, name: `Bad ${i}`, ...c })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe(c.expected)
    }
  })

  it('accepts death_condition passed as a JSON string, stored verbatim', async () => {
    const res = await createAgent(env, 'sq-a', {
      slug: 'str-dc',
      name: 'Str DC',
      death_condition: '{"idle_ttl_hours":72}',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.value.death_condition ?? '{}')).toEqual({ idle_ttl_hours: 72 })
  })

  it('validates parent_agent_id against a real row (soft ref, no phantom parents)', async () => {
    const phantom = await createAgent(env, 'sq-a', {
      slug: 'orphan',
      name: 'Orphan',
      parent_agent_id: 'does-not-exist',
    })
    expect(phantom.ok).toBe(false)
    if (!phantom.ok) expect(phantom.error).toBe('parent_agent_not_found')

    const parent = await createAgent(env, 'sq-a', { slug: 'parent', name: 'Parent' })
    expect(parent.ok).toBe(true)
    if (!parent.ok) return
    const child = await createAgent(env, 'sq-a', {
      slug: 'child',
      name: 'Child',
      parent_agent_id: parent.value.id,
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(child.value.parent_agent_id).toBe(parent.value.id)
  })

  it('resolve LIKE wildcards in the query are escaped (not treated as wildcards)', async () => {
    await createAgent(env, 'sq-a', { slug: 'real', name: 'Real Agent' })
    // '%' would match everything if not escaped; it should match literally → 0 rows.
    expect(await findAgentsByName(env, '%')).toHaveLength(0)
  })
})

// tests/check-in-seat-runtime.test.ts — S2 (mumega-com#1351): check_in persists
// fleet_agents.runtime from the SERVER-HELD harness kind of a seat binding, never from client text.
// Real SQLite + the full migration chain (no hand-rolled schema).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { harnessKindToRuntime, persistSeatRuntimeFromHarness } from '../src/fleet/registry'
import { upsertHarness } from '../src/members/harness'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const HUMAN = 'member-human'
const SEAT_MEMBER = 'member-seat'
const SQUAD_ID = 'squad-1'
const AGENT_ID = 'agent-seat-1'
const OTHER_AGENT_ID = 'agent-other'

let harness: SqliteD1Harness
let env: Env
let harnessId: string

function seatAuth(): AuthContext {
  return {
    userId: SEAT_MEMBER,
    memberId: SEAT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [{ member_id: SEAT_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
    seatBinding: { seatId: 'seat-1', label: 'seat-1', harnessId, grantTokenId: 'tok-1', humanMemberId: HUMAN, source: 'handle' },
  }
}

function runtimeOf(agentId: string): string | undefined {
  const r = harness.sqlite.prepare('SELECT runtime FROM fleet_agents WHERE tenant = ? AND agent_id = ?').get(TENANT, agentId) as
    | { runtime: string }
    | undefined
  return r?.runtime
}

function seedFleetRow(agentId: string, runtime: string): void {
  harness.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, member_id)
     VALUES (?1, ?2, 'd', ?3, '[]', 'on_demand', 'running', ?1, ?4)`,
  ).run(agentId, TENANT, runtime, SEAT_MEMBER)
}

describe('check_in persists fleet_agents.runtime from the server-held harness kind (S2)', () => {
  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 's', 'S');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
        VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'seat-1', 'Seat 1', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z'),
               ('${OTHER_AGENT_ID}', '${SQUAD_ID}', 'other', 'Other', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
      INSERT INTO members (id, display_name, email, status, tenant) VALUES
        ('${HUMAN}', 'Human', 'h@example.com', 'active', '${TENANT}'),
        ('${SEAT_MEMBER}', 'Seat', 's@example.com', 'active', '${TENANT}');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: { get: async () => null, put: async () => {} } } as unknown as Env
    const h = await upsertHarness(env, HUMAN, 'client-1', 'Codex CLI')
    if (!h) throw new Error('harness fixture failed')
    harnessId = h.id
  })

  afterEach(() => harness.close())

  it('(a) writes the runtime mapped from the harness kind onto the caller\'s own row', async () => {
    seedFleetRow(AGENT_ID, '')
    const res = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('codex')
  })

  it('(b) ignores client-supplied runtime text: a runtime arg is refused outright, and lying harness/source args change nothing', async () => {
    seedFleetRow(AGENT_ID, '')
    const refused = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1', runtime: 'tmux' }, 'https://pot.example')
    expect(refused.ok).toBe(false)
    expect(runtimeOf(AGENT_ID)).toBe('')
    const res = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1', harness: 'claude-code', source: 'python' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('codex')
  })

  it('never touches another agent\'s row, creates no row, and leaves an already-reported runtime alone', async () => {
    seedFleetRow(OTHER_AGENT_ID, '')
    await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(OTHER_AGENT_ID)).toBe('')
    expect(runtimeOf(AGENT_ID)).toBeUndefined()
    seedFleetRow(AGENT_ID, 'herdr')
    await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('herdr')
  })

  it('a session without a seat binding writes nothing, even if the harness arg names a runtime', async () => {
    seedFleetRow(AGENT_ID, '')
    const a = seatAuth()
    delete a.seatBinding
    await invokeTool(a, env, 'check_in', { seat: 'seat-1', harness: 'claude-code' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('a binding that names another human\'s harness id reads as absent: no write', async () => {
    seedFleetRow(AGENT_ID, '')
    const a = seatAuth()
    if (a.seatBinding) a.seatBinding = { ...a.seatBinding, humanMemberId: SEAT_MEMBER }
    await invokeTool(a, env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('a throwing harness loader never fails check_in (fail-soft)', async () => {
    seedFleetRow(AGENT_ID, '')
    const realPrepare = harness.db.prepare.bind(harness.db)
    const throwing = {
      ...env,
      DB: new Proxy(harness.db, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (/FROM harnesses/.test(sql)) throw new Error('d1 down')
              return realPrepare(sql)
            }
          }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      }),
    } as unknown as Env
    const res = await invokeTool(seatAuth(), throwing, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('a key-registered agent keeps its runtime unset over a bearer seat session (boot-self-report rule)', async () => {
    seedFleetRow(AGENT_ID, '')
    harness.sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, created_at) VALUES (?, ?, 'k', 1)`).run(TENANT, AGENT_ID)
    const res = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('an OAuth harness named like Claude is a Desktop/claude.ai guess: runtime stays unset', async () => {
    seedFleetRow(AGENT_ID, '')
    const h = await upsertHarness(env, HUMAN, 'client-claude', 'Claude Desktop')
    if (!h) throw new Error('fixture')
    const a = seatAuth()
    if (a.seatBinding) a.seatBinding = { ...a.seatBinding, harnessId: h.id }
    await invokeTool(a, env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('')
  })
})

describe('harnessKindToRuntime table', () => {
  it.each([
    ['claude', 'oauth', null],
    ['claude', 'token', null],
    ['claude-code', 'token', 'claude-code'],
    ['claude-code', 'oauth', null],
    ['codex', 'oauth', 'codex'],
    ['codex', 'token', 'codex'],
    ['grok', 'oauth', 'grok'],
    ['grok', 'token', 'grok'],
    ['cursor', 'oauth', 'cursor-ide'],
    ['cursor', 'token', 'cursor-agent'],
    ['gemini', 'oauth', 'antigravity-cli'],
    ['chatgpt', 'oauth', null],
    ['ci', 'token', null],
    ['other', 'oauth', null],
    ['', 'oauth', null],
  ] as const)('%s / %s -> %s', (kind, cred, want) => {
    expect(harnessKindToRuntime(kind, cred)).toBe(want)
  })
})

describe('persistSeatRuntimeFromHarness EXISTS re-check (called directly)', () => {
  let h: SqliteD1Harness
  let e: Env
  let hid: string
  beforeEach(async () => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO members (id, display_name, email, status, tenant) VALUES
        ('${HUMAN}', 'Human', 'h@example.com', 'active', '${TENANT}'),
        ('${SEAT_MEMBER}', 'Seat', 's@example.com', 'active', '${TENANT}');
    `)
    e = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
    const row = await upsertHarness(e, HUMAN, 'client-1', 'Codex CLI')
    if (!row) throw new Error('fixture')
    hid = row.id
    h.sqlite.prepare(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, member_id)
       VALUES (?1, ?2, 'd', '', '[]', 'on_demand', 'running', ?1, ?3)`,
    ).run(AGENT_ID, TENANT, SEAT_MEMBER)
  })
  afterEach(() => h.close())

  const base = () => ({ agentId: AGENT_ID, harnessId: hid, harnessMemberId: HUMAN, harnessKind: 'codex', harnessCredentialKind: 'oauth' as const })

  it('control: matching harness fills exactly 1 row', async () => {
    expect(await persistSeatRuntimeFromHarness(e, base())).toBe(1)
  })
  it('stale kind (harness re-kinded since the read) changes 0 rows', async () => {
    expect(await persistSeatRuntimeFromHarness(e, { ...base(), harnessKind: 'grok' })).toBe(0)
  })
  it('foreign member changes 0 rows', async () => {
    expect(await persistSeatRuntimeFromHarness(e, { ...base(), harnessMemberId: SEAT_MEMBER })).toBe(0)
  })
  it('stale credential kind changes 0 rows', async () => {
    expect(await persistSeatRuntimeFromHarness(e, { ...base(), harnessCredentialKind: 'token' })).toBe(0)
  })
  it('deleted harness (EXISTS fails) changes 0 rows', async () => {
    h.sqlite.prepare('DELETE FROM harnesses WHERE id = ?').run(hid)
    expect(await persistSeatRuntimeFromHarness(e, base())).toBe(0)
  })
})

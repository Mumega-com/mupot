// Boot is the single writer of OBSERVED facts (runtime, model, host, connection kind, last boot).
// Declared fields (owner, role, purpose, name) are never written by boot. Intake is graceful:
// any bounded string is accepted; only non-strings are refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { selfReportAtBoot } from '../src/fleet/boot-self-report'
import type { AuthContext, Env } from '../src/types'

const ORIGIN = 'https://pot.test'
const AGENT = 'agent-athena'

let harness: SqliteD1Harness
let env: Env

const bound = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'mem-1', email: 'a@e.test', role: 'member', tenant: 'mumega',
  memberId: 'mem-1', channel: 'workspace', capabilities: [], boundAgentId: AGENT, ...over,
}) as AuthContext

const attached = (): AuthContext => bound({
  channel: 'directory',
  seatBinding: {
    seatId: 'seat-1', label: 'codex-thread', harnessId: 'h1', grantTokenId: 't1', humanMemberId: 'mem-1', source: 'handle',
    attached: { attachmentId: 'att-1', admissionId: 'adm-1', agentId: AGENT, seatAgentId: 'seat-agent', ceiling: 'member' },
  },
})
const member = (): AuthContext => bound({ boundAgentId: null })

interface Onboarding { connection_kind: string; inbox?: string; next_step?: string }
interface Boot { onboarding?: Onboarding; registry?: { outcome: string; detail?: string } }
const boot = async (auth: AuthContext, args: Record<string, unknown> = {}, ctx: string | { origin: string; sideEffectFree: boolean } = ORIGIN) => {
  const out = await invokeTool(auth, env, 'boot_context', args, ctx)
  return ((out as { result?: Boot }).result ?? {}) as Boot
}
const row = () => harness.sqlite.prepare(
  `SELECT runtime, runtime_canonical, model, host, connection_kind, last_boot_at, status FROM fleet_agents WHERE agent_id = ?`,
).get(AGENT) as
  { runtime: string; runtime_canonical: string; model: string | null; host: string; connection_kind: string; last_boot_at: string | null; status: string } | undefined

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO fleet_agents (agent_id, tenant, runtime, status, reported_by, last_reported_at)
    VALUES ('${AGENT}', 'mumega', 'grok', 'running', 'daemon', datetime('now'));
  `)
})
afterEach(() => harness.close())

describe('agent-bound boot records observed facts', () => {
  it('records runtime, model, host, server-derived connection_kind and last boot', async () => {
    const r = await boot(bound(), { runtime: 'codex-cli', model: 'gpt-5.6', host: 'muvps' })
    expect(r.registry?.outcome).toBe('recorded')
    expect(row()).toMatchObject({ runtime: 'codex-cli', runtime_canonical: 'codex-cli', model: 'gpt-5.6', host: 'muvps', connection_kind: 'agent_bound' })
    expect(row()?.last_boot_at).toBeTruthy()
    expect(r.onboarding).toEqual({ connection_kind: 'agent_bound' })
  })

  it('connection_kind cannot be set from args', async () => {
    await boot(bound(), { runtime: 'codex', connection_kind: 'attached' }).catch(() => undefined)
    await boot(bound(), { runtime: 'codex' })
    expect(row()?.connection_kind).toBe('agent_bound')
  })

  it('omitting runtime/model/host returns a next_step asking for them, and still stamps boot time', async () => {
    const r = await boot(bound())
    expect(r.onboarding?.next_step).toMatch(/runtime, model, host/)
    expect(row()?.connection_kind).toBe('agent_bound')
    expect(row()?.last_boot_at).toBeTruthy()
    expect(row()?.runtime).toBe('grok') // unclaimed fields are not blanked
  })

  it('an unknown harness boots fine: raw stored, canonical other', async () => {
    const r = await boot(bound(), { runtime: 'my-new-harness' })
    expect(r.registry?.outcome).toBe('recorded')
    expect(row()).toMatchObject({ runtime: 'my-new-harness', runtime_canonical: 'other' })
  })

  it('oversize values truncate, control chars strip, whitespace-only host is "not reported"', async () => {
    await boot(bound(), { runtime: 'x'.repeat(300), host: 'h\u0007ost\n' })
    expect(row()?.runtime).toHaveLength(64)
    expect(row()?.host).toBe('host')
    await boot(bound(), { host: '   ' })
    expect(row()?.host).toBe('host') // whitespace-only did not blank it
  })

  it('non-string values are refused and nothing changes', async () => {
    for (const bad of [{ runtime: 5 }, { model: {} }, { host: ['x'] }]) {
      const out = await invokeTool(bound(), env, 'boot_context', bad, ORIGIN)
      const reg = ((out as { result?: Boot }).result)?.registry
      // The shared arg validator may refuse first; either way nothing is written.
      if (out.ok) expect(reg?.outcome).toBe('refused_not_a_string')
    }
    expect(row()?.runtime).toBe('grok')
    expect(row()?.connection_kind).toBe('')
  })

  it('selfReportAtBoot refuses a non-string runtime/model/host and writes nothing', async () => {
    for (const claim of [{ runtime: 5 }, { model: {} }, { host: ['x'] }]) {
      const r = await selfReportAtBoot(env, AGENT, claim)
      expect(r.outcome).toBe('refused_not_a_string')
    }
    expect(row()).toMatchObject({ runtime: 'grok', host: '', connection_kind: '' })
  })

  it('never writes declared agent fields', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, kind) VALUES ('d', 'd', 'D', 'work');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('s', 'd', 's', 'S', 'work');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', 's', 'athena', 'Athena', 'lead', 'old', 'active');
    `)
    const before = harness.sqlite.prepare(`SELECT name, role, slug, owner_member_id, squad_id FROM agents WHERE id = ?`).get(AGENT)
    await boot(bound(), { runtime: 'codex', model: 'gpt-5.6', host: 'muvps' })
    expect(harness.sqlite.prepare(`SELECT name, role, slug, owner_member_id, squad_id FROM agents WHERE id = ?`).get(AGENT)).toEqual(before)
  })
})

describe('attached and member boots write nothing', () => {
  it('attached thread: no registry write, structured onboarding with inbox peek_only, no token text', async () => {
    const r = await boot(attached(), { runtime: 'codex-cli', model: 'x', host: 'laptop' })
    expect(row()).toMatchObject({ runtime: 'grok', model: null, host: '', connection_kind: '' })
    expect(row()?.last_boot_at).toBeNull()
    expect(r.onboarding?.connection_kind).toBe('attached')
    expect(r.onboarding?.inbox).toBe('peek_only')
    expect(r.onboarding?.next_step).toMatch(/cannot consume it/)
    expect(r.onboarding?.next_step).toMatch(/agent-bound connection/)
    expect(JSON.stringify(r.onboarding)).not.toMatch(/mupot_|mtok_|Bearer/i)
  })

  it('member token: no write, onboarding explains the agent-bound connection', async () => {
    const r = await boot(member(), { runtime: 'codex-cli', host: 'laptop' })
    expect(row()).toMatchObject({ runtime: 'grok', host: '', connection_kind: '' })
    expect(r.onboarding?.connection_kind).toBe('member')
    expect(r.onboarding?.next_step).toMatch(/agent-bound connection/)
  })

  it('sideEffectFree (profile) path writes nothing and adds no onboarding block', async () => {
    const r = await boot(bound(), {}, { origin: ORIGIN, sideEffectFree: true })
    expect(row()?.connection_kind).toBe('')
    expect(r.onboarding).toBeUndefined()
  })
})

describe('fleet_agent_get exposes the observed facts', () => {
  it('returns runtime_canonical, model, host, connection_kind, last_boot_at', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, kind) VALUES ('d', 'd', 'D', 'work');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('s', 'd', 's', 'S', 'work');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', 's', 'athena', 'Athena', 'lead', 'old', 'active');
    `)
    await boot(bound(), { runtime: 'weird-one', model: 'm1', host: 'box' })
    const out = await invokeTool(bound(), env, 'fleet_agent_get', {}, ORIGIN)
    const r = (out as { result?: Record<string, unknown> }).result
    expect(r).toMatchObject({ runtime_canonical: 'other', model: 'm1', host: 'box', connection_kind: 'agent_bound' })
    expect(r?.last_boot_at).toBeTruthy()
  })
})

describe('check_in accepts any harness', () => {
  const checkIn = async (args: Record<string, unknown>) => {
    harness.sqlite.exec(`INSERT OR IGNORE INTO members (id, display_name, email, status, tenant) VALUES ('mem-1', 'Ada', 'a@e.test', 'active', 'mumega')`)
    return invokeTool(member(), env, 'check_in', { seat: 'seat-a', ...args }, ORIGIN)
  }
  const presence = () => harness.sqlite.prepare(`SELECT harness, harness_canonical FROM presence WHERE label = 'seat-a'`).get() as
    { harness: string; harness_canonical: string } | undefined

  it('an unknown harness checks in: raw stored, canonical other', async () => {
    const out = await checkIn({ harness: 'my-new-harness' })
    expect(out.ok).toBe(true)
    expect(presence()).toEqual({ harness: 'my-new-harness', harness_canonical: 'other' })
  })
  it('known values normalize to a canonical hint while the raw spelling is kept', async () => {
    await checkIn({ harness: 'Codex' })
    expect(presence()).toEqual({ harness: 'Codex', harness_canonical: 'codex-cli' })
  })
  it('oversize truncates instead of failing the call', async () => {
    const out = await checkIn({ harness: 'h'.repeat(500) })
    expect(out.ok).toBe(true)
    expect(presence()?.harness).toHaveLength(64)
  })
  it('empty means unknown; non-strings are refused', async () => {
    expect((await checkIn({ harness: '  ' })).ok).toBe(true)
    expect(presence()).toEqual({ harness: 'unknown', harness_canonical: 'unknown' })
    expect((await checkIn({ harness: 7 })).ok).toBe(false)
  })
})

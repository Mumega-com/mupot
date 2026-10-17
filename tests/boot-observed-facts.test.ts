// Boot is the single writer of OBSERVED facts (runtime, model, host, connection kind, last boot).
// Declared fields (owner, role, purpose, name) are never written by boot. Intake is graceful:
// any bounded string is accepted; only non-strings are refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { selfReportAtBoot } from '../src/fleet/boot-self-report'
import { cleanReported, isNonAdoptedRuntime } from '../src/fleet/reported-values'
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
    expect(r.onboarding).toMatchObject({ connection_kind: 'agent_bound' })
    expect(r.onboarding?.next_step).toBeUndefined()
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

  it('non-string values through the tool are refused and nothing changes', async () => {
    for (const bad of [{ runtime: 5 }, { model: {} }, { host: ['x'] }]) {
      const out = await invokeTool(bound(), env, 'boot_context', bad, ORIGIN)
      // Refused either by the shared arg validator or by selfReportAtBoot; never accepted.
      const refusedBy = out.ok ? ((out as { result?: Boot }).result?.registry?.outcome ?? null) : 'validator'
      expect(['validator', 'refused_not_a_string']).toContain(refusedBy)
    }
    expect(row()).toMatchObject({ runtime: 'grok', host: '', connection_kind: '' })
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
    expect(r.onboarding?.next_step).toMatch(/cannot consume, lease or ack/)
    expect((r.onboarding as { for_owner?: { next_step: string } }).for_owner?.next_step).toMatch(/agent-bound connection/)
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

describe('keyed agents', () => {
  const key = () => harness.sqlite.exec(`
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('mumega', '${AGENT}', 'AAAA', 'Ed25519', 'mem-1', datetime('now'));
  `)
  it('a keyed agent-bound boot is told to use POST /api/fleet/attach-signed, not to call boot again', async () => {
    key()
    const r = await boot(bound(), { runtime: 'codex-cli' })
    expect(r.registry?.outcome).toBe('refused_signed_attach_required')
    const ob = r.onboarding as Onboarding & { who_acts?: string; agent?: { keyed: boolean; can_self_report: boolean } }
    expect(ob.next_step).toContain('/api/fleet/attach-signed')
    expect(ob.next_step).not.toMatch(/call boot_context again/)
    expect(ob.who_acts).toBe('self')
    expect(ob.agent).toMatchObject({ keyed: true, can_self_report: false })
    expect(row()?.runtime).toBe('grok')
  })
  it('a keyed nothing-claimed boot does not stamp connection kind or boot time', async () => {
    key()
    await boot(bound())
    expect(row()).toMatchObject({ connection_kind: '', last_boot_at: null })
  })
})

describe('attached onboarding is fence-aware', () => {
  type Ob = Onboarding & { who_acts?: string; agent?: { keyed: boolean; inbox: string; can_self_report: boolean }; for_owner?: { who_acts: string; next_step: string } }
  it('peek works: action first, names inbox_mark_handled, owner note is information', async () => {
    const e2 = { ...env, SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1' } as unknown as Env
    const out = await invokeTool(attached(), e2, 'boot_context', {}, ORIGIN)
    const ob = ((out as { result?: Boot }).result?.onboarding) as Ob
    expect(ob.next_step).toMatch(/^read the agent inbox with inbox \{ peek: true \}/)
    expect(ob.next_step).toContain('inbox_mark_handled { ids }')
    expect(ob.who_acts).toBe('self')
    expect(ob.agent).toMatchObject({ inbox: 'peek', can_self_report: false })
    expect(ob.for_owner?.who_acts).toBe('owner')
    expect(ob.for_owner?.next_step).toMatch(/agent-bound connection/)
  })
  it('signed_only: says peek is refused, who acts is admin, never promises mark_handled', async () => {
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, display_name, email, status, tenant) VALUES ('mem-1', 'Ada', 'a@e.test', 'active', 'mumega');
      INSERT INTO departments (id, slug, name, kind) VALUES ('d', 'd', 'D', 'work');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('s', 'd', 's', 'S', 'work');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', 's', 'athena', 'Athena', 'lead', 'old', 'active');
    `)
    harness.sqlite.exec(`INSERT INTO agent_inbox_fences (tenant, agent_id, mode, generation, updated_at, updated_by_member_id, reason, key_fingerprint) VALUES ('mumega', '${AGENT}', 'signed_only', 1, datetime('now'), 'mem-1', 'test', '${'a'.repeat(64)}')`)
    const r = await boot(attached())
    const ob = r.onboarding as Ob
    expect(ob.next_step).toMatch(/peek is refused/)
    expect(ob.next_step).toContain('set_agent_inbox_consumer')
    expect(ob.next_step).not.toContain('inbox_mark_handled')
    expect(ob.who_acts).toBe('admin')
    expect(ob.agent?.inbox).toBe('fenced')
  })
})

describe('seat sessions', () => {
  it('a non-attached seat-bound session records connection_kind seat', async () => {
    const seatAuth = bound({
      channel: 'directory',
      seatBinding: { seatId: 's1', label: 'thr', harnessId: 'h1', grantTokenId: 't1', humanMemberId: 'mem-1', source: 'handle' },
    })
    const r = await boot(seatAuth, { runtime: 'codex-cli' })
    expect(r.onboarding?.connection_kind).toBe('seat')
    expect(row()?.connection_kind).toBe('seat')
  })
})

describe('writes are narrow', () => {
  it('a nothing-claimed boot never sets status (an operator-stopped row stays stopped)', async () => {
    harness.sqlite.exec(`UPDATE fleet_agents SET status = 'stopped' WHERE agent_id = '${AGENT}'`)
    await boot(bound())
    expect(row()?.status).toBe('stopped')
  })
  it('a host not claimed is not blanked', async () => {
    await boot(bound(), { runtime: 'codex', host: 'muvps' })
    await boot(bound(), { runtime: 'codex-cli', model: 'm' })
    expect(row()?.host).toBe('muvps')
  })
  it('a check_in that omits harness keeps harness and harness_canonical', async () => {
    harness.sqlite.exec(`INSERT OR IGNORE INTO members (id, display_name, email, status, tenant) VALUES ('mem-1', 'Ada', 'a@e.test', 'active', 'mumega')`)
    await invokeTool(member(), env, 'check_in', { seat: 'seat-a', harness: 'my-new-harness' }, ORIGIN)
    await invokeTool(member(), env, 'check_in', { seat: 'seat-a', machine: 'box' }, ORIGIN)
    expect(harness.sqlite.prepare(`SELECT harness, harness_canonical FROM presence WHERE label = 'seat-a'`).get())
      .toEqual({ harness: 'my-new-harness', harness_canonical: 'other' })
  })
  it('agents.model only takes the strict charset; the raw model stays in fleet_agents', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, kind) VALUES ('d', 'd', 'D', 'work');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('s', 'd', 's', 'S', 'work');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', 's', 'athena', 'Athena', 'lead', 'old', 'active');
    `)
    const r = await selfReportAtBoot(env, AGENT, { model: 'weird/../model?x=1 y' })
    expect(r.outcome).toBe('recorded')
    expect((r as { notes?: string[] }).notes?.[0]).toMatch(/agents\.model unchanged/)
    expect((harness.sqlite.prepare(`SELECT model FROM agents WHERE id = ?`).get(AGENT) as { model: string }).model).toBe('old')
    expect(row()?.model).toBe('weird/../model?x=1 y')
    await selfReportAtBoot(env, AGENT, { model: 'gpt-5.6' })
    expect((harness.sqlite.prepare(`SELECT model FROM agents WHERE id = ?`).get(AGENT) as { model: string }).model).toBe('gpt-5.6')
  })
  it('runtime_canonical is computed at read, so a stale stored hint cannot show', async () => {
    harness.sqlite.exec(`UPDATE fleet_agents SET runtime = 'codex', runtime_canonical = 'stale' WHERE agent_id = '${AGENT}'`)
    const r = await selfReportAtBoot(env, AGENT, {})
    expect(r.belief?.runtime_canonical).toBe('codex-cli')
  })
})

describe('cleanReported', () => {
  it('strips zero-width and bidi characters', () => {
    expect(cleanReported('co\u200bde\u202ex\u2066\ufeff')).toBe('codex')
    expect(cleanReported('\u200b\u200f')).toBeNull()
  })
  it('does not split a surrogate pair at the cut', () => {
    const s = 'a'.repeat(63) + '\u{1F600}'
    const out = cleanReported(s, 64) as string
    expect(out).toBe('a'.repeat(63))
    expect(() => encodeURIComponent(out)).not.toThrow()
  })
})

describe('non-adopted runtime is refused on every intake', () => {
  const variants = ['goose', 'goosed', 'GOOSE', 'goo\u200bse', ' go\u202eosed ']
  it('shared predicate', () => {
    for (const v of variants) expect(isNonAdoptedRuntime(v)).toBe(true)
    expect(isNonAdoptedRuntime('gooseberry')).toBe(false)
    expect(isNonAdoptedRuntime(5)).toBe(false)
  })
  it('boot_context writes nothing', async () => {
    for (const v of variants) {
      const r = await boot(bound(), { runtime: v })
      expect(r.registry?.outcome).toBe('refused_not_adopted')
    }
    expect(row()?.runtime).toBe('grok')
  })
  it('check_in (MCP) refuses the harness', async () => {
    harness.sqlite.exec(`INSERT OR IGNORE INTO members (id, display_name, email, status, tenant) VALUES ('mem-1', 'Ada', 'a@e.test', 'active', 'mumega')`)
    for (const v of variants) {
      const out = await invokeTool(member(), env, 'check_in', { seat: 'seat-g', harness: v }, ORIGIN)
      expect(out.ok).toBe(false)
    }
    expect(harness.sqlite.prepare(`SELECT 1 FROM presence WHERE label = 'seat-g'`).get()).toBeUndefined()
  })
})

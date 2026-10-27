// tests/security-bar.test.ts — the Security Bar (registry, levels, fail-closed reads, step-up lowering, and the
// first batch of wired friction rules). Real SQLite + the full migration chain; no mocked policy.
//
// Mutations the PR description lists (each makes a named test here fail): make policy() ignore `floor`;
// resolve a failed read to onboarding; drop the strongReauth check in requestLower/confirmLower; skip the
// would_block write in relaxes(); let the nearer scope loosen the tenant level.

import * as barModule from '../src/policy/bar'
import catalogFixture from './fixtures/security-bar-catalog.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { createWebSession } from '../src/auth/web-sessions'
import { markRecentReauth } from '../src/auth/web-sessions'
import { verifyTaskEvidence } from '../src/tasks/evidence'
import { MISSING_LEVEL, FAIL_CLOSED_LEVEL, LOWER_DELAY_MS_FOR_TESTS, policy, resolveLevel, relaxes, PolicyReader } from '../src/policy/bar'
import { confirmLower, raiseLevel, requestLower } from '../src/policy/admin'
import { POLICY_LEVELS, POLICY_RULES, getRule, catalogRule, type CatalogRecord, type PolicyLevel } from '../src/policy/registry'
import { renderBarYaml } from '../src/dashboard/security-bar'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const OWNER1 = 'mem-owner1'
const OWNER2 = 'mem-owner2'
const PLAIN = 'mem-plain'
const MEM_A = 'mem-agent-a'
const SQ1 = 'sq-1'
const SQ2 = 'sq-2'
const AG_A = 'agent-a'
const AG_B = 'agent-b'
const AG_OFF = 'agent-off'
const MEM_B = 'mem-agent-b'
const SHA40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

let harness: SqliteD1Harness
let env: Env
const rows = (q: string, ...a: unknown[]): Array<Record<string, unknown>> => harness.sqlite.prepare(q).all(...a) as Array<Record<string, unknown>>
const one = (q: string, ...a: unknown[]): Record<string, unknown> => harness.sqlite.prepare(q).get(...a) as Record<string, unknown>
const events = (kind?: string): Array<Record<string, unknown>> => rows(`SELECT * FROM policy_events ${kind ? 'WHERE kind = ?' : ''} ORDER BY seq`, ...(kind ? [kind] : []))
function setLevel(level: string | null, scopeKind = 'tenant', scopeId = TENANT): void {
  harness.sqlite.prepare('DELETE FROM security_bar_state WHERE scope_kind = ? AND scope_id = ?').run(scopeKind, scopeId)
  if (level) harness.sqlite.prepare(`INSERT INTO security_bar_state (scope_kind, scope_id, level, version, updated_by) VALUES (?, ?, ?, 1, 'test')`).run(scopeKind, scopeId, level)
}

const cap = (member: string, scopeType: 'org' | 'squad', scopeId: string | null, capability: CapabilityGrant['capability']): CapabilityGrant => ({ member_id: member, scope_type: scopeType, scope_id: scopeId, capability })
function agentAuth(opts: { caps?: CapabilityGrant[] } = {}): AuthContext {
  return { userId: 'agent:a', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: MEM_A, boundAgentId: AG_A, capabilities: opts.caps ?? [cap(MEM_A, 'squad', SQ1, 'member')] } as AuthContext
}
function humanAuth(id: string, caps: CapabilityGrant[], extra: Partial<AuthContext> = {}): AuthContext {
  return { userId: id, email: `${id}@x.test`, role: 'member', tenant: TENANT, channel: 'workspace', memberId: id, boundAgentId: null, capabilities: caps, ...extra } as AuthContext
}
const owner1 = (extra: Partial<AuthContext> = {}): AuthContext => humanAuth(OWNER1, [cap(OWNER1, 'org', null, 'owner')], extra)
const owner2 = (extra: Partial<AuthContext> = {}): AuthContext => humanAuth(OWNER2, [cap(OWNER2, 'org', null, 'owner')], extra)

async function webSession(memberId: string, reauthAgoMs: number | null): Promise<Partial<AuthContext>> {
  harness.sqlite.exec('PRAGMA foreign_keys = OFF')
  harness.sqlite.prepare(`INSERT OR IGNORE INTO human_login_identities (id, tenant, provider, provider_subject, member_id) VALUES (?, ?, 'google', ?, ?)`).run(`li-${memberId}`, TENANT, `sub-${memberId}`, memberId)
  const raw = `raw-${memberId}-${Math.random()}`
  const rec = await createWebSession(env, raw, { tenant: TENANT, memberId, loginIdentityId: `li-${memberId}` })
  harness.sqlite.exec('PRAGMA foreign_keys = ON')
  if (reauthAgoMs !== null) await markRecentReauth(env, rec.id_hash, Date.now() - reauthAgoMs)
  return { webSessionIdHash: rec.id_hash, webSessionMemberId: memberId }
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status) VALUES
      ('${OWNER1}', '${TENANT}', 'o1@x.test', 'Owner1', 'active'),
      ('${OWNER2}', '${TENANT}', 'o2@x.test', 'Owner2', 'active'),
      ('${PLAIN}', '${TENANT}', 'p@x.test', 'Plain', 'active'),
      ('${MEM_A}', '${TENANT}', 'a@x.test', 'AgentA', 'active'),
      ('${MEM_B}', '${TENANT}', 'b@x.test', 'AgentB', 'active');
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ1}', 'dept-1', 'sq1', 'Squad1'), ('${SQ2}', 'dept-1', 'sq2', 'Squad2');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AG_A}', '${SQ1}', 'agent-a', 'A', 'active'), ('${AG_B}', '${SQ2}', 'agent-b', 'B', 'active'), ('${AG_OFF}', '${SQ1}', 'agent-off', 'Off', 'paused');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AG_B}', '${MEM_B}', '2026-10-26T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1', '${OWNER1}', 'org', NULL, 'owner'), ('c3', '${MEM_A}', 'squad', '${SQ1}', 'member');
  `)
})
afterEach(() => { vi.restoreAllMocks(); harness.close() })

describe('registry', () => {
  it('ids are unique area.verb.what and every floor is strict at every level', () => {
    const ids = POLICY_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of POLICY_RULES) {
      expect(r.id).toMatch(/^[a-z]+(\.[a-z0-9-]+){1,3}$/)
      expect(r.sites.length).toBeGreaterThan(0)
      if (r.floor) for (const l of POLICY_LEVELS) expect(r.values[l], `${r.id}@${l}`).toBe('strict')
    }
  })

  it('every baseline protection (E3) is a registered floor', () => {
    for (const id of ['tenant.isolation', 'authz.admission', 'identity.step-up-sensitive', 'abuse.rate-limits', 'review.independent-gate', 'task.evidence.approval-binding', 'bar.lowering-step-up', 'bar.fail-closed']) {
      expect(getRule(id)?.floor, id).toBe(true)
    }
  })

  it('D1 and R1 are registered as TODO entries pointing at their owners, not wired', () => {
    for (const id of ['verdict.owner-self-approve', 'thread.attach-existing-agent']) {
      const r = getRule(id)
      expect(r?.todo).toMatch(/^TODO\(/)
      expect(r?.floor).toBe(false)
    }
  })

  it('a floor cannot be moved through the bar: policy() is strict at every level, even if the row said otherwise', async () => {
    for (const level of POLICY_LEVELS) {
      setLevel(level)
      for (const r of POLICY_RULES.filter((x) => x.floor)) {
        const d = await policy(env, {}, r.id)
        expect(d.relaxed, `${r.id}@${level}`).toBe(false)
        expect(d.floor).toBe(true)
      }
    }
    // unknown ids fail closed too
    setLevel('onboarding')
    expect((await policy(env, {}, 'no.such.rule')).relaxed).toBe(false)
  })

  it('the YAML read view lists every rule, marks floors read-only, and shows the effective value', () => {
    const y = renderBarYaml('onboarding', 'row', 3)
    for (const r of POLICY_RULES) expect(y).toContain(`  ${r.id}:`)
    expect(y).toMatch(/task\.create\.gate-owner-own-lane:\n\s+floor: true  # read-only/)
    expect(y).toMatch(/task\.intake\.p1-linkage:\n\s+floor: false\n\s+onboarding: relaxed\n\s+operating: strict\n\s+under_attack: strict\n\s+effective: relaxed/)
    expect(renderBarYaml('under_attack', 'row', 3)).toMatch(/task\.intake\.p1-linkage:[\s\S]*?effective: strict/)
  })
})

describe('catalog alignment (receipts/policy-catalog-20261026.json)', () => {
  const rec = (cls: CatalogRecord['class']): CatalogRecord => ({ id: 'auth.session.ttl-7d', file_line: 'src/auth/index.ts:89', code: null, blocks: 'sessions expire after 7d', who: ['owner'], threat: 'stolen cookie', class: cls, bar: { current: '7d', onboarding: '7d', operating: '7d', under_attack: '24h' } })
  it('a catalog record becomes a registry rule as plain data; nothing relaxes until a batch wires it', async () => {
    expect(catalogRule(rec('FLOOR'))).toMatchObject({ floor: true, class: 'FLOOR' })
    const bar = catalogRule(rec('BAR'))
    expect(bar.floor).toBe(false)
    expect(bar.todo).toMatch(/^TODO\(batch\)/)
    for (const l of POLICY_LEVELS) expect(bar.values[l]).toBe('strict')
    expect(catalogRule(rec('BAR'), { values: { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' } }).values.onboarding).toBe('relaxed')
  })
  it('matches catalog classes in both directions for every wired catalog rule', () => {
    // These two class changes were explicitly approved for this batch; other catalog classes stay intact.
    const overrides: Record<string, string> = {
      'task.create.gate-owner-creator-is-assignee': 'BAR',
      'task.update.artifact-shape-gate': 'BAR',
    }
    const wiredIds = [
      'task.create.gate-owner-creator-is-assignee', 'task.intake.p1-linkage',
      'task.create.assignee-agent-resolvable.cross-squad', 'task.create.assignee-agent-resolvable.inactive',
      'task.create.assignee-member-resolvable', 'task.update.transition-matrix', 'task.update.artifact-shape-gate',
    ]
    const expanded = catalogFixture.flatMap(rec => rec.id === 'task.create.assignee-agent-resolvable'
      ? ['cross-squad', 'inactive'].map(suffix => ({ ...rec, id: rec.id + '.' + suffix })) : [rec])
    expect(expanded.map(r => r.id).sort()).toEqual([...wiredIds].sort())
    expect(POLICY_RULES.filter(r => r.class && r.sites.some(site => /(?:resolveTaskAssignee|verifyTaskEvidence|checkTransition|assertValidIntakeContract|toolTaskCreate)/.test(site))).map(r => r.id).sort()).toEqual([...wiredIds].sort())
    for (const rec of expanded) {
      const cls = overrides[rec.id] ?? rec.class
      expect(getRule(rec.id)?.class, rec.id).toBe(cls)
      expect(getRule(rec.id)?.floor, rec.id).toBe(cls === 'FLOOR')
    }
  })

  it('pins literal values per level, and every rule is strict at operating and with no row', async () => {
    const expected: Record<string, { onboarding: string; operating: string; under_attack: string }> = {
      'task.create.gate-owner-creator-is-assignee': { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' },
      'task.intake.p1-linkage': { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' },
      'task.create.assignee-agent-resolvable.cross-squad': { onboarding: 'strict', operating: 'strict', under_attack: 'strict' },
      'task.create.assignee-agent-resolvable.inactive': { onboarding: 'strict', operating: 'strict', under_attack: 'strict' },
      'task.create.assignee-member-resolvable': { onboarding: 'strict', operating: 'strict', under_attack: 'strict' },
      'task.update.transition-matrix': { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' },
      'task.update.artifact-shape-gate': { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' },
    }
    for (const [id, values] of Object.entries(expected)) expect(getRule(id)?.values, id).toEqual(values)
    for (const level of [null, 'operating']) {
      setLevel(level)
      for (const rule of POLICY_RULES) expect((await policy(env, {}, rule.id)).value, rule.id).toBe('strict')
    }
  })
})

describe('level resolution fails closed', () => {
  it('missing row -> operating (today\'s behaviour), not the loose onboarding default', async () => {
    const r = await resolveLevel(env)
    expect(r.level).toBe(MISSING_LEVEL)
    expect(r.source).toBe('missing')
    expect(MISSING_LEVEL).toBe('operating')
  })

  it('failed read -> under_attack', async () => {
    harness.sqlite.exec('DROP TABLE security_bar_state')
    const r = await resolveLevel(env)
    expect(r.level).toBe(FAIL_CLOSED_LEVEL)
    expect(r.source).toBe('read_failed')
    expect((await policy(env, {}, 'task.intake.p1-linkage')).relaxed).toBe(false)
  })

  it('malformed stored level -> under_attack (never a silent skip to a looser level)', async () => {
    const badDb = {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ scope_kind: 'tenant', scope_id: TENANT, level: 'whatever', version: 2 }] }) }) }),
    }
    const r = await resolveLevel({ TENANT_SLUG: TENANT, DB: badDb } as unknown as Env)
    expect(r.level).toBe('under_attack')
    expect(r.source).toBe('malformed')
    const garbage = { prepare: () => ({ bind: () => ({ all: async () => ({ results: 'not-an-array' }) }) }) }
    expect((await resolveLevel({ TENANT_SLUG: TENANT, DB: garbage } as unknown as Env)).level).toBe('under_attack')
  })

  it('scope-aware: the nearest scope wins but is never LOOSER than the tenant', async () => {
    setLevel('operating')
    setLevel('under_attack', 'squad', SQ1)
    expect((await resolveLevel(env, { squad: SQ1 })).level).toBe('under_attack') // nearer may tighten
    expect((await resolveLevel(env, { squad: SQ2 })).level).toBe('operating') // other squad unaffected
    setLevel('under_attack')
    setLevel('onboarding', 'agent', AG_A)
    expect((await resolveLevel(env, { agent: AG_A, squad: SQ1 })).level).toBe('under_attack') // nearer cannot loosen
    setLevel('onboarding')
    setLevel('operating', 'project', 'p1')
    setLevel('under_attack', 'agent', AG_A)
    expect((await resolveLevel(env, { agent: AG_A, project: 'p1' })).level).toBe('under_attack') // agent beats project
  })

  it('no module-level cache: a level change is visible to the very next call, and a PolicyReader is per-instance', async () => {
    setLevel('onboarding')
    expect((await policy(env, {}, 'task.intake.p1-linkage')).relaxed).toBe(true)
    setLevel('under_attack')
    expect((await policy(env, {}, 'task.intake.p1-linkage')).relaxed).toBe(false)
    const reader = new PolicyReader(env)
    expect((await reader.policy({}, 'task.intake.p1-linkage')).relaxed).toBe(false)
    setLevel('onboarding')
    expect((await reader.policy({}, 'task.intake.p1-linkage')).relaxed).toBe(false) // memo is request-local...
    expect((await new PolicyReader(env).policy({}, 'task.intake.p1-linkage')).relaxed).toBe(true) // ...a new request sees fresh state
  })
})

describe('would_block / relaxed_applied records', () => {
  it('only onboarding writes would_block; operating and under_attack refuse and write nothing', async () => {
    setLevel('onboarding')
    expect(await relaxes(env, 'task.intake.p1-linkage', { actor: 'member:m1', scopeRef: 'task:t1', detail: 'p1 without linkage' })).toBe(true)
    expect(events('would_block')).toHaveLength(1)
    setLevel('operating')
    expect(await relaxes(env, 'task.update.transition-matrix', { actor: 'member:m1', scopeRef: 'task:t1' })).toBe(false)
    expect(events('relaxed_applied')).toHaveLength(0)
    setLevel('under_attack')
    expect(await relaxes(env, 'task.update.transition-matrix', { actor: 'member:m1', scopeRef: 'task:t1' })).toBe(false)
    expect(events()).toHaveLength(1)
  })

  it('a record is rule id, actor, scope, time only: free text and secrets are neutralised and truncated', async () => {
    setLevel('onboarding')
    await relaxes(env, 'task.intake.p1-linkage', { actor: 'member:m1', scopeRef: 'task:t1', detail: `Bearer sk-live-SECRET "quoted" <b>${'x'.repeat(500)}` })
    const e = events('would_block')[0] as Record<string, string>
    expect(Object.keys(e).sort()).toEqual(['actor', 'detail', 'id', 'kind', 'level', 'rule_id', 'scope', 'seq', 'ts'])
    expect(e.rule_id).toBe('task.intake.p1-linkage')
    expect(e.actor).toBe('member:m1')
    expect(e.scope).toBe('task:t1')
    expect(e.detail.length).toBeLessThanOrEqual(200)
    expect(e.detail).not.toMatch(/["<>]/)
    expect(Date.parse(e.ts)).not.toBeNaN()
  })

  it('a relaxation whose record cannot be written is NOT granted (no unaudited relaxation)', async () => {
    setLevel('onboarding')
    harness.sqlite.exec('DROP TABLE policy_events')
    expect(await relaxes(env, 'task.intake.p1-linkage', { actor: 'member:m1', scopeRef: 'task:t1' })).toBe(false)
  })

  it('policy_events is append-only', () => {
    harness.sqlite.exec(`INSERT INTO policy_events (id, kind, actor, scope) VALUES ('e1', 'would_block', 'a', 's')`)
    expect(() => harness.sqlite.exec(`UPDATE policy_events SET actor = 'x'`)).toThrow(/append-only/)
    expect(() => harness.sqlite.exec(`DELETE FROM policy_events`)).toThrow(/append-only/)
  })
})

describe('changing the level', () => {
  it('only the owner can raise; agents, members and admins cannot; raising writes state, version and an audit row together', async () => {
    setLevel('onboarding')
    expect((await raiseLevel(env, humanAuth(PLAIN, []), 'operating'))).toEqual({ ok: false, error: 'owner_required' })
    expect((await raiseLevel(env, humanAuth(PLAIN, [cap(PLAIN, 'org', null, 'admin')]), 'operating'))).toEqual({ ok: false, error: 'owner_required' })
    expect((await raiseLevel(env, { ...agentAuth(), capabilities: [cap(MEM_A, 'org', null, 'owner')] } as AuthContext, 'operating'))).toEqual({ ok: false, error: 'owner_required' })
    const out = await raiseLevel(env, owner1(), 'under_attack')
    expect(out).toMatchObject({ ok: true, level: 'under_attack', version: 2 })
    expect(one('SELECT level, version, updated_by FROM security_bar_state')).toEqual({ level: 'under_attack', version: 2, updated_by: `member:${OWNER1}` })
    const audit = events('level_change')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ level: 'under_attack', actor: `member:${OWNER1}`, scope: TENANT })
    expect(await raiseLevel(env, owner1(), 'onboarding')).toEqual({ ok: false, error: 'not_a_raise' })
  })

  it('the first write creates the tenant row (missing -> raise) at version 1', async () => {
    expect(await raiseLevel(env, owner1(), 'under_attack')).toMatchObject({ ok: true, version: 1 })
    expect(events('level_change')).toHaveLength(1)
  })

  it('lowering without a web session or without a FRESH re-auth is refused and audited; the level does not move', async () => {
    setLevel('under_attack')
    expect(await requestLower(env, owner1(), 'operating')).toEqual({ ok: false, error: 'reauth_required' })
    const stale = await webSession(OWNER1, 6 * 60 * 1000) // older than the bar's own 5-minute window
    expect(await requestLower(env, owner1(stale), 'operating')).toEqual({ ok: false, error: 'reauth_required' })
    const never = await webSession(OWNER1, null)
    expect(await requestLower(env, owner1(never), 'operating')).toEqual({ ok: false, error: 'reauth_required' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
    expect(events('lower_refused').length).toBe(3)
    expect(rows('SELECT * FROM security_bar_lower_requests')).toHaveLength(0)
  })

  it('a non-owner with a fresh session cannot lower', async () => {
    setLevel('under_attack')
    const s = await webSession(PLAIN, 1000)
    expect(await requestLower(env, humanAuth(PLAIN, [cap(PLAIN, 'org', null, 'admin')], s), 'operating')).toEqual({ ok: false, error: 'owner_required' })
  })

  it('lowering with ANOTHER owner present: request needs the second owner to confirm; the requester alone cannot', async () => {
    harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c2', '${OWNER2}', 'org', NULL, 'owner')`)
    setLevel('under_attack')
    const s1 = await webSession(OWNER1, 1000)
    const now = Date.now() + 10
    const req = await requestLower(env, owner1(s1), 'operating', now)
    expect(req).toMatchObject({ ok: true, applied: false, pending: { needs_second_owner: true, target_level: 'operating' } })
    expect((await resolveLevel(env)).level).toBe('under_attack') // a request is not a change
    expect(await confirmLower(env, owner1(s1), now + 1)).toEqual({ ok: false, error: 'second_owner_required' })
    const s2 = await webSession(OWNER2, 1000)
    const stale2 = await webSession(OWNER2, 10 * 60 * 1000)
    expect(await confirmLower(env, owner2(stale2), now + 1)).toEqual({ ok: false, error: 'reauth_required' })
    const done = await confirmLower(env, owner2(s2), now + 1)
    expect(done).toMatchObject({ ok: true, applied: true, level: 'operating', version: 2 })
    expect(one('SELECT status, resolved_by FROM security_bar_lower_requests')).toEqual({ status: 'applied', resolved_by: `member:${OWNER2}` })
    expect(events('lower_requested')).toHaveLength(1)
    expect(events('level_change')).toHaveLength(1)
  })

  it('lowering with a SOLE owner: a delay applies; the same owner confirms only after it, and only by an explicit call', async () => {
    setLevel('under_attack')
    const s = await webSession(OWNER1, 1000)
    const t0 = Date.now()
    const req = await requestLower(env, owner1(s), 'onboarding', t0)
    expect(req).toMatchObject({ ok: true, applied: false, pending: { needs_second_owner: false } })
    const early = await confirmLower(env, owner1(s), t0 + 60_000)
    expect(early).toMatchObject({ ok: false, error: 'delay_not_elapsed' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
    // No automatic downgrade: time passing alone changes nothing.
    expect((await resolveLevel(env)).level).toBe('under_attack')
    const sLate = await webSession(OWNER1, 1000)
    const after = await confirmLower(env, owner1({ ...sLate }), t0 + LOWER_DELAY_MS_FOR_TESTS + 1000)
    // strongReauth is evaluated at the confirm time: a session re-authed 1s before 'now'+delay is stale, so it needs a fresh one.
    expect(after).toMatchObject({ ok: false, error: 'reauth_required' })
    harness.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date(t0 + LOWER_DELAY_MS_FOR_TESTS).toISOString())
    const ok = await confirmLower(env, owner1(sLate), t0 + LOWER_DELAY_MS_FOR_TESTS + 1000)
    expect(ok).toMatchObject({ ok: true, applied: true, level: 'onboarding' })
  })

  it('raising cancels a pending lowering', async () => {
    setLevel('under_attack')
    const s = await webSession(OWNER1, 1000)
    await requestLower(env, owner1(s), 'operating')
    expect(rows('SELECT status FROM security_bar_lower_requests')).toEqual([{ status: 'pending' }])
    setLevel('operating')
    expect((await raiseLevel(env, owner1(), 'under_attack')).ok).toBe(true)
    expect(rows('SELECT status FROM security_bar_lower_requests')).toEqual([{ status: 'cancelled' }])
  })

  it('two writers racing on one version: exactly one lands (optimistic version check)', async () => {
    setLevel('onboarding')
    const [a, b] = await Promise.all([raiseLevel(env, owner1(), 'operating'), raiseLevel(env, owner1(), 'under_attack')])
    const landed = [a, b].filter((x) => x.ok).length
    expect(landed).toBeGreaterThanOrEqual(1)
    expect(one('SELECT version FROM security_bar_state').version).toBe(landed + 1)
    expect(events('level_change')).toHaveLength(landed)
  })
})

describe('Round 2 owner and write interleavings', () => {
  const grantSecond = (at: string) => harness.sqlite.prepare(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES ('c2', ?, 'org', NULL, 'owner', ?)`,
  ).run(OWNER2, at)

  for (const [label, offset, allowed] of [['before', -1000, true], ['equal', 0, false], ['after', 1000, false]] as const) {
    it(`M22: confirm-time second-owner grant ${label} the request`, async () => {
      setLevel('under_attack')
      const s1 = await webSession(OWNER1, 1000)
      const s2 = await webSession(OWNER2, 1000)
      const now = Date.now() + 10
      grantSecond(new Date(now + offset).toISOString())
      await requestLower(env, owner1(s1), 'operating', now)
      const out = await confirmLower(env, owner2(s2), now + 2000)
      if (allowed) expect(out).toMatchObject({ ok: true, applied: true })
      else {
        expect(out).toEqual({ ok: false, error: 'second_owner_required' })
        expect(one('SELECT status FROM security_bar_lower_requests').status).toBe('pending')
        expect((await resolveLevel(env)).level).toBe('under_attack')
      }
    })
  }

  for (const kind of ['archived', 'agent-bound', 'other-tenant', 'inactive'] as const) {
    it(`sole-owner delay excludes ${kind} owners at request and confirm time`, async () => {
      setLevel('under_attack')
      grantSecond('2026-01-01T00:00:00.000Z')
      if (kind === 'archived') harness.sqlite.prepare('UPDATE members SET archived_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', OWNER2)
      if (kind === 'agent-bound') harness.sqlite.prepare("INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(TENANT, AG_A, OWNER2)
      if (kind === 'other-tenant') harness.sqlite.prepare('UPDATE members SET tenant = ? WHERE id = ?').run('another', OWNER2)
      if (kind === 'inactive') harness.sqlite.prepare('UPDATE members SET status = ? WHERE id = ?').run('suspended', OWNER2)
      const s1 = await webSession(OWNER1, 1000)
      const now = Date.now()
      expect(await requestLower(env, owner1(s1), 'operating', now)).toMatchObject({ ok: true, pending: { needs_second_owner: false } })
      expect(await confirmLower(env, owner1(s1), now + 1000)).toMatchObject({ ok: false, error: 'delay_not_elapsed' })
      harness.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date(now + LOWER_DELAY_MS_FOR_TESTS).toISOString())
      expect(await confirmLower(env, owner1(s1), now + LOWER_DELAY_MS_FOR_TESTS + 1000)).toMatchObject({ ok: true, applied: true })
    })
  }

  it('M22: a new owner grant with a rounded creation timestamp still cannot confirm', async () => {
    setLevel('under_attack')
    const s1 = await webSession(OWNER1, 1000)
    const s2 = await webSession(OWNER2, 1000)
    const now = Date.now()
    await requestLower(env, owner1(s1), 'operating', now)
    // Legacy writers use second precision; the append-only grant event records when ownership began.
    grantSecond(new Date(now - 1).toISOString().slice(0, 19).replace('T', ' '))
    expect(await confirmLower(env, owner2(s2))).toEqual({ ok: false, error: 'second_owner_required' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
  })

  it('M22: promoting an older org grant after the request cannot supply the second owner', async () => {
    setLevel('under_attack')
    harness.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES ('c2', ?, 'org', NULL, 'admin', '2026-01-01T00:00:00.000Z')`).run(OWNER2)
    const s1 = await webSession(OWNER1, 1000)
    const s2 = await webSession(OWNER2, 1000)
    await requestLower(env, owner1(s1), 'operating')
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'owner' WHERE id = 'c2'`)
    expect(await confirmLower(env, owner2(s2))).toEqual({ ok: false, error: 'second_owner_required' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
  })

  it('a confirming owner must still be an active human even with cached owner capabilities', async () => {
    setLevel('under_attack')
    grantSecond('2026-01-01T00:00:00.000Z')
    const s1 = await webSession(OWNER1, 1000)
    const s2 = await webSession(OWNER2, 1000)
    const now = Date.now() + 10
    await requestLower(env, owner1(s1), 'operating', now)
    const getPending = barModule.getPendingLower
    vi.spyOn(barModule, 'getPendingLower').mockImplementationOnce(async currentEnv => {
      const pending = await getPending(currentEnv)
      harness.sqlite.prepare(`UPDATE members SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(OWNER2)
      return pending
    })
    expect(await confirmLower(env, owner2(s2), now + 1)).toEqual({ ok: false, error: 'second_owner_required' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
  })

  async function pendingForSecond() {
    setLevel('under_attack')
    grantSecond('2026-01-01T00:00:00.000Z')
    const s1 = await webSession(OWNER1, 1000)
    const s2 = await webSession(OWNER2, 1000)
    const now = Date.now() + 10
    await requestLower(env, owner1(s1), 'onboarding', now)
    return { session: s2, now: now + 1 }
  }

  it('M20: a lost confirmation version leaves the request pending and emits no change audit', async () => {
    const { session: s2, now } = await pendingForSecond()
    const batch = env.DB.batch.bind(env.DB)
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
      harness.sqlite.exec('UPDATE security_bar_state SET version = version + 1')
      return batch(statements)
    })
    expect(await confirmLower(env, owner2(s2), now)).toEqual({ ok: false, error: 'conflict' })
    expect(one('SELECT status FROM security_bar_lower_requests').status).toBe('pending')
    expect((await resolveLevel(env)).level).toBe('under_attack')
    expect(events('level_change')).toHaveLength(0)
  })

  it('M21: a lost raise version cannot cancel a pending request or attribute the winning write to itself', async () => {
    await pendingForSecond()
    setLevel('onboarding')
    const batch = env.DB.batch.bind(env.DB)
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
      harness.sqlite.exec(`UPDATE security_bar_state SET level = 'under_attack', version = version + 1, updated_by = 'other-writer'`)
      return batch(statements)
    })
    expect(await raiseLevel(env, owner1(), 'under_attack')).toEqual({ ok: false, error: 'conflict' })
    expect(one('SELECT status FROM security_bar_lower_requests').status).toBe('pending')
    expect(events('level_change')).toHaveLength(0)
  })

  it('M26: a cancelled request cannot change the level even if confirmation already read it', async () => {
    const { session: s2, now } = await pendingForSecond()
    const batch = env.DB.batch.bind(env.DB)
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
      harness.sqlite.exec(`UPDATE security_bar_lower_requests SET status = 'cancelled'`)
      return batch(statements)
    })
    expect(await confirmLower(env, owner2(s2), now)).toEqual({ ok: false, error: 'conflict' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
    expect(one('SELECT status FROM security_bar_lower_requests').status).toBe('cancelled')
    expect(events('level_change')).toHaveLength(0)
  })
})

describe('MCP security_bar tool', () => {
  it('reads the level; the owner raises; a lowering over MCP is step_up_required (and audited); agents cannot write', async () => {
    setLevel('operating')
    const read = await invokeTool(agentAuth(), env, 'security_bar', {}, ORIGIN)
    expect(read).toMatchObject({ ok: true, result: { level: 'operating' } })
    const agentWrite = await invokeTool(agentAuth(), env, 'security_bar', { set_level: 'under_attack' }, ORIGIN)
    expect(agentWrite.ok).toBe(false)
    expect((await invokeTool(humanAuth(PLAIN, []), env, 'security_bar', { set_level: 'under_attack' }, ORIGIN)).ok).toBe(false)
    expect((await resolveLevel(env)).level).toBe('operating')
    expect(await invokeTool(owner1(), env, 'security_bar', { set_level: 'under_attack' }, ORIGIN)).toMatchObject({ ok: true, result: { level: 'under_attack' } })
    const lower = await invokeTool(owner1(), env, 'security_bar', { set_level: 'onboarding' }, ORIGIN)
    expect(lower).toMatchObject({ ok: false, status: 403, error: 'step_up_required' })
    expect((await resolveLevel(env)).level).toBe('under_attack')
    expect(events('lower_refused').length).toBe(1)
    expect((await invokeTool(owner1(), env, 'security_bar', { set_level: 'bogus' }, ORIGIN)).ok).toBe(false)
  })

  it('MCP lowering refuses even with a fresh owner web session and never creates a request', async () => {
    setLevel('under_attack')
    const session = await webSession(OWNER1, 1000)
    expect(await invokeTool(owner1(session), env, 'security_bar', { set_level: 'onboarding' }, ORIGIN)).toMatchObject({ ok: false, error: 'step_up_required' })
    expect(rows('SELECT * FROM security_bar_lower_requests')).toHaveLength(0)
    expect(events('lower_requested')).toHaveLength(0)
    expect(events('lower_refused')).toHaveLength(1)
  })

  it('agent reads expose only the level while an owner lowering is pending', async () => {
    setLevel('under_attack')
    await requestLower(env, owner1(await webSession(OWNER1, 1000)), 'operating')
    const out = await invokeTool(agentAuth(), env, 'security_bar', {}, ORIGIN)
    expect(out).toMatchObject({ ok: true, result: { level: 'under_attack' } })
    if (out.ok) expect(out.result).toEqual({ level: 'under_attack' })
  })

  it('boot_context and orient carry the level for agents', async () => {
    setLevel('onboarding')
    const boot = await invokeTool(agentAuth(), env, 'boot_context', {}, ORIGIN)
    expect(boot.ok).toBe(true)
    if (boot.ok) expect((boot.result as { security_bar?: { level: string } }).security_bar?.level).toBe('onboarding')
  })
})

// ── the wired rules, each at each level ────────────────────────────────────────────────────────────────
const LEVELS: PolicyLevel[] = ['onboarding', 'operating', 'under_attack']
const EXPECTED_RELAXED: Record<string, Record<PolicyLevel, boolean>> = {
  'task.create.gate-owner-creator-is-assignee': { onboarding: true, operating: false, under_attack: false },
  'task.intake.p1-linkage': { onboarding: true, operating: false, under_attack: false },
  'task.create.assignee-agent-resolvable.inactive': { onboarding: false, operating: false, under_attack: false },
  'task.create.assignee-agent-resolvable.cross-squad': { onboarding: false, operating: false, under_attack: false },
  'task.create.assignee-member-resolvable': { onboarding: false, operating: false, under_attack: false },
  'task.update.transition-matrix': { onboarding: true, operating: false, under_attack: false },
  'task.update.artifact-shape-gate': { onboarding: true, operating: false, under_attack: false },
}
const relaxedAt = (ruleId: string) => EXPECTED_RELAXED[ruleId]!

describe('task.create.gate-owner-creator-is-assignee (task_create)', () => {
  const create = (args: Record<string, unknown>) =>
    invokeTool(agentAuth(), env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'tests pass and merged', assignee_agent_id: AG_A, ...args }, ORIGIN)

  for (const level of LEVELS) {
    it(`${level}: creator=assignee naming a lane someone else holds -> ${relaxedAt('task.create.gate-owner-creator-is-assignee')[level] ? 'allowed' : 'refused as today'}`, async () => {
      setLevel(level)
      const out = await create({ gate_owner: 'gate:athena' })
      if (relaxedAt('task.create.gate-owner-creator-is-assignee')[level]) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        expect(events().filter((e) => e.rule_id === 'task.create.gate-owner-creator-is-assignee')).toHaveLength(1)
      } else {
        expect(out).toMatchObject({ ok: false, error: 'gate_owner_creator_is_assignee' })
        expect(events()).toHaveLength(0)
      }
    })

    it(`${level}: creator=assignee naming its OWN lane is refused (floor)`, async () => {
      setLevel(level)
      harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg', 'gate:mine', 'agent', '${AG_A}', 'x', '2026-10-01T00:00:00.000Z')`)
      expect(await create({ gate_owner: 'gate:mine' })).toMatchObject({ ok: false, error: 'gate_owner_creator_is_assignee' })
      expect(await create({ gate_owner: 'gate:agent-a' })).toMatchObject({ ok: false, error: 'gate_owner_creator_is_assignee' }) // lane named after the creator
      expect(events()).toHaveLength(0)
    })
  }

  it('a creator who is NOT the assignee is unaffected at every level', async () => {
    for (const level of LEVELS) {
      setLevel(level)
      const out = await invokeTool(agentAuth(), env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'tests pass and merged', gate_owner: 'gate:athena' }, ORIGIN)
      expect(out.ok, level).toBe(true)
    }
  })
})

describe('task.intake.p1-linkage', () => {
  const p1 = () => invokeTool(agentAuth(), env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'tests pass and merged', priority: 'P1', body: 'urgent' }, ORIGIN)
  for (const level of LEVELS) {
    it(`${level}: P1 with no linkage -> ${relaxedAt('task.intake.p1-linkage')[level] ? 'allowed + would_block' : 'p1_linkage_required'}`, async () => {
      setLevel(level)
      const out = await p1()
      if (relaxedAt('task.intake.p1-linkage')[level]) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        expect(events().filter((e) => e.rule_id === 'task.intake.p1-linkage')).toHaveLength(1)
      } else {
        expect(out).toMatchObject({ ok: false })
        expect(JSON.stringify(out)).toContain('p1_linkage_required')
        expect(events()).toHaveLength(0)
      }
    })
  }
  it('other intake rules are untouched at onboarding (P0 without justification, short done_when)', async () => {
    setLevel('onboarding')
    expect((await invokeTool(agentAuth(), env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'x', priority: 'P2' }, ORIGIN)).ok).toBe(false)
    expect((await invokeTool(agentAuth(), env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'tests pass and merged', priority: 'P0', body: 'short' }, ORIGIN)).ok).toBe(false)
  })
})

describe('assignment rules', () => {
  const assign = (args: Record<string, unknown>, auth: AuthContext = agentAuth()) =>
    invokeTool(auth, env, 'task_create', { squad_id: SQ1, title: 'T', done_when: 'tests pass and merged', ...args }, ORIGIN)

  for (const level of LEVELS) {
    it(`${level}: paused agent -> ${relaxedAt('task.create.assignee-agent-resolvable.inactive')[level] ? 'allowed' : 'assignee_not_in_squad'}`, async () => {
      setLevel(level)
      const out = await assign({ assignee_agent_id: AG_OFF })
      if (relaxedAt('task.create.assignee-agent-resolvable.inactive')[level]) expect(out.ok, JSON.stringify(out)).toBe(true)
      else expect(out).toMatchObject({ ok: false, error: 'assignee_not_in_squad' })
    })

    it(`${level}: agent homed on another squad the caller can see -> ${relaxedAt('task.create.assignee-agent-resolvable.cross-squad')[level] ? 'allowed' : 'assignee_not_in_squad'}`, async () => {
      setLevel(level)
      const caller = agentAuth({ caps: [cap(MEM_A, 'squad', SQ1, 'member'), cap(MEM_A, 'squad', SQ2, 'member')] })
      const out = await assign({ assignee_agent_id: AG_B }, caller)
      if (relaxedAt('task.create.assignee-agent-resolvable.cross-squad')[level]) expect(out.ok, JSON.stringify(out)).toBe(true)
      else expect(out).toMatchObject({ ok: false, error: 'assignee_not_in_squad' })
    })

    it(`${level}: agent on a squad the caller CANNOT see is refused at every level (floor)`, async () => {
      setLevel(level)
      const out = await assign({ assignee_agent_id: AG_B }) // caller only has SQ1
      expect(out).toMatchObject({ ok: false, error: 'assignee_not_in_squad' })
      expect(events().filter((e) => e.rule_id === 'task.create.assignee-agent-resolvable.cross-squad')).toHaveLength(0)
    })

    it(`${level}: a member with no grant on the squad -> ${relaxedAt('task.create.assignee-member-resolvable')[level] ? 'allowed' : 'assignee_not_in_squad'}`, async () => {
      setLevel(level)
      const out = await assign({ assignee_member_id: PLAIN })
      if (relaxedAt('task.create.assignee-member-resolvable')[level]) expect(out.ok, JSON.stringify(out)).toBe(true)
      else expect(out).toMatchObject({ ok: false, error: 'assignee_not_in_squad' })
    })
  }

  it('floors hold at onboarding: unknown assignee, both assignee kinds at once', async () => {
    setLevel('onboarding')
    expect(await assign({ assignee_agent_id: 'nope' })).toMatchObject({ ok: false, error: 'invalid_assignee' })
    expect(await assign({ assignee_member_id: 'nope' })).toMatchObject({ ok: false, error: 'invalid_assignee' })
    expect(await assign({ assignee_agent_id: AG_A, assignee_member_id: PLAIN })).toMatchObject({ ok: false, error: 'task_single_assignee' })
  })
})

describe('task.update.transition-matrix (task_update)', () => {
  beforeEach(() => {
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status) VALUES ('t-open', '${SQ1}', 'T', 'b', 'tests pass and merged', 'open')`)
  })
  const upd = (args: Record<string, unknown>) => invokeTool(agentAuth(), env, 'task_update', { task_id: 't-open', ...args }, ORIGIN)

  for (const level of LEVELS) {
    it(`${level}: open -> blocked with a reason -> ${relaxedAt('task.update.transition-matrix')[level] ? 'allowed, audited, reason on the task' : 'invalid_transition'}`, async () => {
      setLevel(level)
      const out = await upd({ status: 'blocked', reason: 'waiting on the API key' })
      if (relaxedAt('task.update.transition-matrix')[level]) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        expect(one(`SELECT status, body FROM tasks WHERE id = 't-open'`)).toMatchObject({ status: 'blocked' })
        expect(String(one(`SELECT body FROM tasks WHERE id = 't-open'`).body)).toContain('waiting on the API key')
        const e = events().filter((x) => x.rule_id === 'task.update.transition-matrix')
        expect(e).toHaveLength(1)
        expect(JSON.stringify(e[0])).not.toContain('API key') // the reason lives on the task, never in the audit row
      } else {
        expect(out).toMatchObject({ ok: false, error: 'invalid_transition' })
        expect(one(`SELECT status FROM tasks WHERE id = 't-open'`).status).toBe('open')
      }
    })
  }

  it('relaxed levels still require a reason (and write no record for the refused move)', async () => {
    setLevel('onboarding')
    expect(await upd({ status: 'blocked' })).toMatchObject({ ok: false, error: 'transition_reason_required' })
    expect(await upd({ status: 'blocked', reason: ' ' })).toMatchObject({ ok: false, error: 'transition_reason_required' })
    expect(events()).toHaveLength(0)
  })

  it('blocked -> in_progress is legal at every level; the rest of the matrix is unchanged at onboarding (floors)', async () => {
    setLevel('onboarding')
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status) VALUES ('t-done', '${SQ1}', 'T', 'b', 'tests pass and merged', 'done'), ('t-blk', '${SQ1}', 'T', 'b', 'tests pass and merged', 'blocked')`)
    const call = (id: string, status: string) => invokeTool(agentAuth(), env, 'task_update', { task_id: id, status, reason: 'because reasons' }, ORIGIN)
    expect((await call('t-blk', 'in_progress')).ok).toBe(true)
    expect(await call('t-done', 'in_progress')).toMatchObject({ ok: false, error: 'invalid_transition' }) // done is terminal
    expect(await call('t-open', 'done')).toMatchObject({ ok: false, error: 'invalid_transition' }) // no open -> done
    expect(await call('t-open', 'review')).toMatchObject({ ok: false, error: 'invalid_transition' })
    expect(await call('t-open', 'approved')).toMatchObject({ ok: false }) // review exits only through the verdict
  })
})

describe('task.update.artifact-shape-gate (verifyTaskEvidence)', () => {
  const ctx = { actor: 'agent:a', scopeRef: 'task:t1' }
  const FILE = `Done.\nArtifact: out/report.md\nSHA256: 46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88`
  const PR = `Merged https://github.com/Mumega-com/mupot/pull/2200 at commit ${SHA40}.`
  const SNAP = 'Snapshot: board export 2026-10-26\nhttps://example.com/exports/board.json'

  it('file evidence (the strict shape) passes at every level and writes no record', async () => {
    for (const level of LEVELS) {
      setLevel(level)
      expect(await verifyTaskEvidence(env, FILE, ctx)).toMatchObject({ verified: true, kind: 'file' })
    }
    expect(events()).toHaveLength(0)
  })

  for (const level of LEVELS) {
    const relaxed = relaxedAt('task.update.artifact-shape-gate')[level]
    it(`${level}: PR url + full commit id -> ${relaxed ? 'accepted (server digest)' : 'refused'}`, async () => {
      setLevel(level)
      const out = await verifyTaskEvidence(env, PR, ctx)
      if (relaxed) {
        expect(out).toMatchObject({ verified: true, kind: 'repo' })
        if (out.verified) {
          expect(out.path).toContain(`@${SHA40}`)
          expect(out.sha256Claimed).toMatch(/^[0-9a-f]{64}$/)
        }
        expect(events().filter((e) => e.rule_id === 'task.update.artifact-shape-gate')).toHaveLength(1)
      } else {
        expect(out.verified).toBe(false)
        expect(events()).toHaveLength(0)
      }
    })

    it(`${level}: snapshot with an http(s) reference -> ${relaxed ? 'accepted' : 'refused'}`, async () => {
      setLevel(level)
      expect((await verifyTaskEvidence(env, SNAP, ctx)).verified).toBe(relaxed)
    })
  }

  it('the server digest is computed over the exact text: a one-character change moves it', async () => {
    setLevel('onboarding')
    const a = await verifyTaskEvidence(env, PR, ctx)
    const b = await verifyTaskEvidence(env, PR + ' ', ctx)
    expect(a.verified && b.verified && a.sha256Claimed !== b.sha256Claimed).toBe(true)
  })

  it('never silently defaults: prose, short sha, placeholder commit, label-only snapshot, refusal prose, empty are refused at onboarding', async () => {
    setLevel('onboarding')
    const bad = [
      'I finished the work and everything looks good.',
      `PR https://github.com/Mumega-com/mupot/pull/2200 merged at ${SHA40.slice(0, 7)}`,
      `PR https://github.com/Mumega-com/mupot/pull/2200 merged at ${'0'.repeat(40)}`,
      `PR https://github.com/Mumega-com/mupot/pull/2200 merged at ${'ab'.repeat(20)}`,
      'Snapshot: x',
      'Snapshot: board export\nColumns: 12, rows: 340, nothing pending after import.',
      'Snapshot: export\nReference: file:///tmp/board.json',
      'Snapshot: export\nReference: https://',
      `commit ${SHA40} with no repository named`,
      `https://example.com/not-a-forge/thing ${SHA40}`,
      'I cannot complete this task; I am unable to access the repository.',
      '',
      null,
    ]
    for (const b of bad) expect((await verifyTaskEvidence(env, b, ctx)).verified, String(b)).toBe(false)
    expect(events()).toHaveLength(0)
  })

  it('repo URLs retain full 40/64 character commits and refuse partial or overlong ids', async () => {
    setLevel('onboarding')
    for (const kind of ['commit', 'tree']) {
      for (const size of [40, 64]) {
        const sha = (SHA40 + '1234567890abcdef12345678').slice(0, size)
        expect(await verifyTaskEvidence(env, `https://github.com/Mumega-com/mupot/${kind}/${sha}`, ctx)).toMatchObject({ verified: true, path: `https://github.com/Mumega-com/mupot/${kind}/${sha}@${sha}` })
      }
      for (const size of [39, 41, 50, 63, 65]) {
        const sha = (SHA40 + '1234567890abcdef1234567890').slice(0, size)
        expect((await verifyTaskEvidence(env, `https://github.com/Mumega-com/mupot/${kind}/${sha}`, ctx)).verified).toBe(false)
      }
    }
  })

  it('a placeholder SHA256 stays refused even when a real PR url + commit is also present (floor)', async () => {
    setLevel('onboarding')
    const text = `Artifact: out/x.md\nSHA256: ${'0'.repeat(64)}\n${PR}`
    expect((await verifyTaskEvidence(env, text, ctx)).verified).toBe(false)
  })

  it('the git-sha-in-SHA256-label case that used to be sha256_malformed is accepted when a repo + full commit is stated', async () => {
    setLevel('onboarding')
    const text = `Artifact: https://github.com/Mumega-com/mupot/pull/2200\nSHA256: ${SHA40}`
    expect(await verifyTaskEvidence(env, text, ctx)).toMatchObject({ verified: true, kind: 'repo' })
    setLevel('under_attack')
    expect(await verifyTaskEvidence(env, text, ctx)).toMatchObject({ verified: false, reason: 'sha256_malformed' })
  })

  it('end to end: task_update to review accepts a PR+commit result at onboarding and refuses it at under_attack', async () => {
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, result)
      VALUES ('t-rev', '${SQ1}', 'T', 'b', 'tests pass and merged', 'in_progress', '${AG_B}', 'gate:athena', '${PR}')`)
    const admin = humanAuth(PLAIN, [cap(PLAIN, 'org', null, 'admin')])
    setLevel('under_attack')
    expect(await invokeTool(admin, env, 'task_update', { task_id: 't-rev', status: 'review' }, ORIGIN)).toMatchObject({ ok: false, error: 'artifact_verification_failed' })
    expect(one(`SELECT status FROM tasks WHERE id = 't-rev'`).status).toBe('in_progress')
    setLevel('onboarding')
    const ok = await invokeTool(admin, env, 'task_update', { task_id: 't-rev', status: 'review' }, ORIGIN)
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(one(`SELECT status FROM tasks WHERE id = 't-rev'`).status).toBe('review')
  })
})

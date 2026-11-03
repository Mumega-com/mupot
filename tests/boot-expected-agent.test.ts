// tests/boot-expected-agent.test.ts — mupot#2289: the real caller for whoami.onboarding_next's wrong_expected_principal.
// boot_context takes an optional `expected_agent`; the server COMPARES it to the authenticated principal (id, slug, name).
// Read-only: no row is written, no seat or agent is created, auth is unchanged.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { HARNESS_SESSION_ALLOWED_TOOLS } from '../src/members/harness-credential'
import type { AuthContext, Env } from '../src/types'

const ORIGIN = 'https://pot.test'
let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept', 'b', 'B');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-rava', 'squad-a', 'rava', 'Rava Prime', 'r', 'm', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-athena', 'squad-a', 'athena', 'Athena', 'r', 'm', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-rava2', 'squad-b', 'rava', 'Impostor', 'r', 'm', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-athena-old', 'squad-b', 'athena', 'Athena Retired', 'r', 'm', 'inactive');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-gone', 'squad-b', 'gone', 'Gone', 'r', 'm', 'inactive');
  `)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
})
afterEach(() => harness.close())

const bearer = (boundAgentId: string | null): AuthContext => ({
  userId: 'u', email: 'a@e.test', role: 'member', tenant: 'mumega', memberId: 'mem-x', channel: 'workspace', capabilities: [], boundAgentId,
}) as AuthContext

const onboarding = async (auth: AuthContext, args: Record<string, unknown>): Promise<{ case: string; next_tool?: string; next_step: string }> => {
  const out = await invokeTool(auth, env, 'boot_context', args, ORIGIN)
  const r = (out as { result?: { whoami?: { onboarding_next?: { case: string; next_tool?: string; next_step: string } } } }).result
  if (!r?.whoami?.onboarding_next) throw new Error(`no onboarding_next: ${JSON.stringify(out).slice(0, 300)}`)
  return r.whoami.onboarding_next
}

const bootResult = async (auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any -- test reads a deep response
  const out = await invokeTool(auth, env, 'boot_context', args, ORIGIN)
  return (out as { result: Record<string, any> }).result // eslint-disable-line @typescript-eslint/no-explicit-any -- same
}

describe('boot_context expected_agent', () => {
  it('exact id matches; a slug or name matches only when unique pot-wide and it is the caller', async () => {
    expect((await onboarding(bearer('agent-rava'), { expected_agent: 'agent-rava' })).case).toBe('workspace_bearer')
    expect((await onboarding(bearer('agent-athena'), { expected_agent: 'ATHENA' })).case).toBe('workspace_bearer')
    expect((await onboarding(bearer('agent-rava'), { expected_agent: 'Rava Prime' })).case).toBe('workspace_bearer')
  })

  it('a slug shared by two agents (other squad) is ambiguous for BOTH, and asks for the id', async () => {
    for (const id of ['agent-rava', 'agent-rava2']) {
      const n = await onboarding(bearer(id), { expected_agent: 'rava' })
      expect(n.case, id).toBe('wrong_expected_principal')
      expect(n.next_step).toContain('agent id')
    }
  })

  it('id match is exact (a prefix of the id is wrong); inactive agents are not name-resolvable', async () => {
    expect((await onboarding(bearer('agent-rava'), { expected_agent: 'agent' })).case).toBe('wrong_expected_principal')
    expect((await onboarding(bearer('agent-rava'), { expected_agent: 'agent-rav' })).case).toBe('wrong_expected_principal')
    expect((await onboarding(bearer('agent-athena'), { expected_agent: 'gone' })).case).toBe('wrong_expected_principal')
  })

  it('a different expectation is wrong: owner step, no tool, echo clean', async () => {
    const n = await onboarding(bearer('agent-athena'), { expected_agent: 'rava\u2028x\u202e' })
    expect(n.case).toBe('wrong_expected_principal')
    expect(n.next_tool).toBeUndefined()
    expect(n.next_step).toContain('ravax')
    expect(n.next_step).not.toMatch(/[\u2028\u202e]/)
  })

  it('every next-step field agrees on a mismatch: onboarding_next, next_step, onboarding.next_step, available_doors[0]', async () => {
    const r = await bootResult(bearer('agent-athena'), { expected_agent: 'agent-rava' })
    const step: string = r.whoami.onboarding_next.next_step
    expect(r.whoami.onboarding_next.case).toBe('wrong_expected_principal')
    expect(step).toContain('Do not act')
    expect(r.next_step).toBe(step)
    expect(r.onboarding.next_step).toBe(step)
    expect(r.available_doors[0].does).toBe(step)
    // and a matching caller keeps the ordinary step
    const ok = await bootResult(bearer('agent-athena'), { expected_agent: 'agent-athena' })
    expect(ok.next_step).not.toContain('Do not act')
  })

  const SEAT = { seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: 'mem-x', source: 'auto:openai_session' as const }
  const kinds: Array<[string, () => AuthContext, Record<string, unknown>]> = [
    ['workspace bearer', () => bearer('agent-athena'), {}],
    ['attached chat', () => ({ ...bearer('agent-athena'), channel: 'directory', seatBinding: { ...SEAT, attached: { attachmentId: 'a', admissionId: 'adm', agentId: 'agent-athena', seatAgentId: 'agent-athena', ceiling: 'member' } } }) as unknown as AuthContext, {}],
    ['own chat (seat)', () => ({ ...bearer('agent-athena'), channel: 'directory', seatBinding: SEAT }) as unknown as AuthContext, { SEAT_ATTACH: '1' }],
  ]
  for (const [kind, mk, flags] of kinds) {
    it(`mismatch wins on every field for a ${kind}`, async () => {
      env = { ...env, ...flags } as unknown as Env
      const r = await bootResult(mk(), { expected_agent: 'agent-rava' })
      const step: string = r.whoami.onboarding_next.next_step
      expect(r.whoami.onboarding_next.case).toBe('wrong_expected_principal')
      expect(r.next_step).toBe(step)
      expect(r.onboarding.next_step).toBe(step)
      expect(r.available_doors[0].does).toBe(step)
      expect(step).not.toMatch(/inbox/)
    })
  }

  it('an unseated harness expecting another existing agent: seat_select first (legal for a harness), attach order after; seat_select door kept', async () => {
    env = { ...env, SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' } as unknown as Env
    const auth = { ...bearer(null), channel: 'directory', harnessCredential: true } as unknown as AuthContext
    const r = await bootResult(auth, { expected_agent: 'agent-rava' })
    const n = r.whoami.onboarding_next
    expect(n).toMatchObject({ case: 'wrong_expected_principal', who_acts: 'self', next_tool: 'seat_select' })
    expect(HARNESS_SESSION_ALLOWED_TOOLS.has(n.next_tool)).toBe(true)
    expect(n.next_step.indexOf('seat_select')).toBeLessThan(n.next_step.indexOf('seat_attach'))
    expect(r.available_doors.some((d: { tool: string | null }) => d.tool === 'seat_select')).toBe(true)
    expect(r.available_doors[0].does).toBe(n.next_step)
    expect(r.whoami.missing.map((m: { code: string }) => m.code)).toEqual(['wrong_expected_principal', 'seat_required']) // seat_select entry kept
  })

  it('a directory over the row cap fails closed: a name is ambiguous (ask for the id), an id still matches', async () => {
    harness.sqlite.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2100)
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) SELECT 'bulk-' || i, 'squad-a', 'bulk' || i, 'Bulk ' || i, 'r', 'm', 'active' FROM n;
    `)
    const amb = await onboarding(bearer('agent-athena'), { expected_agent: 'athena' })
    expect(amb.case).toBe('wrong_expected_principal')
    expect(amb.next_step).toContain('agent id')
    expect((await onboarding(bearer('agent-athena'), { expected_agent: 'agent-athena' })).case).toBe('workspace_bearer')
  })

  it('an unbound caller with an expectation is wrong; no expectation (or blank) changes nothing', async () => {
    expect((await onboarding(bearer(null), { expected_agent: 'rava' })).case).toBe('wrong_expected_principal')
    expect((await onboarding(bearer('agent-rava'), {})).case).toBe('workspace_bearer')
    expect((await onboarding(bearer('agent-rava'), { expected_agent: '   ' })).case).toBe('workspace_bearer')
  })

  it('is read-only: a mismatching call writes no rows', async () => {
    const count = (): number => (harness.sqlite.prepare('SELECT (SELECT COUNT(*) FROM agents) + (SELECT COUNT(*) FROM agent_audit) AS n').get() as { n: number }).n
    const before = count()
    await onboarding(bearer('agent-rava'), { expected_agent: 'athena' })
    expect(count()).toBe(before)
  })

  it('non-string and over-64 expected_agent are refused with invalid_args (no truncation)', async () => {
    for (const v of [5, 'x'.repeat(65), 'x'.repeat(100000)]) {
      const out = await invokeTool(bearer('agent-rava'), env, 'boot_context', { expected_agent: v }, ORIGIN)
      expect((out as { error?: unknown }).error, String(v).slice(0, 5)).toBe('invalid_args')
    }
    expect((await onboarding(bearer('agent-rava'), { expected_agent: 'x'.repeat(64) })).case).toBe('wrong_expected_principal')
  })
})

// tests/boot-expected-agent.test.ts — mupot#2289: the real caller for whoami.onboarding_next's wrong_expected_principal.
// boot_context takes an optional `expected_agent`; the server COMPARES it to the authenticated principal (id, slug, name).
// Read-only: no row is written, no seat or agent is created, auth is unchanged.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const ORIGIN = 'https://pot.test'
let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  const dir = join(__dirname, '..', 'migrations')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) harness.sqlite.exec(readFileSync(join(dir, f), 'utf8'))
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

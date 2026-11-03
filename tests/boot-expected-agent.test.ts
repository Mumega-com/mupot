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
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-rava', 'squad-a', 'rava', 'Rava Prime', 'r', 'm', 'active');
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

describe('boot_context expected_agent', () => {
  it('a workspace bearer expecting its OWN slug, id or name (any case) is not the wrong principal', async () => {
    for (const e of ['rava', 'RAVA', 'agent-rava', 'Rava Prime']) {
      expect((await onboarding(bearer('agent-rava'), { expected_agent: e })).case, e).toBe('workspace_bearer')
    }
  })

  it('a different expectation is wrong_expected_principal: owner step, no tool, expectation echoed capped and clean', async () => {
    const n = await onboarding(bearer('agent-rava'), { expected_agent: 'athena' })
    expect(n.case).toBe('wrong_expected_principal')
    expect(n.next_tool).toBeUndefined()
    expect(n.next_step).toContain('athena')
    const long = await onboarding(bearer('agent-rava'), { expected_agent: `a\u0007b${'x'.repeat(200)}` })
    expect(long.next_step).not.toContain('\u0007')
    expect(long.next_step).not.toContain('x'.repeat(65))
  })

  it('an unbound caller with an expectation is wrong; no expectation (or blank) changes nothing', async () => {
    expect((await onboarding(bearer(null), { expected_agent: 'rava' })).case).toBe('wrong_expected_principal')
    expect((await onboarding(bearer('agent-rava'), {})).case).toBe('workspace_bearer')
    expect((await onboarding(bearer('agent-rava'), { expected_agent: '   ' })).case).toBe('workspace_bearer')
  })

  it('is read-only: the agents and presence-free tables are unchanged by a mismatching call', async () => {
    const count = (): number => (harness.sqlite.prepare('SELECT (SELECT COUNT(*) FROM agents) + (SELECT COUNT(*) FROM agent_audit) AS n').get() as { n: number }).n
    const before = count()
    await onboarding(bearer('agent-rava'), { expected_agent: 'athena' })
    expect(count()).toBe(before)
  })

  it('a non-string expected_agent is refused by the schema, nothing is compared', async () => {
    const out = await invokeTool(bearer('agent-rava'), env, 'boot_context', { expected_agent: 5 }, ORIGIN)
    expect((out as { error?: unknown }).error).toBe('invalid_args')
  })
})

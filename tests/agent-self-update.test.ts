// tests/agent-self-update.test.ts — mupot#1288: update_agent's SELF LANE.
//
// Before this fix, update_agent unconditionally refused every agent-bound
// caller (`operator_principal_required`), then required org/squad admin for
// everyone else — so an agent that drifted (re-harnessed onto a different
// model, re-purposed) could only be repaired by an org admin. Athena ruled
// (2026-08) that a self-row registry write is inside an agent's own
// authority: an agent-bound caller whose resolved target IS its own row may
// now patch its non-authority fields (name/role/purpose/model/
// model_fallback/skills) without admin. Authority / identity-reference
// fields (slug/owner/qnft_ref/capabilities/budget_cap_cents/budget_window)
// stay admin-gated even on the caller's own row, rejected BEFORE any write
// with the first offending field named. An agent-bound caller targeting a
// DIFFERENT agent's row is unchanged: operator_principal_required.
//
// Real SQLite, all migrations applied, tool invoked directly via .run() —
// same pattern as tests/update-squad-tool.test.ts and
// tests/agent-messages.test.ts (enter via mcp/index so the provision.ts
// circular import resolves the same way production does).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOOLS } from '../src/mcp/index'
import { createAgent } from '../src/org/service'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

const CTX = { origin: 'https://pot.test' }
const toolUpdateAgent = TOOLS.find((t) => t.name === 'update_agent')!

interface AuthOpts {
  boundAgentId?: string | null
  memberId?: string
  capabilities?: CapabilityGrant[]
}

function auth(opts: AuthOpts = {}): AuthContext {
  return {
    userId: opts.boundAgentId ? `agent:${opts.boundAgentId}` : 'operator-caller',
    email: opts.boundAgentId ? null : 'operator@example.com',
    role: 'member',
    tenant: 'test',
    memberId: opts.memberId ?? 'member-operator',
    capabilities: opts.capabilities ?? [],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

async function auditRows(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(
    'SELECT actor_id, actor_type, action, fields_changed FROM agent_audit WHERE agent_id = ? ORDER BY seq ASC',
  )
    .bind(agentId)
    .all<{ actor_id: string; actor_type: string; action: string; fields_changed: string }>()
  return results
}

describe('update_agent — self lane (mupot#1288)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let events: unknown[]
  let selfAgentId: string
  let otherAgentId: string
  const squadId = 'sq-a'

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${squadId}', 'dept-1', 'sqa', 'Squad A');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    `)
    events = []
    env = {
      DB: harness.db,
      TENANT_SLUG: 'test',
      BUS: { send: async (event: unknown) => { events.push(event) } },
    } as unknown as Env

    const self = await createAgent(env, squadId, {
      slug: 'kasra',
      name: 'Kasra',
      role: 'member',
      model: 'gpt-5.6-terra',
    })
    if (!self.ok) throw new Error(`fixture create failed: ${self.error}`)
    selfAgentId = self.value.id

    const other = await createAgent(env, squadId, {
      slug: 'athena',
      name: 'Athena',
      role: 'member',
      model: 'claude-opus',
    })
    if (!other.ok) throw new Error(`fixture create failed: ${other.error}`)
    otherAgentId = other.value.id
  })

  it('is registered', () => {
    expect(toolUpdateAgent).toBeTruthy()
  })

  it('self-patches model + purpose without admin, audited to the agent itself', async () => {
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId, memberId: 'member-agent-kasra' }),
      env,
      { agent: selfAgentId, model: 'claude-fable-5-1', purpose: 'via Claude Code CLI' },
      CTX,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as {
      agent: { model: string; purpose: string | null }
      changed: Record<string, { from: unknown; to: unknown }>
      audit_id: string
    }
    expect(output.agent.model).toBe('claude-fable-5-1')
    expect(output.agent.purpose).toBe('via Claude Code CLI')
    expect(output.changed.model).toEqual({ from: 'gpt-5.6-terra', to: 'claude-fable-5-1' })

    // Audited to the AGENT itself, not the underlying member the bearer token
    // happens to carry — the agent made this call, not an operator.
    const rows = await auditRows(env, selfAgentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(selfAgentId)
    expect(rows[0].actor_type).toBe('agent')
    expect(rows[0].action).toBe('update_agent')

    // The emitted event carries self_report:true so a consumer can tell a
    // self-correction apart from an operator-initiated one.
    expect(events).toHaveLength(1)
    const payload = (events[0] as { payload: { self_report?: boolean; kind: string } }).payload
    expect(payload.kind).toBe('agent_updated')
    expect(payload.self_report).toBe(true)
  })

  it('self-patches every self-patchable field in one call: name, role, purpose, model, model_fallback, skills', async () => {
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      {
        agent: selfAgentId,
        name: 'Kasra Prime',
        role: 'lead-builder',
        purpose: 'shared-tool surfaces',
        model: 'claude-fable-5-1',
        model_fallback: 'claude-3-7-sonnet',
        skills: ['typescript', 'd1'],
      },
      CTX,
    )
    expect(result.ok).toBe(true)
  })

  it.each([
    ['slug', 'stolen-slug'],
    ['owner', 'someone-else'],
    ['qnft_ref', 'qnft:forged'],
    ['capabilities', ['admin']],
    ['budget_cap_cents', 999999],
    ['budget_window', 'day'],
  ] as const)('self + %s is refused (403 forbidden, need=admin, field=%s), no write', async (field, value) => {
    const before = await auditRows(env, selfAgentId)
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      { agent: selfAgentId, [field]: value },
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', field })

    // Rejected BEFORE any write: no new audit row, no bus event.
    const after = await auditRows(env, selfAgentId)
    expect(after).toHaveLength(before.length)
    expect(events).toHaveLength(0)
  })

  it('names the FIRST offending field in canonical order when several forbidden fields are sent together', async () => {
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      { agent: selfAgentId, budget_cap_cents: 5000, capabilities: ['admin'], slug: 'renamed' },
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 'slug' is first in SELF_FORBIDDEN_FIELDS's canonical order, regardless
    // of the order keys arrived in the args object.
    expect(result.detail).toEqual({ need: 'admin', field: 'slug' })
  })

  it('a self-forbidden field mixed with self-patchable fields still refuses the whole call, writing nothing', async () => {
    const before = await auditRows(env, selfAgentId)
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      { agent: selfAgentId, model: 'claude-fable-5-1', capabilities: ['admin'] },
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toEqual({ need: 'admin', field: 'capabilities' })

    const after = await auditRows(env, selfAgentId)
    expect(after).toHaveLength(before.length)

    const row = await env.DB.prepare('SELECT model FROM agents WHERE id = ?')
      .bind(selfAgentId)
      .first<{ model: string }>()
    expect(row?.model).toBe('gpt-5.6-terra') // untouched
  })

  it('an agent-bound caller targeting a DIFFERENT agent still gets operator_principal_required', async () => {
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      { agent: otherAgentId, model: 'claude-fable-5-1' },
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('operator_principal_required')

    const rows = await auditRows(env, otherAgentId)
    expect(rows).toHaveLength(0)
  })

  it('an agent-bound caller targeting a different agent by SLUG still gets operator_principal_required (resolve-then-guard, not string-equality-on-ref)', async () => {
    const result = await toolUpdateAgent.run(
      auth({ boundAgentId: selfAgentId }),
      env,
      { agent: 'athena', purpose: 'reassigned' },
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('operator_principal_required')
  })

  it('the admin path is unchanged: a non-bound member with squad admin can still set every field, including the self-forbidden ones', async () => {
    const squadAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
    ]
    const result = await toolUpdateAgent.run(
      auth({ capabilities: squadAdmin }),
      env,
      { agent: selfAgentId, slug: 'kasra-renamed', capabilities: ['admin'], budget_cap_cents: 5000 },
      CTX,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as { agent: { slug: string; capabilities: string[] | null } }
    expect(output.agent.slug).toBe('kasra-renamed')

    // Audited to the human member, not the agent — this was an operator write.
    const rows = await auditRows(env, selfAgentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe('member-operator')
    expect(rows[0].actor_type).toBe('user')

    // No self_report on an operator-initiated correction.
    const payload = (events[0] as { payload: { self_report?: boolean } }).payload
    expect(payload.self_report).toBeUndefined()
  })

  it('a non-bound member WITHOUT squad admin is still refused (unchanged admin gate)', async () => {
    const result = await toolUpdateAgent.run(auth({ capabilities: [] }), env, { agent: selfAgentId, model: 'x' }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', scope: 'squad' })
  })
})

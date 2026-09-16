// tests/agent-owner-member.test.ts — mupot#1424 slice: update_agent's new
// `owner_member_id` field (agents.owner_member_id, migration 0155). This is
// the column src/im/origin-verdict.ts trusts to decide whose member identity
// an agent's harness may carry into a task_verdict (see
// tests/task-verdict-human-origin.test.ts for that consumer's own coverage).
//
// Admin-only on EVERY path, including the caller's OWN row — an agent-bound
// token setting its own owner_member_id would be a self-grant of exactly the
// authority origin-verdict.ts trusts this column for. Real SQLite, all
// migrations, tool invoked via `invokeTool` (the real dispatch seam), same
// pattern as tests/agent-self-update.test.ts.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { ADMIN_PATCHABLE_FIELDS, SELF_FORBIDDEN_FIELDS, SELF_PATCHABLE_FIELDS } from '../src/mcp/provision'
import { createAgent } from '../src/org/service'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const ORIGIN = 'https://pot.test'
const TENANT = 'test'
const squadId = 'sq-a'

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
}

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
    tenant: TENANT,
    channel: 'workspace',
    memberId: opts.memberId ?? 'member-operator',
    capabilities: opts.capabilities ?? [],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

interface UpdateAgentResult {
  agent?: { owner_member_id: string | null }
  changed?: Record<string, { from: unknown; to: unknown }>
}

describe('update_agent — owner_member_id (mupot#1424, migration 0155)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let agentId: string
  let memberId: string

  const invoke = (a: AuthContext, args: Record<string, unknown>) => invokeTool(a, env, 'update_agent', args, ORIGIN)

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
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-kayhermes', 'kh@test.com', 'KH', 'active', '${TENANT}');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
    memberId = 'member-kayhermes'

    const created = await createAgent(env, squadId, { slug: 'kayhermes', name: 'KayHermes', role: 'member', model: 'gpt-5.6-terra' })
    if (!created.ok) throw new Error(`fixture create failed: ${created.error}`)
    agentId = created.value.id
  })

  it('a new agent starts with owner_member_id NULL', async () => {
    const result = await invoke(auth({ capabilities: [{ member_id: 'op', scope_type: 'org', scope_id: null, capability: 'admin' }] }), {
      agent: agentId,
    })
    // no fields patched — invalid_args is fine, we only need the raw row read
    void result
    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
    expect(row?.owner_member_id).toBeNull()
  })

  it('org admin sets owner_member_id to a real member: ok:true, row updated, audited', async () => {
    const orgAdmin: CapabilityGrant[] = [{ member_id: 'op', scope_type: 'org', scope_id: null, capability: 'admin' }]
    const result = await invoke(auth({ capabilities: orgAdmin }), { agent: agentId, owner_member_id: memberId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as UpdateAgentResult
    expect(output.agent?.owner_member_id).toBe(memberId)
    expect(output.changed?.owner_member_id).toEqual({ from: null, to: memberId })

    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string }>()
    expect(row?.owner_member_id).toBe(memberId)
  })

  it('org admin clears owner_member_id with null', async () => {
    const orgAdmin: CapabilityGrant[] = [{ member_id: 'op', scope_type: 'org', scope_id: null, capability: 'admin' }]
    await invoke(auth({ capabilities: orgAdmin }), { agent: agentId, owner_member_id: memberId })
    const result = await invoke(auth({ capabilities: orgAdmin }), { agent: agentId, owner_member_id: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
    expect(row?.owner_member_id).toBeNull()
  })

  it('a non-existent member id is refused with owner_member_not_found, no write', async () => {
    const orgAdmin: CapabilityGrant[] = [{ member_id: 'op', scope_type: 'org', scope_id: null, capability: 'admin' }]
    const result = await invoke(auth({ capabilities: orgAdmin }), { agent: agentId, owner_member_id: 'no-such-member' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('owner_member_not_found')

    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
    expect(row?.owner_member_id).toBeNull()
  })

  // ── the load-bearing negative: no self-grant ─────────────────────────────
  it('an agent-bound caller may NOT set its own owner_member_id, even with a squad "member" grant (self lane forbids it)', async () => {
    const memberGrant: CapabilityGrant[] = [{ member_id: memberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }]
    const result = await invoke(
      auth({ boundAgentId: agentId, memberId, capabilities: memberGrant }),
      { agent: agentId, owner_member_id: memberId },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', field: 'owner_member_id' })

    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
    expect(row?.owner_member_id).toBeNull()
  })

  it('the same self-bound caller MAY still patch a genuinely self-patchable field in the SAME call rejected for owner_member_id — i.e. owner_member_id alone in the args is refused wholesale, not silently dropped', async () => {
    const memberGrant: CapabilityGrant[] = [{ member_id: memberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }]
    const result = await invoke(
      auth({ boundAgentId: agentId, memberId, capabilities: memberGrant }),
      { agent: agentId, model: 'claude-fable-5-1', owner_member_id: memberId },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    // model must NOT have been written either — the whole call refuses before any write.
    const row = await env.DB.prepare('SELECT model FROM agents WHERE id = ?').bind(agentId).first<{ model: string }>()
    expect(row?.model).toBe('gpt-5.6-terra')
  })

  it('partition invariant still holds with owner_member_id added', () => {
    const selfPatchable = new Set<string>(SELF_PATCHABLE_FIELDS)
    const selfForbidden = new Set<string>(SELF_FORBIDDEN_FIELDS)
    const admin = new Set<string>(ADMIN_PATCHABLE_FIELDS)
    expect(selfForbidden.has('owner_member_id')).toBe(true)
    expect(selfPatchable.has('owner_member_id')).toBe(false)
    const union = new Set<string>([...selfPatchable, ...selfForbidden])
    expect(union).toEqual(admin)
    expect(selfPatchable.size + selfForbidden.size).toBe(admin.size)
  })
})

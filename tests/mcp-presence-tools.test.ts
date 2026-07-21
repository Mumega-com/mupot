// tests/mcp-presence-tools.test.ts — MCP presence_* tools (Module Kernel, Port 1:
// src/mcp/presence.ts). Twin coverage to tests/registry-presence-service.test.ts, but
// at the MCP/authz boundary (invokeTool), against REAL D1/SQL via the sqlite-d1
// harness — the same pattern tests/mcp-addon-tools.test.ts and
// tests/mcp-flight-tools.test.ts use.
//
// Coverage:
//   - presence_register derives identity SERVER-SIDE (auth.boundAgentId, else
//     auth.memberId) — never from args. There is no `identity` arg on the schema at
//     all, so an attacker-supplied identity-shaped field is rejected at the schema
//     boundary before the handler runs (mirrors mcp-addon-tools.test.ts's equivalent
//     assertion).
//   - presence_heartbeat / presence_deregister act on the CALLER'S OWN identity only:
//     a second principal who never registered gets not_registered (404), because
//     there is no way for it to even name the first principal's row.
//   - presence_list is org-scoped read: a member with project-squad read access can
//     list that project's roster; a member with NO access to a project gets
//     project_not_found (no oracle); omitting project_id (or passing project_id:null)
//     requires org:admin (wider disclosure than one project's roster).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A');
    INSERT INTO projects (id, slug, name) VALUES ('proj-hidden', 'proj-hidden', 'Hidden Project');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-a', 'read');
  `)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    rows: () => harness.sqlite.prepare('SELECT * FROM module_registry ORDER BY registered_at').all() as Array<Record<string, unknown>>,
  }
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[], boundAgentId: string | null = null): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId,
  }
}

const orgAdmin = auth('admin-member', [grant('admin', 'org', null)])
const squadObserver = auth('member-a', [grant('observer', 'squad', 'squad-a')])
const grantlessMember = auth('member-grantless', [])
const weldedAgent = auth('member-welded', [grant('observer', 'squad', 'squad-a')], 'agent-welded-1')

describe('presence tools — registered in TOOLS', () => {
  it('all four presence tools are registered', () => {
    for (const name of ['presence_register', 'presence_heartbeat', 'presence_deregister', 'presence_list']) {
      expect(TOOLS.find((t) => t.name === name), `${name} should be registered`).toBeDefined()
    }
  })
})

describe('presence_register — identity is server-derived, never from args', () => {
  it('a plain member-token registers under its own memberId', async () => {
    const db = makeDb()
    const outcome = await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const result = outcome.result as { module: { identity: string; status: string } }
      expect(result.module.identity).toBe('member-a')
      expect(result.module.status).toBe('online')
    }
  })

  it('a welded agent-scoped token registers under the BOUND AGENT id, not the member id', async () => {
    const db = makeDb()
    const outcome = await invokeTool(weldedAgent, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const result = outcome.result as { module: { identity: string } }
      expect(result.module.identity).toBe('agent-welded-1')
    }
    // the member id itself never appears as a registered identity
    expect(db.rows().some((r) => r.identity === 'member-welded')).toBe(false)
  })

  it('rejects an attacker-supplied identity-shaped field before the handler runs (schema, not trust)', async () => {
    const db = makeDb()
    const outcome = await invokeTool(
      squadObserver,
      db.env,
      'presence_register',
      { adapter: 'claude_code', identity: 'someone-else', project_id: 'proj-a' },
      ORIGIN,
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(400)
      expect(outcome.error).toBe('invalid_args')
    }
    expect(db.rows()).toHaveLength(0)
  })

  it('re-registering upserts the caller\'s own row, never a duplicate', async () => {
    const db = makeDb()
    await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'cursor', project_id: 'proj-a' }, ORIGIN)
    const rows = db.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0].adapter).toBe('cursor')
  })
})

describe('presence_register / presence_heartbeat — project-write authz (P1 fix, 2026-07-21)', () => {
  it('presence_register into an inaccessible project is refused, and writes NO row', async () => {
    const db = makeDb()
    // squadObserver only has squad-a read access on proj-a — proj-hidden has no
    // project_squad_access grant for squad-a at all (same fixture presence_list's
    // "no oracle" test uses). Pre-fix, registerModule() would run unconditionally
    // and this would succeed with a 200 + a written row.
    const outcome = await invokeTool(
      squadObserver,
      db.env,
      'presence_register',
      { adapter: 'claude_code', project_id: 'proj-hidden', capabilities: ['attacker-chosen'] },
      ORIGIN,
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.error).toBe('project_not_found')
    }
    // No row written for this identity+project — the refusal is fail-closed, not
    // just a misleading response over a real write.
    expect(db.rows().some((r) => r.identity === 'member-a' && r.project_id === 'proj-hidden')).toBe(false)
    expect(db.rows()).toHaveLength(0)
  })

  it('presence_register into an accessible project still succeeds (happy path unaffected)', async () => {
    const db = makeDb()
    const outcome = await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(true)
    expect(db.rows().some((r) => r.identity === 'member-a' && r.project_id === 'proj-a')).toBe(true)
  })

  it('presence_register with project_id: null (no-project self bucket) stays open regardless of project access', async () => {
    const db = makeDb()
    const outcome = await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: null }, ORIGIN)
    expect(outcome.ok).toBe(true)
    expect(db.rows().some((r) => r.identity === 'member-a' && r.project_id === null)).toBe(true)
  })

  it('presence_heartbeat into an inaccessible project is refused (defense-in-depth)', async () => {
    const db = makeDb()
    // Register legitimately into proj-a first (accessible), then attempt to
    // heartbeat with a project_id the caller cannot read — this must not re-bind
    // the caller's registration into proj-hidden nor touch the proj-a row.
    await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)

    const outcome = await invokeTool(squadObserver, db.env, 'presence_heartbeat', { project_id: 'proj-hidden' }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.error).toBe('project_not_found')
    }
    expect(db.rows()).toHaveLength(1)
    expect(db.rows()[0].project_id).toBe('proj-a')
  })
})

describe('presence_heartbeat / presence_deregister — self-scoped only', () => {
  it('a caller can heartbeat only its OWN registration', async () => {
    const db = makeDb()
    await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)

    const ownHeartbeat = await invokeTool(squadObserver, db.env, 'presence_heartbeat', { project_id: 'proj-a' }, ORIGIN)
    expect(ownHeartbeat.ok).toBe(true)

    // A DIFFERENT principal (never registered) cannot heartbeat squadObserver's row —
    // there is no identity/target arg to point at it; it only ever acts on ITS OWN
    // identity, which has no registration yet.
    const otherPrincipal = auth('member-other', [grant('observer', 'squad', 'squad-a')])
    const otherHeartbeat = await invokeTool(otherPrincipal, db.env, 'presence_heartbeat', { project_id: 'proj-a' }, ORIGIN)
    expect(otherHeartbeat.ok).toBe(false)
    if (!otherHeartbeat.ok) expect(otherHeartbeat.status).toBe(404)

    // squadObserver's row is untouched by the other principal's failed attempt.
    expect(db.rows()).toHaveLength(1)
    expect(db.rows()[0].identity).toBe('member-a')
  })

  it('presence_heartbeat schema has no identity/target field to name another principal', () => {
    const spec = TOOLS.find((t) => t.name === 'presence_heartbeat')
    expect(spec).toBeDefined()
    expect(Object.keys(spec?.inputSchema.properties ?? {})).toEqual(['project_id'])
  })

  it('presence_deregister marks only the caller\'s own row offline', async () => {
    const db = makeDb()
    await invokeTool(squadObserver, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    await invokeTool(weldedAgent, db.env, 'presence_register', { adapter: 'cursor', project_id: 'proj-a' }, ORIGIN)

    const outcome = await invokeTool(squadObserver, db.env, 'presence_deregister', { project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(true)

    const rows = db.rows()
    const mine = rows.find((r) => r.identity === 'member-a')
    const theirs = rows.find((r) => r.identity === 'agent-welded-1')
    expect(mine?.status).toBe('offline')
    expect(theirs?.status).toBe('online') // untouched by someone else's deregister
  })
})

describe('presence_list — org-scoped read, reuses project read-access', () => {
  it('a member with squad read-access on the project can list its roster', async () => {
    const db = makeDb()
    await invokeTool(weldedAgent, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)

    const outcome = await invokeTool(squadObserver, db.env, 'presence_list', { project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const result = outcome.result as { modules: Array<{ identity: string }> }
      expect(result.modules.map((m) => m.identity)).toEqual(['agent-welded-1'])
    }
  })

  it('a member with NO access to the project gets project_not_found (no oracle)', async () => {
    const db = makeDb()
    await invokeTool(weldedAgent, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-hidden' }, ORIGIN)

    const outcome = await invokeTool(squadObserver, db.env, 'presence_list', { project_id: 'proj-hidden' }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.error).toBe('project_not_found')
    }
  })

  it('a grantless member is rejected at the central capability floor before any handler logic runs', async () => {
    const db = makeDb()
    const outcome = await invokeTool(grantlessMember, db.env, 'presence_list', { project_id: 'proj-a' }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.status).toBe(403)
  })

  it('omitting project_id (tenant-wide roster) requires org:admin', async () => {
    const db = makeDb()
    const nonAdmin = await invokeTool(squadObserver, db.env, 'presence_list', {}, ORIGIN)
    expect(nonAdmin.ok).toBe(false)
    if (!nonAdmin.ok) {
      expect(nonAdmin.status).toBe(403)
      expect(nonAdmin.error).toBe('forbidden')
    }

    await invokeTool(weldedAgent, db.env, 'presence_register', { adapter: 'claude_code', project_id: 'proj-a' }, ORIGIN)
    const admin = await invokeTool(orgAdmin, db.env, 'presence_list', {}, ORIGIN)
    expect(admin.ok).toBe(true)
    if (admin.ok) {
      const result = admin.result as { modules: Array<{ identity: string }> }
      expect(result.modules.map((m) => m.identity)).toEqual(['agent-welded-1'])
    }
  })

  it('project_id: null (unassigned modules) also requires org:admin', async () => {
    const db = makeDb()
    const nonAdmin = await invokeTool(squadObserver, db.env, 'presence_list', { project_id: null }, ORIGIN)
    expect(nonAdmin.ok).toBe(false)
    if (!nonAdmin.ok) expect(nonAdmin.status).toBe(403)

    const admin = await invokeTool(orgAdmin, db.env, 'presence_list', { project_id: null }, ORIGIN)
    expect(admin.ok).toBe(true)
  })
})

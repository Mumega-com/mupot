// tests/operator-chokepoint-ratchet.test.ts — Operators + Admission W0 (mumega-com#1386).
//
// A structural write that does not ask src/operators/chokepoint.ts is the #1357 class all over again: a second door with
// its own rule. This file makes that a red test instead of a code-review hope. Four ratchets:
//   1. every MCP structural tool in STRUCTURAL_MCP_TOOLS asks the chokepoint for ITS action (source scan), and the
//      delegable set equals the dispatcher's floor-bypass set;
//   2. every HTTP structural route carries the gate (source scan), and no guarded file still hand-rolls the old inline
//      `boundAgentId -> operator_principal_required`;
//   3. a census of the files that write the structural tables (capabilities, memberships, squads, departments,
//      project_squad_access, gate_grants) can only SHRINK — a NEW writer file fails until it is reviewed and added here;
//   4. a runtime sweep: an org-admin agent with NO delegation is refused by every delegable / refuse-lane tool, flag on.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool, DELEGATION_FLOOR_BYPASS_TOOLS } from '../src/mcp/index'
import { STRUCTURAL_ACTIONS, STRUCTURAL_MCP_TOOLS } from '../src/operators/chokepoint'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const ROOT = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Source with // line comments and block comments removed, so a prose mention can neither satisfy nor trip a scan. */
function code(rel: string): string {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(relative(ROOT, full))
  }
  return out
}

describe('ratchet 1: every MCP structural tool asks the chokepoint for its own action', () => {
  const mcpSources = readdirSync(join(ROOT, 'src/mcp'))
    .filter((n) => n.endsWith('.ts'))
    .map((n) => ({ file: `src/mcp/${n}`, text: code(`src/mcp/${n}`) }))

  it('every tool in the registry is a registered tool and names a known action', () => {
    const registered = new Set(TOOLS.map((t) => t.name))
    for (const [tool, action] of Object.entries(STRUCTURAL_MCP_TOOLS)) {
      expect(registered.has(tool), `${tool} is in STRUCTURAL_MCP_TOOLS but is not a registered tool`).toBe(true)
      expect(STRUCTURAL_ACTIONS[action], `${tool} -> unknown action ${action}`).toBeDefined()
    }
  })

  it.each(Object.entries(STRUCTURAL_MCP_TOOLS))('%s calls the chokepoint with action %s', (tool, action) => {
    const call = new RegExp(`(structuralGate|authorizeStructuralWrite)\\([^)]*'${action}'`)
    const owner = mcpSources.find((s) => s.text.includes(`name: '${tool}'`))
    expect(owner, `no source file defines tool ${tool}`).toBeDefined()
    // scope the scan to THIS tool's own block (up to the next tool's `name:`), so a sibling's call cannot vouch for it
    const text = owner?.text ?? ''
    const start = text.indexOf(`name: '${tool}'`)
    const next = text.indexOf("\n  name: '", start + 10)
    const block = text.slice(start, next === -1 ? undefined : next)
    expect(call.test(block), `${owner?.file} defines ${tool} but its block never asks the chokepoint for '${action}'`).toBe(true)
  })

  it('a NEW write-shaped tool that is not in the registry fails (the registry is the allowlist of structural tools)', () => {
    // Any registered tool whose handler source contains a structural-table write must be in the registry or in the
    // reviewed non-structural list below. Heuristic on purpose: it forces a human decision when a tool starts to write
    // org structure, instead of letting it ride in with its own inline rule.
    const reviewedNonStructural = new Set<string>([
      'unarchive_row', 'archive_row', 'project_create', 'project_update', 'pot_provision', 'pot_release',
      'team_bootstrap', 'agent_lifecycle', 'task_create', 'task_update', 'project_recommit', 'project_deploy',
      'bootstrap_self', 'connect', 'seat_select', 'addon_install', 'addon_activate', 'addon_configure', 'addon_disable',
      'addon_archive', 'addon_setup', 'create_department', 'secret_env_request',
    ])
    const writes = /(INSERT( OR [A-Z]+)? INTO|UPDATE|DELETE FROM) +(capabilities|memberships|project_squad_access|gate_grants)\b/
    const offenders: string[] = []
    for (const src of mcpSources) {
      if (!writes.test(src.text)) continue
      for (const spec of TOOLS) {
        if (!src.text.includes(`name: '${spec.name}'`)) continue
        if (spec.name in STRUCTURAL_MCP_TOOLS || reviewedNonStructural.has(spec.name)) continue
        // only flag when the tool's own block contains the write
        const start = src.text.indexOf(`name: '${spec.name}'`)
        const next = src.text.indexOf("\n  name: '", start + 10)
        const block = src.text.slice(start, next === -1 ? undefined : next)
        if (writes.test(block)) offenders.push(`${src.file}:${spec.name}`)
      }
    }
    expect(offenders, 'a tool writes a structural table without being in STRUCTURAL_MCP_TOOLS').toEqual([])
  })

  it('the delegable MCP tools are EXACTLY the dispatcher floor-bypass set', () => {
    const delegable = Object.entries(STRUCTURAL_MCP_TOOLS)
      .filter(([, action]) => STRUCTURAL_ACTIONS[action].delegable)
      .map(([tool]) => tool)
      .sort()
    expect(delegable).toEqual([...DELEGATION_FLOOR_BYPASS_TOOLS].sort())
  })

  it('nothing delegable may be one of the never-delegable acts (admin grants, gates, tokens, humans, delegations)', () => {
    for (const forbidden of [
      'grant_gate_capability', 'revoke_gate_capability', 'mint_agent_token', 'revoke_agent_token', 'list_agent_tokens',
      'register_agent_key', 'provision_agent_connection', 'deactivate_agent', 'update_agent', 'update_squad',
      'create_department', 'mint_member_token', 'revoke_member_token', 'suspend_member', 'unbind_member_telegram',
      'create_invite', 'manage_delegations', 'team_bootstrap',
    ]) {
      const policy = STRUCTURAL_ACTIONS[forbidden as keyof typeof STRUCTURAL_ACTIONS]
      expect(policy, forbidden).toBeDefined()
      expect(policy.delegable, `${forbidden} must never be delegable`).toBe(false)
    }
  })
})

describe('ratchet 2: every HTTP structural route carries the gate', () => {
  const GATE_TOKENS = ['authorizeStructuralWrite(', 'requireAdminOrDelegated(', 'capabilityWriteGate', 'authorizeInvite', 'requireAdminOrSelfForTelegramUnbind']
  const ROUTES: Array<[string, string]> = [
    ['src/org/index.ts', "orgApp.post('/departments'"],
    ['src/org/index.ts', "orgApp.post('/departments/:id/squads'"],
    ['src/org/index.ts', "orgApp.post('/squads/:id/agents'"],
    ['src/org/index.ts', "orgApp.post('/agents/:id/memberships'"],
    ['src/members/index.ts', "membersApp.patch('/members/:id'"],
    ['src/members/index.ts', "membersApp.post('/members/:id/tokens'"],
    ['src/members/index.ts', "'/members/:id/tokens/:tid'"],
    ['src/members/index.ts', "'/members/:id/telegram'"],
    ['src/members/index.ts', "membersApp.post('/members/:id/capabilities'"],
    ['src/members/index.ts', "'/invites',\n  parseInvite"],
    ['src/projects/index.ts', "projectsApp.put('/:id/squads/:squadId'"],
    ['src/projects/index.ts', "projectsApp.delete('/:id/squads/:squadId'"],
    ['src/tasks/index.ts', "gatesApp.post('/grants'"],
    ['src/tasks/index.ts', "gatesApp.delete('/grants'"],
  ]

  it.each(ROUTES)('%s %s is gated', (file, anchor) => {
    const text = read(file)
    const at = text.indexOf(anchor)
    expect(at, `route anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
    const window = text.slice(at, at + 1400)
    expect(GATE_TOKENS.some((t) => window.includes(t)), `${file} ${anchor} has no chokepoint gate within its first lines`).toBe(true)
  })

  it('no guarded file still hand-rolls the inline bound-agent refusal', () => {
    const guarded = [
      'src/mcp/provision.ts', 'src/mcp/projects.ts', 'src/mcp/gates.ts', 'src/mcp/team-bootstrap.ts', 'src/mcp/operators.ts',
      'src/org/index.ts', 'src/members/index.ts', 'src/projects/index.ts', 'src/tasks/index.ts',
    ]
    for (const file of guarded) {
      const stripped = code(file)
      const hits = stripped.split('\n').filter((l) => l.includes('operator_principal_required'))
      // the ONE allowed literal: update_agent's non-self fallback, which sits behind its chokepoint call
      const allowed = file === 'src/mcp/provision.ts' ? 1 : 0
      expect(hits.length, `${file} hand-rolls operator_principal_required (${hits.join(' | ')})`).toBeLessThanOrEqual(allowed)
    }
  })

  it('the chokepoint is the only module that decides an agent-bound caller\'s structural standing', () => {
    // a second `boundAgentId ... return` refusal in a gated route file would be a parallel rule
    for (const file of ['src/org/index.ts', 'src/members/index.ts']) {
      const stripped = code(file)
      expect(/if \(auth\.boundAgentId\)\s*(\{\s*)?return/.test(stripped), file).toBe(false)
    }
  })
})

describe('ratchet 3: the census of files that write structural tables can only shrink', () => {
  // Reviewed 2026-10-13 at W0. These write capabilities / memberships / squads / departments / project_squad_access /
  // gate_grants. Each is a SERVICE or a human-only surface (bootstrap, onboarding doors, SSO enroll, registry activation,
  // archive); the agent-reachable doors on top of them are what the chokepoint gates. A new file here is a NEW writer:
  // review it, route its agent-reachable callers through authorizeStructuralWrite, then add it.
  const BASELINE = new Set([
    'src/addons/service.ts', 'src/auth/sso.ts', 'src/departments/registry.ts', 'src/gates/grants.ts', 'src/hygiene/archive.ts',
    'src/members/agent-access.ts', 'src/members/bootstrap-self.ts', 'src/members/index.ts', 'src/members/project-invites.ts',
    'src/members/service.ts', 'src/members/squad-seed.ts', 'src/onboarding/doors.ts', 'src/org/service.ts',
    'src/org/team-bootstrap.ts', 'src/pots/service.ts', 'src/projects/client-bootstrap.ts', 'src/projects/service.ts',
    // W0 itself: the delegation tables are not structural, but the chokepoint receipts/lookups name them
  ])
  const writes = /(INSERT( OR [A-Z]+)? INTO|UPDATE|DELETE FROM) +(capabilities|memberships|squads|departments|project_squad_access|gate_grants)\b/

  it('no source file outside the reviewed set writes a structural table', () => {
    const found = walk(join(ROOT, 'src'))
      .filter((f) => !f.endsWith('.generated.ts') && f !== 'src/mcp/tool-annotations.ts')
      .filter((f) => writes.test(code(f)))
    const unreviewed = found.filter((f) => !BASELINE.has(f))
    expect(unreviewed, 'a NEW file writes a structural table; review it and route its agent-reachable callers through the chokepoint').toEqual([])
    const stale = [...BASELINE].filter((f) => !found.includes(f))
    expect(stale, 'a baselined file no longer writes a structural table; remove it so the census only shrinks').toEqual([])
  })
})

describe('ratchet 4: the runtime sweep — an org-admin agent with NO delegation is refused by every guarded tool', () => {
  let harness: SqliteD1Harness
  let env: Env
  const TENANT = 'tenant-a'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'S1'), ('S2', 'D1', 's2-sqd', 'S2');
      INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'P');
      INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale","event_id":"e","effective_at":1}');
    `)
    for (const a of ['agent-A', 'agent-B']) {
      harness.sqlite.prepare("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, 'S1', ?, ?, 'member', 'm', 'active')").run(a, a, a)
      harness.sqlite.prepare("INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)").run(`seat-${a}`, a, TENANT)
      harness.sqlite.prepare('INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, ?)').run(TENANT, a, `seat-${a}`, '2026-10-01T00:00:00.000Z')
    }
    env = { TENANT_SLUG: TENANT, DB: harness.db, DELEGATED_OPERATORS: '1' } as unknown as Env
  })

  afterEach(() => harness.close())

  function sampleArgs(spec: { inputSchema: { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } }): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const fixed: Record<string, unknown> = {
      agent: 'agent-B', squad: 'S2', to_squad: 'S2', department: 'D1', project_id: 'P1', squad_id: 'S2', delegation_id: 'x',
      capability: 'member', access_level: 'read', principal_type: 'agent', principal_id: 'agent-B',
    }
    for (const key of spec.inputSchema.required ?? []) {
      const prop = spec.inputSchema.properties?.[key]
      if (key in fixed && !(prop?.enum && !prop.enum.includes(fixed[key]))) out[key] = fixed[key]
      else if (prop?.enum) out[key] = prop.enum[0]
      else if (prop?.type === 'number') out[key] = 1
      else if (prop?.type === 'object') out[key] = key === 'credential' ? { action: 'add' } : {}
      else out[key] = key === 'slug' ? 'zz-sqd' : key === 'capability' ? 'gate:kasra-core' : 'x'
    }
    // update_agent / list_agent_sessions do not REQUIRE `agent` (they have a self lane); aim them at ANOTHER agent so the
    // sweep exercises the non-self door, which is the one the chokepoint guards.
    if (spec.inputSchema.properties && 'agent' in spec.inputSchema.properties) out.agent = 'agent-B'
    return out
  }

  const adminAgent = (): AuthContext => ({
    userId: 'seat-agent-A', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    memberId: 'seat-agent-A', boundAgentId: 'agent-A',
    capabilities: [{ member_id: 'seat-agent-A', scope_type: 'org', scope_id: null, capability: 'admin' } as CapabilityGrant],
  })

  // the tools whose refusal lane is "capability" and not delegable are intentionally NOT refused here (they keep their
  // pre-W0 lane): create_department and deactivate_agent. Everything else must refuse.
  const swept = Object.entries(STRUCTURAL_MCP_TOOLS).filter(([, action]) => {
    const p = STRUCTURAL_ACTIONS[action]
    return p.delegable || p.agentLane === 'refuse'
  })

  it.each(swept)('%s refuses an org-admin agent that holds no delegation', async (tool) => {
    const spec = TOOLS.find((t) => t.name === tool)
    expect(spec).toBeDefined()
    const args = sampleArgs(spec as never)
    const out = await invokeTool(adminAgent(), env, tool, args, 'https://pot.test')
    expect(out.ok, `${tool} accepted an undelegated agent`).toBe(false)
    if (!out.ok) {
      expect(out.status, tool).toBe(403)
      expect(['operator_principal_required', 'forbidden'], `${tool} -> ${out.error}`).toContain(out.error)
    }
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM memberships WHERE squad_id = ?').get('S2')).toEqual({ n: 0 })
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM gate_grants').get()).toEqual({ n: 0 })
  })
})

// mupot — org model component. The org chart of the pot: departments → squads →
// agents, plus the membership (RBAC) edges between agents and squads.
//
// orgApp — HTTP surface mounted at ROUTES.org ('/api/org'):
//   GET  /departments                 list departments
//   POST /departments                 create a department            (admin+)
//   GET  /departments/:id/squads      list squads in a department
//   POST /departments/:id/squads      create a squad                 (admin+)
//   GET  /squads/:id/agents           list agents in a squad
//   POST /squads/:id/agents           create an agent (row only; DO is lazy) (admin+)
//   POST /agents/:id/memberships      attach an agent to a squad w/ capability (admin+)
//   GET  /tree                        the full org chart as nested JSON
//
// Tenant isolation: this Worker's D1 (env.DB) IS the tenant's pot — there is one
// database per tenant, so the org tables carry no tenant column. We still HARD
// GUARD that the caller's AuthContext.tenant matches env.TENANT_SLUG so a token
// minted for another tenant can never read or mutate this pot.

import { Hono } from 'hono'
import type {
  Env,
  AuthContext,
  Department,
  Squad,
  Agent,
  Membership,
  Capability,
} from '../types'

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
// Fine-grained RBAC. Org mutations target a SPECIFIC scope: creating a department
// is org admin; creating a squad in a department is admin+ on THAT department;
// creating an agent / attaching a membership in a squad is lead+ on THAT squad.
// The scope is data-derived (URL param), so we check inline with the pure API.
import { resolveCapabilities, hasCapability } from '../auth/capability'

// ── helpers ──────────────────────────────────────────────────────────────────

// admin+ means org role 'owner' or 'admin'. Members may read but not mutate.
function isAdminPlus(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// isAdminPlus doubles as the legacy-role escape: a pure web-login owner/admin (no
// fine-grained capabilities) keeps full admin reach over the org chart — owner/admin
// org role satisfies any scoped check. Mirrors requireCapability's legacy escape.

// Resolve a squad's department for department→squad capability inheritance.
async function squadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

// Capability gate on a department scope (e.g. creating a squad → admin on the dept).
async function canOnDepartment(
  env: Env,
  auth: AuthContext,
  departmentId: string,
  min: Capability,
): Promise<boolean> {
  if (isAdminPlus(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  return hasCapability(grants, 'department', departmentId, min)
}

// Capability gate on a squad scope (e.g. creating an agent / membership → lead on
// the squad), with department→squad inheritance resolved from D1.
async function canOnSquad(
  env: Env,
  auth: AuthContext,
  squadId: string,
  min: Capability,
): Promise<boolean> {
  if (isAdminPlus(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  const deptId = await squadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, min, deptId)
}

// Hard tenant guard. The DB is per-tenant, but a stolen/misrouted token must not
// be able to touch a pot it was not minted for. Returns true when in-scope.
function inTenantScope(auth: AuthContext, env: Env): boolean {
  return auth.tenant === env.TENANT_SLUG
}

// slugs are URL-safe identifiers: lowercase alphanumeric + single hyphens,
// 1–48 chars, no leading/trailing/double hyphen.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function isValidSlug(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 48 && SLUG_RE.test(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

const CAPABILITIES: readonly Capability[] = ['owner', 'lead', 'member', 'observer']
function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v)
}

const AGENT_STATUSES = ['active', 'paused'] as const
type AgentStatus = (typeof AGENT_STATUSES)[number]
function isAgentStatus(v: unknown): v is AgentStatus {
  return typeof v === 'string' && (AGENT_STATUSES as readonly string[]).includes(v)
}

// ── app ──────────────────────────────────────────────────────────────────────

export const orgApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

orgApp.get('/health', (c) => c.json({ ok: true, component: 'org', tenant: c.env.TENANT_SLUG }))

// Every route is authenticated and scoped to this pot's tenant.
orgApp.use('*', requireAuth)
orgApp.use('*', async (c, next) => {
  const auth = c.get('auth')
  if (!inTenantScope(auth, c.env)) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

// ── departments ──────────────────────────────────────────────────────────────

orgApp.get('/departments', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, slug, name, created_at FROM departments ORDER BY created_at ASC, slug ASC',
  ).all<Department>()
  return c.json({ departments: rows.results ?? [] })
})

interface CreateDepartmentBody {
  slug?: unknown
  name?: unknown
}

orgApp.post('/departments', async (c) => {
  // Creating a department is an org-wide admin action.
  const auth = c.get('auth')
  if (!isAdminPlus(auth)) {
    if (!auth.memberId) return c.json({ error: 'forbidden', need: 'admin' }, 403)
    const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))
    if (!hasCapability(grants, 'org', null, 'admin')) {
      return c.json({ error: 'forbidden', need: 'admin' }, 403)
    }
  }

  let body: CreateDepartmentBody
  try {
    body = (await c.req.json()) as CreateDepartmentBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isValidSlug(body.slug)) return c.json({ error: 'invalid_slug' }, 400)
  if (!isNonEmptyString(body.name)) return c.json({ error: 'invalid_name' }, 400)

  const dept: Department = {
    id: crypto.randomUUID(),
    slug: body.slug,
    name: body.name.trim(),
    created_at: new Date().toISOString(),
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO departments (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(dept.id, dept.slug, dept.name, dept.created_at)
      .run()
  } catch (err) {
    // UNIQUE(slug) violation is the expected conflict here.
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }

  return c.json({ department: dept }, 201)
})

// ── squads (under a department) ──────────────────────────────────────────────

orgApp.get('/departments/:id/squads', async (c) => {
  const departmentId = c.req.param('id')
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) return c.json({ error: 'department_not_found' }, 404)

  const rows = await c.env.DB.prepare(
    'SELECT id, department_id, slug, name, charter, created_at FROM squads WHERE department_id = ? ORDER BY created_at ASC, slug ASC',
  )
    .bind(departmentId)
    .all<Squad>()
  return c.json({ squads: rows.results ?? [] })
})

interface CreateSquadBody {
  slug?: unknown
  name?: unknown
  charter?: unknown
}

orgApp.post('/departments/:id/squads', async (c) => {
  const departmentId = c.req.param('id')
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) return c.json({ error: 'department_not_found' }, 404)

  // Creating a squad in a department requires admin+ on THAT department.
  if (!(await canOnDepartment(c.env, c.get('auth'), departmentId, 'admin'))) {
    return c.json({ error: 'forbidden', need: 'admin' }, 403)
  }

  let body: CreateSquadBody
  try {
    body = (await c.req.json()) as CreateSquadBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isValidSlug(body.slug)) return c.json({ error: 'invalid_slug' }, 400)
  if (!isNonEmptyString(body.name)) return c.json({ error: 'invalid_name' }, 400)
  const charter =
    body.charter === undefined || body.charter === null
      ? null
      : typeof body.charter === 'string'
        ? body.charter
        : undefined
  if (charter === undefined) return c.json({ error: 'invalid_charter' }, 400)

  const squad: Squad = {
    id: crypto.randomUUID(),
    department_id: departmentId,
    slug: body.slug,
    name: body.name.trim(),
    charter,
    created_at: new Date().toISOString(),
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO squads (id, department_id, slug, name, charter, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(squad.id, squad.department_id, squad.slug, squad.name, squad.charter, squad.created_at)
      .run()
  } catch (err) {
    // UNIQUE(department_id, slug)
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }

  return c.json({ squad }, 201)
})

// ── agents (under a squad) ───────────────────────────────────────────────────

orgApp.get('/squads/:id/agents', async (c) => {
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) return c.json({ error: 'squad_not_found' }, 404)

  const rows = await c.env.DB.prepare(
    'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE squad_id = ? ORDER BY created_at ASC, slug ASC',
  )
    .bind(squadId)
    .all<Agent>()
  return c.json({ agents: rows.results ?? [] })
})

interface CreateAgentBody {
  slug?: unknown
  name?: unknown
  role?: unknown
  model?: unknown
  status?: unknown
}

orgApp.post('/squads/:id/agents', async (c) => {
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) return c.json({ error: 'squad_not_found' }, 404)

  // Creating an agent in a squad requires lead+ on THAT squad (dept grants inherit).
  if (!(await canOnSquad(c.env, c.get('auth'), squadId, 'lead'))) {
    return c.json({ error: 'forbidden', need: 'lead' }, 403)
  }

  let body: CreateAgentBody
  try {
    body = (await c.req.json()) as CreateAgentBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isValidSlug(body.slug)) return c.json({ error: 'invalid_slug' }, 400)
  if (!isNonEmptyString(body.name)) return c.json({ error: 'invalid_name' }, 400)

  // role/model fall back to the schema defaults when omitted.
  const role = body.role === undefined ? 'member' : body.role
  if (!isNonEmptyString(role)) return c.json({ error: 'invalid_role' }, 400)
  const model = body.model === undefined ? '@cf/meta/llama-3.3' : body.model
  if (!isNonEmptyString(model)) return c.json({ error: 'invalid_model' }, 400)
  const status: AgentStatus = body.status === undefined ? 'active' : (body.status as AgentStatus)
  if (!isAgentStatus(status)) return c.json({ error: 'invalid_status' }, 400)

  // The AgentDO is lazy — provisioned on first wake. Here we only insert the row;
  // the agent's id doubles as the DurableObject id name.
  const agent: Agent = {
    id: crypto.randomUUID(),
    squad_id: squadId,
    slug: body.slug,
    name: body.name.trim(),
    role: role.trim(),
    model: model.trim(),
    status,
    created_at: new Date().toISOString(),
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        agent.id,
        agent.squad_id,
        agent.slug,
        agent.name,
        agent.role,
        agent.model,
        agent.status,
        agent.created_at,
      )
      .run()
  } catch (err) {
    // UNIQUE(squad_id, slug)
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }

  return c.json({ agent }, 201)
})

// ── memberships (agent ↔ squad RBAC edge) ────────────────────────────────────

interface CreateMembershipBody {
  squad_id?: unknown
  capability?: unknown
}

orgApp.post('/agents/:id/memberships', async (c) => {
  const agentId = c.req.param('id')
  const agent = await getById<Agent>(c.env, 'agents', agentId)
  if (!agent) return c.json({ error: 'agent_not_found' }, 404)

  let body: CreateMembershipBody
  try {
    body = (await c.req.json()) as CreateMembershipBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isNonEmptyString(body.squad_id)) return c.json({ error: 'invalid_squad_id' }, 400)
  const squad = await getById<Squad>(c.env, 'squads', body.squad_id)
  if (!squad) return c.json({ error: 'squad_not_found' }, 404)

  // Attaching an agent to a squad (an RBAC edge into that squad) requires lead+ on
  // the TARGET squad (dept grants inherit). Gated after the target squad resolves.
  if (!(await canOnSquad(c.env, c.get('auth'), squad.id, 'lead'))) {
    return c.json({ error: 'forbidden', need: 'lead' }, 403)
  }

  const capability: Capability =
    body.capability === undefined ? 'member' : (body.capability as Capability)
  if (!isCapability(capability)) return c.json({ error: 'invalid_capability' }, 400)

  const membership: Membership = {
    id: crypto.randomUUID(),
    agent_id: agentId,
    squad_id: body.squad_id,
    capability,
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES (?, ?, ?, ?)',
    )
      .bind(membership.id, membership.agent_id, membership.squad_id, membership.capability)
      .run()
  } catch (err) {
    // UNIQUE(agent_id, squad_id) — one membership edge per (agent, squad).
    if (isUniqueViolation(err)) return c.json({ error: 'membership_exists' }, 409)
    throw err
  }

  return c.json({ membership }, 201)
})

// ── tree (full org chart) ────────────────────────────────────────────────────

interface AgentNode extends Agent {
  memberships: Membership[]
}
interface SquadNode extends Squad {
  agents: AgentNode[]
}
interface DepartmentNode extends Department {
  squads: SquadNode[]
}

orgApp.get('/tree', async (c) => {
  // Pull every table once, then assemble in-memory. The pot is small (one org),
  // so four scans beat N+1 round-trips.
  const [depts, squads, agents, memberships] = await Promise.all([
    c.env.DB.prepare('SELECT id, slug, name, created_at FROM departments').all<Department>(),
    c.env.DB.prepare(
      'SELECT id, department_id, slug, name, charter, created_at FROM squads',
    ).all<Squad>(),
    c.env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents',
    ).all<Agent>(),
    c.env.DB.prepare(
      'SELECT id, agent_id, squad_id, capability FROM memberships',
    ).all<Membership>(),
  ])

  const membershipsByAgent = new Map<string, Membership[]>()
  for (const m of memberships.results ?? []) {
    const list = membershipsByAgent.get(m.agent_id) ?? []
    list.push(m)
    membershipsByAgent.set(m.agent_id, list)
  }

  const agentsBySquad = new Map<string, AgentNode[]>()
  for (const a of agents.results ?? []) {
    const node: AgentNode = { ...a, memberships: membershipsByAgent.get(a.id) ?? [] }
    const list = agentsBySquad.get(a.squad_id) ?? []
    list.push(node)
    agentsBySquad.set(a.squad_id, list)
  }

  const squadsByDept = new Map<string, SquadNode[]>()
  for (const s of squads.results ?? []) {
    const node: SquadNode = { ...s, agents: agentsBySquad.get(s.id) ?? [] }
    const list = squadsByDept.get(s.department_id) ?? []
    list.push(node)
    squadsByDept.set(s.department_id, list)
  }

  const tree: DepartmentNode[] = (depts.results ?? []).map((d) => ({
    ...d,
    squads: squadsByDept.get(d.id) ?? [],
  }))

  return c.json({ tenant: c.env.TENANT_SLUG, departments: tree })
})

// ── d1 helpers ───────────────────────────────────────────────────────────────

// Allow-listed table names — never interpolate caller input into SQL.
type OrgTable = 'departments' | 'squads' | 'agents'

async function getById<T>(env: Env, table: OrgTable, id: string): Promise<T | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<T>()
  return row ?? null
}

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". We map those to 409 rather than 500.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

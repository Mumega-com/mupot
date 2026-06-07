// mupot — tasks component. Tasks are the unit of work in the pot. GitHub is the
// source of truth: every create/update mirrors to a GitHub issue (env.GITHUB_TOKEN
// + GITHUB_REPO) and we persist the returned issue URL on the row. If GITHUB_REPO
// is absent we degrade gracefully and keep the task local-only.
//
// tasksApp — HTTP surface mounted at ROUTES.tasks ('/api/tasks'):
//   GET  /            list tasks, filterable by ?squad_id= and ?status=
//   POST /            create a task (member+ within the pot)           -> mirrors to GH
//   PATCH /:id        update status / assignee / title / body         -> mirrors to GH
//
// Tenant isolation: env.DB IS this tenant's pot (one DB per tenant), so task rows
// carry no tenant column. We still HARD GUARD AuthContext.tenant === TENANT_SLUG so
// a token minted for another tenant can never touch this pot. Mutations are RBAC
// gated. The GitHub token is read from env only — it is never echoed or logged.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { Env, AuthContext, Task, Agent, Squad } from '../types'

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
// Fine-grained RBAC. Creating/mutating/assigning a task requires member+ on the
// task's SQUAD scope. The squad is data-derived (request body on POST, the loaded
// row on PATCH), so we check inline rather than as static route middleware.
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { createTask, emitTaskEvent, mirrorTaskUpdate, checkTransition, writeVerdict } from './service'
import type { TaskStatus } from './service'
import { createBus } from '../bus'
import type { BusEvent } from '../types'

// ── validation helpers ───────────────────────────────────────────────────────

// Gate statuses (review/approved/rejected) extend the base set. PATCH is
// constrained to a safe subset: review→approved|rejected is forbidden via PATCH
// (must go through the verdict endpoint). See PATCH handler for details.
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'review', 'approved', 'rejected'] as const

// Statuses the PATCH endpoint may set directly. The gate-transition statuses
// (approved, rejected) require the verdict endpoint.
const PATCH_ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'in_progress',
  'blocked',
  'done',
  'review',
])

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
}

function isPatchableStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && PATCH_ALLOWED_STATUSES.has(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function inTenantScope(auth: AuthContext, env: Env): boolean {
  return auth.tenant === env.TENANT_SLUG
}

// A pure web-login owner/admin (no fine-grained capabilities) keeps full reach over
// the pot's work — owner/admin org role satisfies any squad-scope member+ check.
// Mirrors the legacy-role escape in requireCapability, applied at squad scope here.
function legacyOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// Resolve a squad's department for department→squad capability inheritance.
async function squadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

// member+ gate on a specific squad. Returns true when the caller may create/mutate
// work in that squad: a web-login owner/admin, OR a member holding member+ on the
// squad (directly or via a department grant). This is the single chokepoint both
// the task-squad gate and the assignee-squad gate call.
async function canActOnSquad(
  env: Env,
  auth: AuthContext,
  squadId: string,
): Promise<boolean> {
  if (legacyOwnerAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  const deptId = await squadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, 'member', deptId)
}

// ── app ──────────────────────────────────────────────────────────────────────

export const tasksApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

tasksApp.get('/health', (c) => c.json({ ok: true, component: 'tasks', tenant: c.env.TENANT_SLUG }))

// CSRF: the dashboard /send page drives these mutations with the SameSite=Lax
// session cookie (requireAuth is cookie-only). SameSite=Lax must NOT be the single
// line of defense on a state-changing route, so add an explicit Origin/Host check
// (hono/csrf guards only unsafe methods — GET reads are unaffected). Adversarial
// finding 2026-06-06.
tasksApp.use('*', csrf())

// Every route is authenticated and hard-scoped to this pot's tenant.
tasksApp.use('*', requireAuth)
tasksApp.use('*', async (c, next) => {
  if (!inTenantScope(c.get('auth'), c.env)) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

// ── GET / — list tasks ───────────────────────────────────────────────────────

tasksApp.get('/', async (c) => {
  const squadId = c.req.query('squad_id')
  const status = c.req.query('status')

  if (status !== undefined && !isTaskStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400)
  }

  // Build the filter with bound params only — never interpolate caller input.
  const clauses: string[] = []
  const binds: string[] = []
  if (squadId !== undefined) {
    clauses.push('squad_id = ?')
    binds.push(squadId)
  }
  if (status !== undefined) {
    clauses.push('status = ?')
    binds.push(status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  const rows = await c.env.DB.prepare(
    `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       FROM tasks ${where}
       ORDER BY created_at DESC`,
  )
    .bind(...binds)
    .all<Task>()

  return c.json({ tasks: rows.results ?? [] })
})

// ── GET /:id — single task read (for the /send poller) ───────────────────────
// member+ on the task's squad. Includes result + completed_at so the dashboard
// can render the live status and the finished output.
tasksApp.get('/:id', async (c) => {
  const id = c.req.param('id')
  const task = await c.env.DB.prepare(
    `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       FROM tasks WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<Task>()
  if (!task) return c.json({ error: 'task_not_found' }, 404)

  // RBAC: reading a task requires member+ on its squad. (A token scoped to this
  // tenant but holding no grant on the squad must not read its work.)
  if (!(await canActOnSquad(c.env, c.get('auth'), task.squad_id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  return c.json({ task })
})

// ── POST / — create a task (optionally dispatch it for execution) ─────────────

interface CreateTaskBody {
  squad_id?: unknown
  title?: unknown
  body?: unknown
  status?: unknown
  assignee_agent_id?: unknown
  gate_owner?: unknown
  // when dispatch === true AND an assignee resolves, wake that agent in execute
  // mode (agent.wake carrying payload.task_id) right after the task persists.
  dispatch?: unknown
}

tasksApp.post('/', async (c) => {
  let body: CreateTaskBody
  try {
    body = (await c.req.json()) as CreateTaskBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isNonEmptyString(body.squad_id)) return c.json({ error: 'invalid_squad_id' }, 400)
  if (!isNonEmptyString(body.title)) return c.json({ error: 'invalid_title' }, 400)

  const squad = await getById<Squad>(c.env, 'squads', body.squad_id)
  if (!squad) return c.json({ error: 'squad_not_found' }, 404)

  // RBAC: creating work in a squad requires member+ on that squad. (Fixes: any
  // member tasking any squad.) The assignee is constrained to this same squad by
  // resolveAssignee below, so this one check also covers the assignment.
  if (!(await canActOnSquad(c.env, c.get('auth'), squad.id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  const taskBody =
    body.body === undefined || body.body === null
      ? ''
      : typeof body.body === 'string'
        ? body.body
        : undefined
  if (taskBody === undefined) return c.json({ error: 'invalid_body' }, 400)

  const status: TaskStatus = body.status === undefined ? 'open' : (body.status as TaskStatus)
  if (!isTaskStatus(status)) return c.json({ error: 'invalid_status' }, 400)

  // assignee, if provided, must resolve to an agent in this same squad.
  const assigneeCheck = await resolveAssignee(c.env, body.assignee_agent_id, squad.id)
  if (assigneeCheck.error) return c.json({ error: assigneeCheck.error }, 400)
  const assigneeAgentId = assigneeCheck.value

  // gate_owner: optional capability string (e.g. 'gate:outreach'). Must be a
  // non-empty string or absent/null. Validated here; stored on the task row.
  const gateOwner: string | null =
    body.gate_owner === undefined || body.gate_owner === null
      ? null
      : typeof body.gate_owner === 'string' && body.gate_owner.trim().length > 0
        ? body.gate_owner.trim()
        : undefined as never // caught below
  if (
    body.gate_owner !== undefined &&
    body.gate_owner !== null &&
    (typeof body.gate_owner !== 'string' || body.gate_owner.trim().length === 0)
  ) {
    return c.json({ error: 'invalid_gate_owner' }, 400)
  }

  const auth = c.get('auth')
  const task = await createTask(c.env, {
    squad_id: squad.id,
    title: body.title.trim(),
    body: taskBody,
    status,
    assignee_agent_id: assigneeAgentId,
    gate_owner: gateOwner,
  }, {
    actor: auth.memberId ? { kind: 'member', id: auth.memberId } : undefined,
  })

  // Dispatch: wake the assignee in execute mode. We require an assignee — there is
  // no "wake the whole squad to fight over one task". The assignee was already
  // validated to belong to THIS squad (resolveAssignee → assignee_not_in_squad), so
  // this fails closed: dispatch without a (valid, in-squad) assignee is rejected.
  let dispatched = false
  if (body.dispatch === true) {
    if (!assigneeAgentId) {
      return c.json({ error: 'dispatch_requires_assignee' }, 400)
    }
    const wake: BusEvent<{ task_id: string; by: string }> = {
      type: 'agent.wake',
      tenant: c.env.TENANT_SLUG,
      squad_id: squad.id,
      agent_id: assigneeAgentId,
      actor: auth.memberId ? { kind: 'member', id: auth.memberId } : undefined,
      payload: { task_id: task.id, by: auth.userId },
      ts: new Date().toISOString(),
    }
    await createBus(c.env).emit(wake)
    dispatched = true
  }

  return c.json({ task, dispatched }, 201)
})

// ── PATCH /:id — update status / assignee / title / body ─────────────────────

interface UpdateTaskBody {
  title?: unknown
  body?: unknown
  status?: unknown
  assignee_agent_id?: unknown
  gate_owner?: unknown
}

tasksApp.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await getById<Task>(c.env, 'tasks', id)
  if (!existing) return c.json({ error: 'task_not_found' }, 404)

  // RBAC: mutating a task (status/assignee/title/body) requires member+ on the
  // task's squad. Reassignment stays within this squad (resolveAssignee enforces
  // assignee_not_in_squad), so this single check also gates the assignment.
  if (!(await canActOnSquad(c.env, c.get('auth'), existing.squad_id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  let body: UpdateTaskBody
  try {
    body = (await c.req.json()) as UpdateTaskBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Apply only provided fields; validate each.
  const next: Task = { ...existing }

  if (body.title !== undefined) {
    if (!isNonEmptyString(body.title)) return c.json({ error: 'invalid_title' }, 400)
    next.title = body.title.trim()
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return c.json({ error: 'invalid_body' }, 400)
    next.body = body.body
  }
  if (body.status !== undefined) {
    // PATCH may only set patchable statuses; approved|rejected require the verdict endpoint.
    if (!isPatchableStatus(body.status)) return c.json({ error: 'invalid_status' }, 400)
    // Enforce the transition matrix.
    const transitionErr = checkTransition(existing.status, body.status)
    if (transitionErr) return c.json(transitionErr, 400)
    next.status = body.status
  }
  if (body.assignee_agent_id !== undefined) {
    // null explicitly unassigns.
    if (body.assignee_agent_id === null) {
      next.assignee_agent_id = null
    } else {
      const check = await resolveAssignee(c.env, body.assignee_agent_id, existing.squad_id)
      if (check.error) return c.json({ error: check.error }, 400)
      next.assignee_agent_id = check.value
    }
  }
  // gate_owner may only be set/changed while status is open or in_progress.
  // Once a task enters review/approved/rejected/done the gate is locked.
  if (body.gate_owner !== undefined) {
    const lockStatuses: ReadonlySet<TaskStatus> = new Set(['review', 'approved', 'rejected', 'done'])
    if (lockStatuses.has(existing.status)) {
      return c.json({ error: 'gate_owner_locked', status: existing.status }, 409)
    }
    if (body.gate_owner === null) {
      next.gate_owner = null
    } else if (typeof body.gate_owner === 'string' && body.gate_owner.trim().length > 0) {
      next.gate_owner = body.gate_owner.trim()
    } else {
      return c.json({ error: 'invalid_gate_owner' }, 400)
    }
  }

  next.updated_at = new Date().toISOString()

  // Mirror the update to GitHub. Non-fatal: if it has an issue URL we PATCH it; if
  // it never got mirrored (no repo earlier) we attempt a create now.
  next.github_issue_url = await mirrorTaskUpdate(c.env, next)

  await c.env.DB.prepare(
    `UPDATE tasks
        SET title = ?, body = ?, status = ?, assignee_agent_id = ?, github_issue_url = ?, gate_owner = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      next.title,
      next.body,
      next.status,
      next.assignee_agent_id,
      next.github_issue_url,
      next.gate_owner,
      next.updated_at,
      next.id,
    )
    .run()

  {
    const auth = c.get('auth')
    await emitTaskEvent(
      c.env,
      'task.updated',
      next,
      auth.memberId ? { kind: 'member', id: auth.memberId } : undefined,
    )
  }

  return c.json({ task: next })
})

// ── POST /:id/verdict — approve or reject a task in review ───────────────────
//
// RBAC: the caller must hold the task's gate_owner capability (e.g. 'gate:outreach').
// Pre-checks (in order):
//  1. Task exists (404)
//  2. Caller has squad member+ (403) — same base guard as all task mutations
//  3. Task has gate_owner set (409 no_gate) — unguarded tasks cannot be verdicted
//  4. Task is in 'review' status (409 not_in_review)
//  5. Caller holds the gate_owner capability at the squad (or department/org) scope (403)
// On success: D1 batch (insert verdict + flip status) then emit task.verdict.

interface VerdictBody {
  verdict?: unknown
  note?: unknown
}

// Check that the caller holds a SPECIFIC capability string (gate_owner) on the
// task's squad. gate_owner is a non-Capability string like 'gate:outreach'; we
// look it up in the capabilities table directly as a string column match.
// Org-level owner/admin bypass is intentional: they can always gate-override.
async function callerHoldsGateCapability(
  env: Env,
  auth: AuthContext,
  squadId: string,
  gateOwner: string,
): Promise<boolean> {
  // Org owners/admins always pass (same escape used throughout tasks).
  if (legacyOwnerAdmin(auth)) return true
  if (!auth.memberId) return false

  // Load the member's grants and check for an exact capability string match.
  // resolveCapabilities returns CapabilityGrant[] where capability is 'owner'|'admin'|…
  // gate_owner is a free string (e.g. 'gate:outreach') stored in tasks.gate_owner.
  // We need to look up the capabilities table directly for the gate string.
  // The existing Capability type covers the ladder; gate strings live as a separate
  // row type. We query the raw capabilities table for the gate string.
  const row = await env.DB.prepare(
    `SELECT 1 FROM capabilities
      WHERE member_id = ?1
        AND capability = ?2
        AND (
          scope_type = 'org'
          OR (scope_type = 'squad'      AND scope_id = ?3)
          OR (scope_type = 'department' AND scope_id = (SELECT department_id FROM squads WHERE id = ?3 LIMIT 1))
        )
      LIMIT 1`,
  )
    .bind(auth.memberId, gateOwner, squadId)
    .first<{ 1: number }>()
  return row !== null
}

tasksApp.post('/:id/verdict', async (c) => {
  const id = c.req.param('id')
  const task = await getById<import('../types').Task>(c.env, 'tasks', id)
  if (!task) return c.json({ error: 'task_not_found' }, 404)

  // Base guard: caller must have squad member+ (same as all task mutations).
  if (!(await canActOnSquad(c.env, c.get('auth'), task.squad_id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  // Pre-check: task must have a gate_owner set.
  if (!task.gate_owner) {
    return c.json({ error: 'no_gate' }, 409)
  }

  // Pre-check: task must be in 'review'.
  if (task.status !== 'review') {
    return c.json({ error: 'not_in_review', status: task.status }, 409)
  }

  let body: VerdictBody
  try {
    body = (await c.req.json()) as VerdictBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (body.verdict !== 'approved' && body.verdict !== 'rejected') {
    return c.json({ error: 'invalid_verdict', accepted: ['approved', 'rejected'] }, 400)
  }

  const note: string | null =
    body.note === undefined || body.note === null
      ? null
      : typeof body.note === 'string'
        ? body.note
        : null

  // RBAC: caller must hold the gate capability.
  const auth = c.get('auth')
  const hasGate = await callerHoldsGateCapability(c.env, auth, task.squad_id, task.gate_owner)
  if (!hasGate) {
    return c.json({ error: 'forbidden', need: task.gate_owner }, 403)
  }

  // Write verdict + flip status atomically via D1 batch.
  const decidedBy = auth.memberId ?? auth.userId
  const result = await writeVerdict(
    c.env,
    { task, verdict: body.verdict, note, decidedBy },
    auth.memberId ? { kind: 'member', id: auth.memberId } : undefined,
  )

  return c.json(result, 201)
})

// ── assignee resolution ──────────────────────────────────────────────────────

interface AssigneeResult {
  value: string | null
  error?: 'invalid_assignee' | 'assignee_not_in_squad'
}

// An assignee must be an existing agent whose squad matches the task's squad.
// undefined/null -> unassigned. Exported for unit tests of the dispatch boundary
// (dispatch requires a valid in-squad assignee; a cross-squad id is rejected).
export async function resolveAssignee(
  env: Env,
  raw: unknown,
  squadId: string,
): Promise<AssigneeResult> {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== 'string' || raw.length === 0) {
    return { value: null, error: 'invalid_assignee' }
  }
  const agent = await getById<Agent>(env, 'agents', raw)
  if (!agent) return { value: null, error: 'invalid_assignee' }
  if (agent.squad_id !== squadId) return { value: null, error: 'assignee_not_in_squad' }
  return { value: agent.id }
}

// ── d1 helpers ───────────────────────────────────────────────────────────────

// Allow-listed table names — never interpolate caller input into SQL.
type TaskTable = 'tasks' | 'squads' | 'agents'

async function getById<T>(env: Env, table: TaskTable, id: string): Promise<T | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<T>()
  return row ?? null
}

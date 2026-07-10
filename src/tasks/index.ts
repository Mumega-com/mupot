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
import { resolveCapabilities, hasCapability, hasSurfaceCap } from '../auth/capability'
import { createTask, emitTaskEvent, mirrorTaskUpdate, checkTransition, writeVerdict, VerdictRaceError, patchToDoneBypassesGate, assertCompletableDoneWhen, isDoneWhenValid } from './service'
import type { TaskStatus } from './service'
import { createBus } from '../bus'
import type { BusEvent } from '../types'
import { startTaskPipeline } from '../workflows/pipeline'

// ── validation helpers ───────────────────────────────────────────────────────
type TaskActor = NonNullable<BusEvent['actor']>

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

// K7: statuses allowed on task CREATE. Only {open, in_progress} are valid.
// Allowing approved/rejected/review/done on create would forge terminal gate
// state without a verdict receipt (no audit trail). blocked on create is
// semantically odd (blocked by what?), so we exclude it too. Document clearly
// so callers know the intentional restriction.
//
// Rationale: tasks are born open or immediately in_progress (e.g., dispatch:true).
// Any other status is a lifecycle state reachable only through proper transitions.
const CREATE_ALLOWED_STATUSES: ReadonlySet<string> = new Set(['open', 'in_progress'])

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

async function readableSquadIds(env: Env, auth: AuthContext): Promise<string[] | null> {
  if (legacyOwnerAdmin(auth)) return null
  if (!auth.memberId) return []
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  if (hasCapability(grants, 'org', null, 'member')) return null

  const squadIds = new Set<string>()
  const deptIds = new Set<string>()
  for (const grant of grants) {
    if (grant.scope_type === 'squad' && grant.scope_id && hasCapability([grant], 'squad', grant.scope_id, 'member')) {
      squadIds.add(grant.scope_id)
    }
    if (grant.scope_type === 'department' && grant.scope_id && hasCapability([grant], 'department', grant.scope_id, 'member')) {
      deptIds.add(grant.scope_id)
    }
  }

  if (deptIds.size > 0) {
    const ids = [...deptIds]
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
    const rows = await env.DB.prepare(
      `SELECT id FROM squads WHERE department_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ id: string }>()
    for (const row of rows.results ?? []) squadIds.add(row.id)
  }

  return [...squadIds]
}

export function verdictPrincipal(auth: AuthContext): { id: string; type: 'member' | 'agent'; actor?: TaskActor } {
  if (auth.boundAgentId) {
    return { id: auth.boundAgentId, type: 'agent', actor: { kind: 'agent', id: auth.boundAgentId } }
  }
  if (auth.memberId) {
    return { id: auth.memberId, type: 'member', actor: { kind: 'member', id: auth.memberId } }
  }
  return { id: auth.userId, type: 'agent', actor: auth.userId ? { kind: 'agent', id: auth.userId } : undefined }
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
  const auth = c.get('auth')

  if (status !== undefined && !isTaskStatus(status)) {
    return c.json({ error: 'invalid_status' }, 400)
  }

  // Build the filter with bound params only — never interpolate caller input.
  const clauses: string[] = []
  const binds: string[] = []
  if (squadId !== undefined) {
    if (!(await canActOnSquad(c.env, auth, squadId))) {
      return c.json({ error: 'forbidden', need: 'member' }, 403)
    }
    clauses.push('squad_id = ?')
    binds.push(squadId)
  } else {
    const readable = await readableSquadIds(c.env, auth)
    if (readable !== null) {
      if (readable.length === 0) return c.json({ tasks: [] })
      const placeholders = readable.map(() => '?').join(', ')
      clauses.push(`squad_id IN (${placeholders})`)
      binds.push(...readable)
    }
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
  // #142 capsule keystone: required — a verifiable success predicate.
  done_when?: unknown
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
  // #142: done_when is required at the REST boundary.
  if (!isNonEmptyString(body.done_when)) return c.json({ error: 'done_when_required', detail: 'done_when must be a non-empty verifiable success predicate' }, 400)

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

  // K7: restrict create-status to {open, in_progress}. approved/rejected/done/review
  // are lifecycle states reachable only via transitions — forging them on create
  // would bypass the audit trail (no verdict receipt, no transition record).
  const rawStatus = body.status === undefined ? 'open' : body.status
  if (!isTaskStatus(rawStatus) || !CREATE_ALLOWED_STATUSES.has(rawStatus as string)) {
    return c.json({ error: 'invalid_status', allowed_on_create: ['open', 'in_progress'] }, 400)
  }
  const status: TaskStatus = rawStatus

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
    done_when: (body.done_when as string).trim(),
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
  // done_when may be updated to replace a placeholder sentinel with a real predicate.
  // Must be a non-empty, non-sentinel string. Cannot be cleared (blank → error).
  done_when?: unknown
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
  // Door 5: done_when is updatable via PATCH so operators/agents can replace a
  // placeholder sentinel with a real predicate before marking the task done.
  // Allowed at any task status (even open/in_progress) — the constraint is only
  // that the VALUE must be valid (non-empty, not a sentinel).
  if (body.done_when !== undefined) {
    if (!isDoneWhenValid(body.done_when)) {
      return c.json({ error: 'invalid_done_when', detail: 'done_when must be a non-empty verifiable success predicate' }, 400)
    }
    next.done_when = (body.done_when as string).trim()
  }
  if (body.status !== undefined) {
    // PATCH may only set patchable statuses; approved|rejected require the verdict endpoint.
    if (!isPatchableStatus(body.status)) return c.json({ error: 'invalid_status' }, 400)
    // Enforce the transition matrix.
    const transitionErr = checkTransition(existing.status, body.status)
    if (transitionErr) return c.json(transitionErr, 400)
    // GATE BYPASS GUARD (adversarial P0, 2026-06-07): the gate guards the
    // verdict endpoint, but PATCH is a second write path to 'done'. A gated
    // task (gate_owner set) must NOT reach 'done' from a pre-/non-verdict
    // status via PATCH — that skips the entire gate_grants/verdict/receipt
    // apparatus. Legitimate completion of a gated task only comes AFTER the
    // verdict endpoint set it 'approved' (or 'rejected' → abandon). PATCH may
    // still drive review and rework transitions; it just can't forge 'done'.
    if (patchToDoneBypassesGate(existing.status, existing.gate_owner, body.status)) {
      return c.json(
        { error: 'gate_open', detail: 'gated task must be approved via /verdict before it can be marked done' },
        409,
      )
    }
    // Door 5 — completion gate: refuse DONE while done_when is a placeholder sentinel.
    // Presence (non-empty) was enforced at creation (Door 3). This gate closes the loop:
    // the predicate must be a real, checkable string — not one of the known sentinels
    // that call sites inject when the model or inbound channel did not supply one.
    if (body.status === 'done') {
      try {
        assertCompletableDoneWhen(existing.done_when)
      } catch (err) {
        return c.json(
          { error: 'done_when_placeholder', detail: err instanceof Error ? err.message : 'done_when is a placeholder — set a real predicate first' },
          409,
        )
      }
    }
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
        SET title = ?, body = ?, done_when = ?, status = ?, assignee_agent_id = ?, github_issue_url = ?, gate_owner = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      next.title,
      next.body,
      next.done_when,
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

// ── POST /:id/local-smoke-complete — local browser harness result injection ──
//
// This route exists only when LOCAL_TEST_AUTH=1. It lets the local Playwright
// smoke harness prove the browser flow from "send a task" through visible result
// state without calling a live model provider. Production deployments leave this
// sealed with a 404. Auth, tenant, and squad member+ gates still run first.
tasksApp.post('/:id/local-smoke-complete', async (c) => {
  if (c.env.LOCAL_TEST_AUTH !== '1') return c.json({ error: 'not_found' }, 404)
  // Second, independent gate — see src/auth/index.ts dev-login for the same reasoning:
  // a misconfigured LOCAL_TEST_AUTH=1 in prod must not let a REMOTE caller force-complete
  // a gated task; only localhost/127.0.0.1 (wrangler dev) may reach this route.
  const smokeHostname = new URL(c.req.url).hostname
  // .test is a reserved TLD (RFC 2606) — never real-world routable; it's what the
  // unit-test harness uses for synthetic in-process requests (e.g. https://pot.test/...).
  if (smokeHostname !== 'localhost' && smokeHostname !== '127.0.0.1' && !smokeHostname.endsWith('.test')) {
    return c.json({ error: 'not_found' }, 404)
  }

  const id = c.req.param('id')
  const existing = await getById<Task>(c.env, 'tasks', id)
  if (!existing) return c.json({ error: 'task_not_found' }, 404)

  if (!(await canActOnSquad(c.env, c.get('auth'), existing.squad_id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  let body: { result?: unknown }
  try {
    body = (await c.req.json()) as { result?: unknown }
  } catch {
    body = {}
  }

  const result =
    typeof body.result === 'string' && body.result.trim().length > 0
      ? body.result.trim()
      : 'Local browser smoke completed this task.'

  if (existing.status !== 'open' && existing.status !== 'in_progress') {
    return c.json({ error: 'task_not_runnable', status: existing.status }, 409)
  }

  const doneErr = checkTransition('in_progress', 'done')
  if (doneErr) return c.json(doneErr, 409)
  try {
    assertCompletableDoneWhen(existing.done_when)
  } catch (err) {
    return c.json(
      { error: 'done_when_placeholder', detail: err instanceof Error ? err.message : 'done_when is not completable' },
      409,
    )
  }

  if (existing.status === 'open') {
    const startErr = checkTransition(existing.status, 'in_progress')
    if (startErr) return c.json(startErr, 409)
    const startedAt = new Date().toISOString()
    await c.env.DB.prepare(
      `UPDATE tasks SET status = 'in_progress', updated_at = ?1 WHERE id = ?2 AND status = 'open'`,
    )
      .bind(startedAt, existing.id)
      .run()
  }

  const completedAt = new Date().toISOString()
  const update = await c.env.DB.prepare(
    `UPDATE tasks
        SET status = 'done', result = ?1, completed_at = ?2, updated_at = ?2
      WHERE id = ?3 AND status = 'in_progress'`,
  )
    .bind(result, completedAt, existing.id)
    .run()
  if ((update.meta?.changes ?? 0) === 0) {
    return c.json({ error: 'task_not_runnable' }, 409)
  }

  const task: Task = {
    ...existing,
    status: 'done',
    result,
    completed_at: completedAt,
    updated_at: completedAt,
  }
  const auth = c.get('auth')
  await emitTaskEvent(
    c.env,
    'task.updated',
    task,
    auth.memberId ? { kind: 'member', id: auth.memberId } : undefined,
  )

  return c.json({ task, local_smoke: true })
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
  // K4: explicit body flag to allow a self-verdict override.
  // Only honoured when the decider holds org owner role. Must be deliberate —
  // a caller cannot accidentally pass this; it must be an intentional opt-in.
  override_self_verdict?: unknown
}

// K3 fix: check that the caller holds a SPECIFIC gate capability (e.g. 'gate:outreach').
//
// Previously this queried the `capabilities` table, whose CHECK constraint only
// allows ('owner','admin','lead','member','observer') — making 'gate:*' strings
// un-insertable and this gate structurally inert.
//
// Fix: gate capability grants live in `gate_grants` (migration 0008). A grant row
// for (capability=<gateOwner>, principal_type='member', principal_id=<memberId>)
// authorises verdicting. The legacy owner/admin bypass is retained so pre-existing
// org owners never lose the ability to gate-override.
//
// Agent principals: if the caller is an agent token rather than a member, we check
// principal_type='agent' using auth.userId as the principal_id (agent tokens carry
// the agent id as userId).
async function callerHoldsGateCapability(
  env: Env,
  auth: AuthContext,
  _squadId: string,
  gateOwner: string,
): Promise<boolean> {
  // Org owners/admins always pass (same escape used throughout tasks).
  if (legacyOwnerAdmin(auth)) return true

  // Determine what principal id + type to check. Agent-bound tokens represent the
  // bound agent for gate grants and self-verdict, even though they also carry the
  // member envelope used for token revocation and capability resolution.
  const principal = verdictPrincipal(auth)
  const principalId = principal.id
  const principalType = principal.type

  if (!principalId) return false

  // Query gate_grants for an explicit grant.
  const row = await env.DB.prepare(
    `SELECT 1 FROM gate_grants
      WHERE capability     = ?1
        AND principal_type = ?2
        AND principal_id   = ?3
      LIMIT 1`,
  )
    .bind(gateOwner, principalType, principalId)
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

  // K4: note must be mutable so the self-verdict override can prepend an audit tag.
  let note: string | null =
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

  // Surface-cap gate (#106): approving a gate:loops task (outreach queue) requires
  // outreach:send-gated. A member token without this surface grant cannot fire a
  // GHL send even if they hold gate:loops. Reject path is not gated — rejections
  // do not send anything.
  if (task.gate_owner === 'gate:loops' && body.verdict === 'approved') {
    const hasSend = await hasSurfaceCap(c.env, auth, 'outreach:send-gated')
    if (!hasSend) {
      return c.json({ error: 'forbidden', need: 'outreach:send-gated' }, 403)
    }
  }

  // K4: self-verdict prevention.
  //
  // Policy: a principal may not approve or reject their own work.
  // "Own work" = the principal IS the task assignee. Agent-bound tokens use
  // auth.boundAgentId, not the member envelope id, so they cannot approve their
  // own assigned tasks by hiding behind member_tokens.member_id.
  //
  // Comparison logic:
  //  - agent-bound token: decider = auth.boundAgentId = agent id.
  //  - legacy agent token without member envelope: decider = auth.userId.
  //  - human member token/session: decider = auth.memberId.
  // Future: when tasks carry a created_by member_id column, also compare memberId
  // against the creator.
  //
  // Override: org owner may self-verdict by passing { override_self_verdict: true }
  // in the body. The override is logged in the verdict note for auditability.
  const principal = verdictPrincipal(auth)
  const deciderPrincipalId = principal.id
  const isSelfVerdict = deciderPrincipalId === task.assignee_agent_id
  if (isSelfVerdict) {
    const isOrgOwner = auth.role === 'owner'
    const overrideRequested = body.override_self_verdict === true
    if (!isOrgOwner || !overrideRequested) {
      return c.json({
        error: 'self_verdict',
        reason: 'decider is the task assignee; self-approval is forbidden',
        hint: overrideRequested ? 'override requires org owner role' : 'pass override_self_verdict:true as org owner to force',
      }, 409)
    }
    // Org owner explicit override: audit note is prepended to any caller-provided note.
    const overrideNote = `[self_verdict_override by org owner ${deciderPrincipalId}]`
    note = note ? `${overrideNote} ${note}` : overrideNote
  }

  // Write verdict with conditional UPDATE guard (K5 race protection).
  const decidedBy = principal.id
  try {
    const result = await writeVerdict(
      c.env,
      { task, verdict: body.verdict, note, decidedBy },
      principal.actor,
    )

    // Best-effort Workflow resume: if a pipeline instance is parked on
    // waitForEvent for this task, nudge it to re-read D1.  A dropped or
    // failed sendEvent must NEVER fail the verdict response — D1 is the
    // authoritative source of the verdict; the Workflow re-reads D1 on resume
    // regardless of the event payload.
    if (task.workflow_instance_id && c.env.TASK_WORKFLOW) {
      try {
        const inst = await c.env.TASK_WORKFLOW.get(task.workflow_instance_id)
        await inst.sendEvent({ type: 'gate-verdict', payload: { verdict: body.verdict } })
      } catch {
        // sendEvent failure is non-fatal: the Workflow instance may not be
        // parked yet (event is silently dropped by CF) or may have already
        // completed.  Either way the verdict is already in D1 — the pipeline
        // will read the correct state on any future resume.
      }
    }

    return c.json(result, 201)
  } catch (err) {
    if (err instanceof VerdictRaceError) {
      // K5: concurrent verdict won the race — task is no longer in 'review'.
      return c.json({ error: 'verdict_conflict', reason: 'task status changed concurrently; reload and retry' }, 409)
    }
    throw err // propagate unexpected errors (5xx)
  }
})

// ── POST /:id/pipeline — start a durable CF Workflows pipeline for a task ────
//
// Creates a TaskWorkflow instance wrapping runTaskExecution + optional
// waitForEvent gate pause.  OPT-IN: tasks run via the legacy direct-execute
// path (AgentDO, bus consumer, PATCH dispatch) are unaffected.
//
// RBAC: same member+ guard as all task mutations (canActOnSquad).
// Guard: only allowed when workflow_instance_id is null AND task is runnable.
// Returns { instanceId } so the caller can poll or log the pipeline state.

tasksApp.post('/:id/pipeline', async (c) => {
  const taskId = c.req.param('id')

  if (!c.env.TASK_WORKFLOW) {
    return c.json({ error: 'workflow_not_configured', detail: 'TASK_WORKFLOW binding is absent in this pot' }, 503)
  }

  const task = await getById<Task>(c.env, 'tasks', taskId)
  if (!task) return c.json({ error: 'task_not_found' }, 404)

  // RBAC: same member+ gate as all task mutations.
  if (!(await canActOnSquad(c.env, c.get('auth'), task.squad_id))) {
    return c.json({ error: 'forbidden', need: 'member' }, 403)
  }

  try {
    const { instanceId } = await startTaskPipeline(c.env, taskId, task.squad_id)
    return c.json({ instanceId }, 201)
  } catch (err) {
    if (err instanceof Error) {
      const code = (err as Error & { code?: string }).code
      if (code === 'task_not_found') return c.json({ error: 'task_not_found' }, 404)
      if (code === 'pipeline_already_started') {
        const instanceId = (err as Error & { instanceId?: string }).instanceId
        return c.json({ error: 'pipeline_already_started', instanceId }, 409)
      }
      if (code === 'task_not_runnable') {
        const status = (err as Error & { status?: string }).status
        return c.json({ error: 'task_not_runnable', status }, 409)
      }
      if (code === 'task_has_no_assignee') {
        return c.json({ error: 'task_has_no_assignee', detail: 'assign an agent before starting the pipeline' }, 409)
      }
    }
    throw err
  }
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

// ── POST /api/gates/grants — grant a gate capability to a principal (K3) ─────
// ── DELETE /api/gates/grants — revoke a gate grant ───────────────────────────
//
// Only org owner/admin may manage gate grants.
// Grant rows live in gate_grants (migration 0008); they are administrable so
// operators can delegate verdict authority without giving org-admin access.
//
// POST body: { capability: string, principal_type: 'member'|'agent', principal_id: string }
// DELETE body: same shape — revoke = hard delete (the verdict receipt IS the audit trail)

export const gatesApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

gatesApp.use('*', csrf())
gatesApp.use('*', requireAuth)
gatesApp.use('*', async (c, next) => {
  if (!inTenantScope(c.get('auth'), c.env)) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

// Only org owner/admin may touch gate grants.
function requireOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

interface GrantBody {
  capability?: unknown
  principal_type?: unknown
  principal_id?: unknown
}

gatesApp.post('/grants', async (c) => {
  const auth = c.get('auth')
  if (!requireOwnerAdmin(auth)) {
    return c.json({ error: 'forbidden', need: 'owner_or_admin' }, 403)
  }

  let body: GrantBody
  try {
    body = (await c.req.json()) as GrantBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isNonEmptyString(body.capability)) return c.json({ error: 'invalid_capability' }, 400)
  if (body.principal_type !== 'member' && body.principal_type !== 'agent') {
    return c.json({ error: 'invalid_principal_type', accepted: ['member', 'agent'] }, 400)
  }
  if (!isNonEmptyString(body.principal_id)) return c.json({ error: 'invalid_principal_id' }, 400)

  const grantedBy = auth.memberId ?? auth.userId
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  // INSERT OR IGNORE: idempotent — granting twice is not an error.
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.capability.trim(), body.principal_type, body.principal_id.trim(), grantedBy, now)
    .run()

  return c.json({
    ok: true,
    grant: {
      capability: body.capability.trim(),
      principal_type: body.principal_type,
      principal_id: body.principal_id.trim(),
      granted_by: grantedBy,
      created_at: now,
    },
  }, 201)
})

gatesApp.delete('/grants', async (c) => {
  const auth = c.get('auth')
  if (!requireOwnerAdmin(auth)) {
    return c.json({ error: 'forbidden', need: 'owner_or_admin' }, 403)
  }

  let body: GrantBody
  try {
    body = (await c.req.json()) as GrantBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isNonEmptyString(body.capability)) return c.json({ error: 'invalid_capability' }, 400)
  if (body.principal_type !== 'member' && body.principal_type !== 'agent') {
    return c.json({ error: 'invalid_principal_type', accepted: ['member', 'agent'] }, 400)
  }
  if (!isNonEmptyString(body.principal_id)) return c.json({ error: 'invalid_principal_id' }, 400)

  await c.env.DB.prepare(
    `DELETE FROM gate_grants WHERE capability = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(body.capability.trim(), body.principal_type, body.principal_id.trim())
    .run()

  return c.json({ ok: true })
})

// ── d1 helpers ───────────────────────────────────────────────────────────────

// Allow-listed table names — never interpolate caller input into SQL.
type TaskTable = 'tasks' | 'squads' | 'agents'

async function getById<T>(env: Env, table: TaskTable, id: string): Promise<T | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<T>()
  return row ?? null
}

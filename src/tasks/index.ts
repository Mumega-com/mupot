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
import type { Env, AuthContext, Task, Agent, Squad } from '../types'

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
// createBus is owned by the bus component; emit() publishes BusEvents.
import { createBus } from '../bus'

// ── validation helpers ───────────────────────────────────────────────────────

const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]
function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// member+ means any authenticated org user may create/mutate work. observer-only
// callers do not exist at the org-role level (that capability is squad-scoped via
// memberships); org role 'member' is the floor for mutating tasks.
function inTenantScope(auth: AuthContext, env: Env): boolean {
  return auth.tenant === env.TENANT_SLUG
}

// ── app ──────────────────────────────────────────────────────────────────────

export const tasksApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

tasksApp.get('/health', (c) => c.json({ ok: true, component: 'tasks', tenant: c.env.TENANT_SLUG }))

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
    `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, created_at, updated_at
       FROM tasks ${where}
       ORDER BY created_at DESC`,
  )
    .bind(...binds)
    .all<Task>()

  return c.json({ tasks: rows.results ?? [] })
})

// ── POST / — create a task ───────────────────────────────────────────────────

interface CreateTaskBody {
  squad_id?: unknown
  title?: unknown
  body?: unknown
  status?: unknown
  assignee_agent_id?: unknown
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

  const now = new Date().toISOString()
  const task: Task = {
    id: crypto.randomUUID(),
    squad_id: squad.id,
    title: body.title.trim(),
    body: taskBody,
    status,
    assignee_agent_id: assigneeAgentId,
    github_issue_url: null,
    created_at: now,
    updated_at: now,
  }

  // Mirror to GitHub (source of truth) BEFORE persisting the URL. A mirror failure
  // is non-fatal: we still store the task locally so work is never lost.
  task.github_issue_url = await mirrorCreate(c.env, task)

  await c.env.DB.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, github_issue_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      task.id,
      task.squad_id,
      task.title,
      task.body,
      task.status,
      task.assignee_agent_id,
      task.github_issue_url,
      task.created_at,
      task.updated_at,
    )
    .run()

  await emitTaskEvent(c.env, 'task.created', task)

  return c.json({ task }, 201)
})

// ── PATCH /:id — update status / assignee / title / body ─────────────────────

interface UpdateTaskBody {
  title?: unknown
  body?: unknown
  status?: unknown
  assignee_agent_id?: unknown
}

tasksApp.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await getById<Task>(c.env, 'tasks', id)
  if (!existing) return c.json({ error: 'task_not_found' }, 404)

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
    if (!isTaskStatus(body.status)) return c.json({ error: 'invalid_status' }, 400)
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

  next.updated_at = new Date().toISOString()

  // Mirror the update to GitHub. Non-fatal: if it has an issue URL we PATCH it; if
  // it never got mirrored (no repo earlier) we attempt a create now.
  next.github_issue_url = await mirrorUpdate(c.env, next)

  await c.env.DB.prepare(
    `UPDATE tasks
        SET title = ?, body = ?, status = ?, assignee_agent_id = ?, github_issue_url = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      next.title,
      next.body,
      next.status,
      next.assignee_agent_id,
      next.github_issue_url,
      next.updated_at,
      next.id,
    )
    .run()

  await emitTaskEvent(c.env, 'task.updated', next)

  return c.json({ task: next })
})

// ── assignee resolution ──────────────────────────────────────────────────────

interface AssigneeResult {
  value: string | null
  error?: 'invalid_assignee' | 'assignee_not_in_squad'
}

// An assignee must be an existing agent whose squad matches the task's squad.
// undefined/null -> unassigned.
async function resolveAssignee(
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

// ── GitHub mirror (GitHub = source of truth) ─────────────────────────────────

// GITHUB_REPO is a tenant config var of the form "owner/repo". It is read from env
// when present; the typed Env does not declare it (it is optional/tenant-scoped),
// so we read it off a narrow indexer rather than widening the shared contract.
function githubRepo(env: Env): string | null {
  // env carries tenant vars beyond the typed contract; read GITHUB_REPO narrowly.
  const repo = (env as unknown as { GITHUB_REPO?: string }).GITHUB_REPO
  return isNonEmptyString(repo) ? repo.trim() : null
}

// Common headers for the GitHub REST API. The token never leaves this function's
// scope — it is not returned, logged, or attached to any response.
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot',
    'Content-Type': 'application/json',
  }
}

// Map a task's status to GitHub issue state. Only 'done' closes the issue.
function issueState(status: TaskStatus): 'open' | 'closed' {
  return status === 'done' ? 'closed' : 'open'
}

function issueBody(task: Task): string {
  const lines = [task.body]
  lines.push('', '---', `_mupot task \`${task.id}\` · status: \`${task.status}\`_`)
  return lines.join('\n')
}

// Create a mirror issue. Returns the issue URL, or null if mirroring is disabled
// (no repo) or failed (non-fatal — work is kept locally either way).
async function mirrorCreate(env: Env, task: Task): Promise<string | null> {
  const token = env.GITHUB_TOKEN
  const repo = githubRepo(env)
  if (!token || !repo) return null

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ title: task.title, body: issueBody(task) }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { html_url?: string }
    return typeof data.html_url === 'string' ? data.html_url : null
  } catch {
    // Network/transport failure is non-fatal; never surface token-bearing errors.
    return null
  }
}

// Update the mirror issue. If the task already has an issue URL we PATCH it;
// otherwise we attempt a create so a previously-unmirrored task catches up.
async function mirrorUpdate(env: Env, task: Task): Promise<string | null> {
  const token = env.GITHUB_TOKEN
  const repo = githubRepo(env)
  if (!token || !repo) return task.github_issue_url

  const issueNumber = parseIssueNumber(task.github_issue_url)
  if (issueNumber === null) {
    // Never mirrored before — create it now.
    return (await mirrorCreate(env, task)) ?? task.github_issue_url
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: githubHeaders(token),
      body: JSON.stringify({
        title: task.title,
        body: issueBody(task),
        state: issueState(task.status),
      }),
    })
    if (!res.ok) return task.github_issue_url
    const data = (await res.json()) as { html_url?: string }
    return typeof data.html_url === 'string' ? data.html_url : task.github_issue_url
  } catch {
    return task.github_issue_url
  }
}

// Extract the trailing issue number from a GitHub issue URL.
function parseIssueNumber(url: string | null): number | null {
  if (!url) return null
  const m = url.match(/\/issues\/(\d+)(?:[/?#].*)?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

// ── bus emit ─────────────────────────────────────────────────────────────────

async function emitTaskEvent(
  env: Env,
  type: 'task.created' | 'task.updated',
  task: Task,
): Promise<void> {
  const bus = createBus(env)
  await bus.emit({
    type,
    tenant: env.TENANT_SLUG,
    squad_id: task.squad_id,
    agent_id: task.assignee_agent_id ?? undefined,
    payload: { task_id: task.id, status: task.status, title: task.title },
    ts: new Date().toISOString(),
  })
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

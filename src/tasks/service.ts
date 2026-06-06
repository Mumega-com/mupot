// mupot — shared task service.
//
// This is the single creation path for durable task rows. Every surface
// (dashboard/API, MCP, IM, channels, agents) should call createTask() instead of
// hand-writing rows. `task.created` is a post-persistence notification event.

import type { Env, Task, BusEvent } from '../types'
import { createBus } from '../bus'

type TaskStatus = Task['status']
type TaskActor = NonNullable<BusEvent['actor']>

export interface CreateTaskInput {
  squad_id: string
  title: string
  body?: string
  status?: TaskStatus
  assignee_agent_id?: string | null
}

export interface CreateTaskOptions {
  actor?: TaskActor
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// GITHUB_REPO is a tenant config var of the form "owner/repo". It is read from env
// when present; the typed Env does not declare it (it is optional/tenant-scoped).
function githubRepo(env: Env): string | null {
  const repo = (env as unknown as { GITHUB_REPO?: string }).GITHUB_REPO
  return isNonEmptyString(repo) ? repo.trim() : null
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot',
    'Content-Type': 'application/json',
  }
}

function issueState(status: TaskStatus): 'open' | 'closed' {
  return status === 'done' ? 'closed' : 'open'
}

function issueBody(task: Task): string {
  const lines = [task.body]
  lines.push('', '---', `_mupot task \`${task.id}\` · status: \`${task.status}\`_`)
  return lines.join('\n')
}

export async function mirrorTaskCreate(env: Env, task: Task): Promise<string | null> {
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
    return null
  }
}

export async function mirrorTaskUpdate(env: Env, task: Task): Promise<string | null> {
  const token = env.GITHUB_TOKEN
  const repo = githubRepo(env)
  if (!token || !repo) return task.github_issue_url

  const issueNumber = parseIssueNumber(task.github_issue_url)
  if (issueNumber === null) {
    return (await mirrorTaskCreate(env, task)) ?? task.github_issue_url
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

function parseIssueNumber(url: string | null): number | null {
  if (!url) return null
  const m = url.match(/\/issues\/(\d+)(?:[/?#].*)?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

function eventAgentId(task: Task, actor?: TaskActor): string | undefined {
  if (actor?.kind === 'agent') return actor.id
  return task.assignee_agent_id ?? undefined
}

export async function emitTaskEvent(
  env: Env,
  type: 'task.created' | 'task.updated',
  task: Task,
  actor?: TaskActor,
): Promise<void> {
  await createBus(env).emit({
    type,
    tenant: env.TENANT_SLUG,
    squad_id: task.squad_id,
    agent_id: eventAgentId(task, actor),
    actor,
    payload: { task_id: task.id, status: task.status, title: task.title },
    ts: new Date().toISOString(),
  })
}

export async function createTask(
  env: Env,
  input: CreateTaskInput,
  options: CreateTaskOptions = {},
): Promise<Task> {
  const now = new Date().toISOString()
  const task: Task = {
    id: crypto.randomUUID(),
    squad_id: input.squad_id,
    title: input.title.trim(),
    body: input.body ?? '',
    status: input.status ?? 'open',
    assignee_agent_id: input.assignee_agent_id ?? null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  }

  task.github_issue_url = await mirrorTaskCreate(env, task)

  await env.DB.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      task.id,
      task.squad_id,
      task.title,
      task.body,
      task.status,
      task.assignee_agent_id,
      task.github_issue_url,
      task.result,
      task.completed_at,
      task.created_at,
      task.updated_at,
    )
    .run()

  await emitTaskEvent(env, 'task.created', task, options.actor)
  return task
}

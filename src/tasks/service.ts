// mupot — shared task service.
//
// This is the single creation path for durable task rows. Every surface
// (dashboard/API, MCP, IM, channels, agents) should call createTask() instead of
// hand-writing rows. `task.created` is a post-persistence notification event.

import type { Env, Task, TaskVerdict, BusEvent } from '../types'
import { createBus } from '../bus'

export type TaskStatus = Task['status']
type TaskActor = NonNullable<BusEvent['actor']>

// ── Status transition matrix ────────────────────────────────────────────────
//
// Allowed transitions (enforced by assertValidTransition; invalid → 400):
//   open        → in_progress
//   in_progress → review | blocked | done
//   review      → approved | rejected   (ONLY via verdict endpoint, not PATCH)
//   approved    → done
//   rejected    → in_progress | done
//   blocked     → in_progress           (retry after unblocking)
//   done        → (terminal — no outbound transitions)
//
// The PATCH route additionally guards that review→approved|rejected never flows
// through a plain PATCH (those transitions require the verdict endpoint).
// The verdict endpoint enforces: task must be in 'review', transition goes to
// approved|rejected only.

const TRANSITIONS: Readonly<Partial<Record<TaskStatus, readonly TaskStatus[]>>> = {
  open: ['in_progress'],
  in_progress: ['review', 'blocked', 'done'],
  review: ['approved', 'rejected'],
  approved: ['done'],
  rejected: ['in_progress', 'done'],
  blocked: ['in_progress'],
  // 'done' has no outbound transitions (terminal)
}

/**
 * Validate a from→to transition. Returns an error object when invalid, or null
 * when valid. The verdict endpoint pre-checks its own preconditions before calling
 * this; this function is the single source of truth for what moves are legal.
 */
export function checkTransition(
  from: TaskStatus,
  to: TaskStatus,
): { error: 'invalid_transition'; from: TaskStatus; to: TaskStatus } | null {
  const allowed = TRANSITIONS[from]
  if (!allowed || !(allowed as readonly string[]).includes(to)) {
    return { error: 'invalid_transition', from, to }
  }
  return null
}

// Gate-bypass guard (adversarial P0, 2026-06-07): PATCH is a second write path
// to 'done' that the verdict endpoint does not own. A task carrying a gate_owner
// may only reach 'done' AFTER the verdict endpoint set it 'approved' (or
// 'rejected' → abandon). From any pre-/non-verdict status, PATCH-to-done forges
// completion past the entire gate. Returns true when the PATCH must be refused.
export function patchToDoneBypassesGate(
  existingStatus: TaskStatus,
  gateOwner: string | null | undefined,
  targetStatus: TaskStatus,
): boolean {
  if (targetStatus !== 'done') return false
  if (!gateOwner) return false
  return existingStatus !== 'approved' && existingStatus !== 'rejected'
}

export interface CreateTaskInput {
  squad_id: string
  title: string
  body?: string
  status?: TaskStatus
  assignee_agent_id?: string | null
  gate_owner?: string | null
}

export interface CreateTaskOptions {
  actor?: TaskActor
  // Skip the outbound GitHub-issue mirror. Set for tasks that ORIGINATE from a GitHub
  // event (the inbound webhook) — mirroring a GitHub event back into a GitHub issue is
  // redundant AND reflects attacker-influenced PR/CI fields out under our token (a loop
  // + mention/ref injection). Webhook-origin tasks are inbound-only.
  skipMirror?: boolean
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
    // Update NEVER creates. A null issue here means the task was never mirrored — either
    // no token at create, or skipMirror (a GitHub-origin/webhook task). Creating on a
    // later status PATCH would reflect attacker-influenced webhook fields out under our
    // token (the P1 side-door). Creation is createTask's job alone, which honors skipMirror.
    return task.github_issue_url
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
    gate_owner: input.gate_owner ?? null,
    created_at: now,
    updated_at: now,
  }

  task.github_issue_url = options.skipMirror ? null : await mirrorTaskCreate(env, task)

  await env.DB.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      task.gate_owner,
      task.created_at,
      task.updated_at,
    )
    .run()

  await emitTaskEvent(env, 'task.created', task, options.actor)
  return task
}

// ── Verdict write ─────────────────────────────────────────────────────────────
//
// Flips the task status and appends a verdict receipt.
//
// K5 TOCTOU fix — chosen pattern: conditional UPDATE first, then INSERT verdict.
//
// Why not a D1 batch?
// D1 batch is transactional (all-or-neither) but it cannot *conditionally* abort
// in the middle: `UPDATE ... WHERE status='review'` inside a batch with 0 changes
// still "succeeds" as a statement — D1 cannot abort-on-zero-changes mid-batch.
// So we cannot use batch for the race-guard.
//
// Chosen pattern:
//   1. Standalone `UPDATE tasks SET status=? WHERE id=? AND status='review'`
//      → check meta.changes. If 0 → 409 (race lost: another verdict already
//      flipped the row). The 409 is surfaced to the caller.
//   2. On changes=1: INSERT task_verdicts.
//      If INSERT fails (DB error), the status flip stands but the audit receipt
//      is missing. We emit a `task.verdict_orphan` bus event and re-throw so the
//      caller gets a 500. Operators can reconcile from the bus event log.
//      This is a narrow window (step-2 failure after step-1 success) that requires
//      a DB write error on a simple INSERT — acceptable given D1's durability model.
//
// Multiple verdicts per task ARE legitimate (rework loop: rejected → in_progress →
// review → approved). No UNIQUE constraint on task_verdicts(task_id).
//
// Called exclusively from POST /api/tasks/:id/verdict after all pre-checks pass.

export interface WriteVerdictInput {
  task: Task
  verdict: 'approved' | 'rejected'
  note: string | null
  decidedBy: string // principal id (memberId or userId)
}

export class VerdictRaceError extends Error {
  constructor(taskId: string) {
    super(`verdict_race: task ${taskId} is no longer in review (concurrent verdict won)`)
    this.name = 'VerdictRaceError'
  }
}

export async function writeVerdict(
  env: Env,
  input: WriteVerdictInput,
  actor?: TaskActor,
): Promise<{ task: Task; verdict: TaskVerdict }> {
  const now = new Date().toISOString()
  const newStatus: TaskStatus = input.verdict === 'approved' ? 'approved' : 'rejected'

  // K5 step 1: conditional UPDATE — only succeeds while the task is still 'review'.
  // meta.changes === 0 means another concurrent verdict already won the race.
  const flipResult = await env.DB.prepare(
    `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'review'`,
  )
    .bind(newStatus, now, input.task.id)
    .run()

  if (!flipResult.meta.changes || flipResult.meta.changes === 0) {
    // Race lost: the task is no longer in 'review'. Surface as a typed error so
    // the route can return 409 with a clear message.
    throw new VerdictRaceError(input.task.id)
  }

  // K5 step 2: status flipped — now insert the receipt. If this fails, the status
  // flip stands but we have no receipt. Emit an orphan event for reconciliation.
  const verdictRow: TaskVerdict = {
    id: crypto.randomUUID(),
    task_id: input.task.id,
    verdict: input.verdict,
    note: input.note,
    decided_by: input.decidedBy,
    decided_at: now,
  }

  try {
    await env.DB.prepare(
      `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        verdictRow.id,
        verdictRow.task_id,
        verdictRow.verdict,
        verdictRow.note,
        verdictRow.decided_by,
        verdictRow.decided_at,
      )
      .run()
  } catch (insertErr) {
    // Status is already flipped — there is no safe rollback path in D1 without a
    // transaction API. Emit an orphan event so operators can detect and reconcile.
    try {
      await createBus(env).emit({
        type: 'task.verdict_orphan' as 'task.verdict', // narrow cast for bus compat
        tenant: env.TENANT_SLUG,
        squad_id: input.task.squad_id,
        agent_id: input.task.assignee_agent_id ?? undefined,
        actor,
        payload: {
          task_id: input.task.id,
          verdict: input.verdict,
          new_status: newStatus,
          decided_by: input.decidedBy,
          error: insertErr instanceof Error ? insertErr.message : 'insert_failed',
        },
        ts: now,
      })
    } catch {
      // bus emit is best-effort
    }
    throw insertErr // propagate so the route returns 500
  }

  const updatedTask: Task = {
    ...input.task,
    status: newStatus,
    updated_at: now,
  }

  // Emit verdict event (non-fatal — the verdict is already written).
  try {
    await createBus(env).emit({
      type: 'task.verdict',
      tenant: env.TENANT_SLUG,
      squad_id: input.task.squad_id,
      agent_id: input.task.assignee_agent_id ?? undefined,
      actor,
      payload: {
        task_id: input.task.id,
        verdict: input.verdict,
        new_status: newStatus,
        decided_by: input.decidedBy,
      },
      ts: now,
    })
  } catch {
    // Bus emit failures must never roll back an already-written verdict.
  }

  return { task: updatedTask, verdict: verdictRow }
}

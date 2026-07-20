// mupot — shared task service.
//
// This is the single creation path for durable task rows. Every surface
// (dashboard/API, MCP, IM, channels, agents) should call createTask() instead of
// hand-writing rows. `task.created` is a post-persistence notification event.

import type { Env, Task, TaskVerdict, BusEvent } from '../types'
import { createBus } from '../bus'
import { assertWritten } from '../lib/receipt'
import { resolveOutboundGitHubToken } from '../integrations/github-app'

export type TaskStatus = Task['status']
type TaskActor = NonNullable<BusEvent['actor']>

// Task rows are durable before mirroring begins. Bound the best-effort GitHub
// mirror so a slow upstream cannot indefinitely hold the operator's POST open.
const GITHUB_TASK_MIRROR_TIMEOUT_MS = 5_000

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

// NO SELF-CLOSE — the shared chokepoint (fake-green guard, 2026-07-20 re-gate on
// PR #417). A dispatched runtime self-marked its OWN in_progress task 'done'
// with zero work (no branch, no PR, no receipt) and the pot accepted it. The
// first fix inlined a check ONLY in MCP task_update; an Opus adversarial re-gate
// found two more doors that never called it: (BLOCK-1) an agent can strip/
// reassign itself off the task via task_update{assignee_agent_id:...} while
// still in_progress, then close it — the assignee comparison in the OLD inline
// check no longer sees a match; (BLOCK-2) src/agents/execute.ts's own
// finishTask wrote 'done' directly with no different-principal check at all,
// a second, entirely separate write path.
//
// This predicate is now the SINGLE source of truth for "must this done-move be
// refused because the actor is grading its own homework" — every path that can
// write 'done' (MCP task_update, REST PATCH /api/tasks/:id, execute.ts's
// finishTask) calls it instead of re-deriving the comparison locally.
//
// Returns true when the move MUST be refused: the actor is the task's current
// assignee, closing its OWN in_progress task straight to 'done'. approved→done
// is NOT refused (fromStatus !== 'in_progress' short-circuits it) — a
// non-assignee verdict has already passed the gate by the time a task reaches
// 'approved' (see the verdict endpoint's self-verdict check, src/tasks/index.ts,
// which independently blocks a self-approval from ever landing 'approved').
export function assigneeSelfClose(
  actorAgentId: string | null | undefined,
  fromStatus: TaskStatus,
  assigneeAgentId: string | null | undefined,
  toStatus: TaskStatus,
): boolean {
  if (toStatus !== 'done') return false
  if (fromStatus !== 'in_progress') return false
  if (!actorAgentId || !assigneeAgentId) return false
  return actorAgentId === assigneeAgentId
}

// BLOCK-1 close: assigneeSelfClose only fires on the in_progress→done move
// itself, so an agent could launder around it by first stripping/reassigning
// itself off the task (task_update{assignee_agent_id:null}) while still
// in_progress, THEN calling {status:'done'} — by then assigneeAgentId is
// null/different and assigneeSelfClose no longer sees a self-match. Close the
// bypass at the mutation, not just the close: an agent bound-token that IS the
// CURRENT assignee of an in_progress task may not change assignee_agent_id on
// that task at all (unassign or reassign to anyone else). Non-assignees
// (operators, admins, a different agent) are unaffected — this only fires when
// the actor and the existing assignee match.
export function assigneeCannotMutateOwnAssignment(
  actorAgentId: string | null | undefined,
  fromStatus: TaskStatus,
  assigneeAgentId: string | null | undefined,
): boolean {
  if (fromStatus !== 'in_progress') return false
  if (!actorAgentId || !assigneeAgentId) return false
  return actorAgentId === assigneeAgentId
}

export function stampTaskUpdate(
  task: Task,
  previousStatus: TaskStatus,
  now: string,
): void {
  task.updated_at = now
  if (previousStatus !== 'done' && task.status === 'done') {
    task.completed_at = now
  }
}

export interface CreateTaskInput {
  squad_id: string
  project_id?: string | null
  title: string
  // #142 capsule keystone: a verifiable success predicate. Required and must be
  // a non-empty string — the application layer rejects blank/missing values before
  // calling createTask() so the DB sentinel default is never written by new code.
  done_when: string
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

export type TaskProjectErrorCode =
  | 'invalid_project_id'
  | 'project_not_found'
  | 'archived_project'
  | 'project_access_forbidden'

export class TaskProjectError extends Error {
  constructor(readonly code: TaskProjectErrorCode) {
    super(code)
    this.name = 'TaskProjectError'
  }
}

export type TaskUpdateConflictCode = 'task_update_conflict' | 'task_project_locked'

export class TaskUpdateConflictError extends Error {
  constructor(readonly code: TaskUpdateConflictCode) {
    super(code)
    this.name = 'TaskUpdateConflictError'
  }
}

export async function validateTaskProjectAttribution(
  env: Env,
  projectId: string | null,
  squadId: string,
): Promise<void> {
  if (projectId === null) return
  if (!isNonEmptyString(projectId)) throw new TaskProjectError('invalid_project_id')
  const row = await env.DB.prepare(
    `SELECT p.status, psa.access_level
       FROM projects p
       LEFT JOIN project_squad_access psa
         ON psa.project_id = p.id AND psa.squad_id = ?2
      WHERE p.id = ?1`,
  ).bind(projectId, squadId).first<{ status: string; access_level: string | null }>()
  if (!row) throw new TaskProjectError('project_not_found')
  if (row.status === 'archived') throw new TaskProjectError('archived_project')
  if (row.access_level !== 'write' && row.access_level !== 'admin') {
    throw new TaskProjectError('project_access_forbidden')
  }
}

function mapTaskProjectInsertError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('task project not found')) throw new TaskProjectError('project_not_found')
  if (message.includes('task project archived')) throw new TaskProjectError('archived_project')
  if (message.includes('task project access denied')) throw new TaskProjectError('project_access_forbidden')
  throw error
}

function mapTaskProjectUpdateError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('task project locked by flight')) {
    throw new TaskUpdateConflictError('task_project_locked')
  }
  if (
    message.includes('task project not found')
    || message.includes('task project archived')
    || message.includes('task project access denied')
  ) {
    throw new TaskUpdateConflictError('task_update_conflict')
  }
  throw error
}

export async function persistTaskUpdate(
  env: Env,
  existing: Task,
  next: Task,
): Promise<void> {
  let result
  try {
    result = await env.DB.prepare(
      `UPDATE tasks
          SET title = ?, body = ?, done_when = ?, status = ?, assignee_agent_id = ?, github_issue_url = ?, gate_owner = ?, project_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND project_id IS ?`,
    )
      .bind(
        next.title,
        next.body,
        next.done_when,
        next.status,
        next.assignee_agent_id,
        next.github_issue_url,
        next.gate_owner,
        next.project_id,
        next.completed_at,
        next.updated_at,
        next.id,
        existing.updated_at,
        existing.project_id,
      )
      .run()
  } catch (error) {
    mapTaskProjectUpdateError(error)
  }
  if (!result.meta?.changes) throw new TaskUpdateConflictError('task_update_conflict')
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

async function requestGitHubIssue(
  url: string,
  init: Omit<RequestInit, 'signal'>,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_TASK_MIRROR_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) return null
    // Keep the deadline armed through the body read as well as the request.
    const data = (await res.json()) as { html_url?: string }
    return typeof data.html_url === 'string' ? data.html_url : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function mirrorTaskCreate(env: Env, task: Task): Promise<string | null> {
  const repo = githubRepo(env)
  if (!repo) return null
  // App-first: prefer a short-lived installation token; fall back to the static PAT.
  const token = await resolveOutboundGitHubToken(env)
  if (!token) return null

  return requestGitHubIssue(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ title: task.title, body: issueBody(task) }),
  })
}

export async function mirrorTaskUpdate(env: Env, task: Task): Promise<string | null> {
  const repo = githubRepo(env)
  if (!repo) return task.github_issue_url
  const token = await resolveOutboundGitHubToken(env)
  if (!token) return task.github_issue_url

  const issueNumber = parseIssueNumber(task.github_issue_url)
  if (issueNumber === null) {
    // Update NEVER creates. A null issue here means the task was never mirrored — either
    // no token at create, or skipMirror (a GitHub-origin/webhook task). Creating on a
    // later status PATCH would reflect attacker-influenced webhook fields out under our
    // token (the P1 side-door). Creation is createTask's job alone, which honors skipMirror.
    return task.github_issue_url
  }

  return (await requestGitHubIssue(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: githubHeaders(token),
    body: JSON.stringify({
      title: task.title,
      body: issueBody(task),
      state: issueState(task.status),
    }),
  })) ?? task.github_issue_url
}

function parseIssueNumber(url: string | null): number | null {
  if (!url) return null
  const m = url.match(/\/issues\/(\d+)(?:[/?#].*)?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) ? n : null
}

/**
 * B3 — inbound status sync: a GitHub issue (that mirrors a pot task) was closed/reopened, so
 * reflect it onto the task. Finds the task by its github_issue_url and updates status DIRECTLY
 * (no mirrorTaskUpdate — this update ORIGINATES from GitHub; mirroring it back would PATCH the
 * very issue that fired the webhook → a feedback loop). closed → done, reopened/open → open.
 *
 * Idempotent + bounded: only flips open⇄done, never overrides a task already in the target
 * state or in review/approved/rejected (those are pot-side gate states GitHub must not clobber).
 * Returns whether a row changed.
 */
export async function syncTaskStatusFromIssue(
  env: Env,
  issueUrl: string,
  action: 'closed' | 'reopened',
): Promise<{ updated: boolean }> {
  if (!issueUrl) return { updated: false }
  const now = new Date().toISOString()
  if (action === 'closed') {
    // open/in_progress → done. Leave review/approved/rejected/done untouched.
    const res = await env.DB.prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?1, updated_at = ?1
        WHERE github_issue_url = ?2 AND status IN ('open','in_progress')`,
    )
      .bind(now, issueUrl)
      .run()
    return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
  }
  // reopened: done → open (only if it was closed by us). Never touch gate states.
  const res = await env.DB.prepare(
    `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = ?1
      WHERE github_issue_url = ?2 AND status = 'done'`,
  )
    .bind(now, issueUrl)
    .run()
  return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
}

/**
 * D3 — CI feedback: a completed workflow_run for PR #`prNumber` writes its `conclusion` onto
 * the task whose github_issue_url is that PR. A failing/cancelled/timed-out conclusion on a
 * task in `review` bumps it back to `in_progress` (the agent's work needs another pass);
 * success leaves the task in review (awaiting human merge). Matches by the PR-number suffix of
 * the stored PR url. Never clobbers approved/rejected/done. Returns whether a row changed.
 */
export async function syncCiResultToTask(
  env: Env,
  prNumber: number,
  conclusion: string,
): Promise<{ updated: boolean }> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { updated: false }
  const now = new Date().toISOString()
  const note = `CI: ${conclusion}`
  const failed = conclusion !== 'success' && conclusion !== 'neutral' && conclusion !== 'skipped'
  // LIKE on the PR-number suffix; bound param (no injection). The '%/pull/N' shape is what
  // openPullRequest stores. ESCAPE not needed — prNumber is an integer.
  const suffix = `%/pull/${prNumber}`
  if (failed) {
    const res = await env.DB.prepare(
      `UPDATE tasks SET result = ?1, status = 'in_progress', updated_at = ?2
        WHERE github_issue_url LIKE ?3 AND status = 'review'`,
    )
      .bind(note, now, suffix)
      .run()
    return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
  }
  // success/neutral/skipped: record the note without changing a gate state.
  const res = await env.DB.prepare(
    `UPDATE tasks SET result = ?1, updated_at = ?2
      WHERE github_issue_url LIKE ?3 AND status IN ('review','in_progress','open')`,
  )
    .bind(note, now, suffix)
    .run()
  return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
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
    payload: { task_id: task.id, project_id: task.project_id, status: task.status, title: task.title },
    ts: new Date().toISOString(),
  })
}

// #142 capsule keystone: done_when must be a non-empty string.
// Called by createTask() and the MCP tool handler before createTask() is invoked.
export function isDoneWhenValid(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// Door 5 — completion gate: placeholder sentinel strings that satisfy non-empty
// presence (Door 3) but are NOT verifiable predicates. A task must have its
// done_when replaced with a real predicate before it can be marked done.
//
// Canonical sentinel set (matches Door 3 inbound call-site fallback values):
//  - '(backfill required)'                     — DB migration column default
//  - '(set via task update)'                   — IM / channel inbound path
//  - '(agent-generated — set via task update)' — agent-do model-fallback
//
// Matching is case-insensitive and whitespace-trimmed so minor typos in old rows
// still hit the guard. New sentinels should be added here AND at the inbound call
// site that produces them.
const PLACEHOLDER_SENTINELS: ReadonlySet<string> = new Set([
  '(backfill required)',
  '(set via task update)',
  '(agent-generated — set via task update)',
])

/**
 * Returns true when the done_when value is a known placeholder sentinel — i.e.
 * it satisfies presence (non-empty) but is NOT a verifiable predicate.
 * Used by the completion gate to refuse DONE transitions with unset predicates.
 */
export function isPlaceholderDoneWhen(v: string): boolean {
  return PLACEHOLDER_SENTINELS.has(v.trim().toLowerCase().replace(/\s+/g, ' '))
    || PLACEHOLDER_SENTINELS.has(v.trim())
}

/**
 * Throws `done_when_placeholder` if the done_when is blank or a known sentinel.
 * Call this at every completion chokepoint (PATCH→done, agent finishTask) before
 * writing `done` status to the DB.
 *
 * The auto-VERIFY step (checking the predicate holds) is a future door — this
 * door closes the simpler gap: placeholder present ≠ completable.
 */
export function assertCompletableDoneWhen(doneWhen: string | null | undefined): void {
  if (!isDoneWhenValid(doneWhen)) {
    throw Object.assign(
      new Error('done_when_placeholder: task cannot be marked done while done_when is blank — set a verifiable success predicate first'),
      { code: 'done_when_placeholder' },
    )
  }
  if (isPlaceholderDoneWhen(doneWhen as string)) {
    throw Object.assign(
      new Error(`done_when_placeholder: task cannot be marked done while done_when is a placeholder sentinel ("${(doneWhen as string).trim()}") — replace it with a real, checkable predicate first`),
      { code: 'done_when_placeholder' },
    )
  }
}

export async function createTask(
  env: Env,
  input: CreateTaskInput,
  options: CreateTaskOptions = {},
): Promise<Task> {
  // Enforce done_when before touching the DB.
  if (!isDoneWhenValid(input.done_when)) {
    throw new Error('done_when_required: task creation requires a non-empty verifiable success predicate')
  }

  const projectId = input.project_id ?? null
  await validateTaskProjectAttribution(env, projectId, input.squad_id)

  const now = new Date().toISOString()
  const task: Task = {
    id: crypto.randomUUID(),
    squad_id: input.squad_id,
    project_id: projectId,
    title: input.title.trim(),
    body: input.body ?? '',
    done_when: input.done_when.trim(),
    status: input.status ?? 'open',
    assignee_agent_id: input.assignee_agent_id ?? null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: input.gate_owner ?? null,
    created_at: now,
    updated_at: now,
  }

  let taskInsert
  try {
    taskInsert = await env.DB.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        task.id,
        task.squad_id,
        task.project_id,
        task.title,
        task.body,
        task.done_when,
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
  } catch (error) {
    mapTaskProjectInsertError(error)
  }
  // Receipt (#186): a 0-row INSERT resolves without throwing — verify the row
  // actually landed before we emit "created" and return the task as success.
  assertWritten(taskInsert, 'tasks.insert')

  if (!options.skipMirror) {
    const issueUrl = await mirrorTaskCreate(env, task)
    if (issueUrl) {
      const linkUpdate = await env.DB.prepare(
        `UPDATE tasks SET github_issue_url = ?1 WHERE id = ?2 AND github_issue_url IS NULL`,
      )
        .bind(issueUrl, task.id)
        .run()
      assertWritten(linkUpdate, 'tasks.github_issue_url.update')
      task.github_issue_url = issueUrl
    }
  }

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

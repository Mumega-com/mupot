// mupot — shared task service.
//
// This is the single creation path for durable task rows. Every surface
// (dashboard/API, MCP, IM, channels, agents) should call createTask() instead of
// hand-writing rows. `task.created` is a post-persistence notification event.

import type { Env, Task, TaskPriority, TaskVerdict, BusEvent } from '../types'
import { createBus } from '../bus'
import { assertWritten } from '../lib/receipt'
import { resolveOutboundGitHubToken } from '../integrations/github-app'
import { isBlankProvenance } from './provenance'
import { hasProjectWriteForSquads } from '../projects/access'
import { GATE_CAPABILITY_RE, resolveSoleGateOwnerAgent } from '../gates/grants'

// gate_owner is used RAW as the grant capability in callerHoldsGateCapability
// (src/tasks/index.ts): `SELECT 1 FROM gate_grants WHERE capability = <gate_owner>`.
// Only 'gate:<owner>' strings are insertable into gate_grants (GATE_CAPABILITY_RE,
// grants.ts) — there is NO self-verdict-by-agent-id path; an agent UUID as
// gate_owner is looked up as capability='<uuid>' and matches nothing, exactly as
// unverdictable as a bare slug. So the ONE legal form is 'gate:<owner>'.
//
// (This is TIGHTER than the first-pass criteria "gate:<owner> OR an agent id":
// tracing the lookup showed the agent-id branch would never match a grant, so
// accepting it would just let a different unverdictable value through — board
// 247858f1.) Reject at WRITE TIME rather than silently coerce: a silent coerce is
// how the next mismatch ships.
export async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  const { resolveTaskEntity } = await import('../lib/entity-resolver')
  const res = await resolveTaskEntity(env, taskId)
  return res.ok ? res.entity : null
}

export async function getTask(
  env: Env,
  taskRef: string,
): Promise<{ ok: true; task: Task } | { ok: false; error: string; reason?: string; candidates?: any[] }> {
  const { resolveTaskEntity } = await import('../lib/entity-resolver')
  const res = await resolveTaskEntity(env, taskRef)
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      return { ok: false, error: 'ambiguous_task_id', reason: 'ambiguous', candidates: res.candidates }
    }
    return { ok: false, error: 'task_not_found', reason: 'task_not_found' }
  }
  return { ok: true, task: res.entity }
}

export function isValidGateOwnerForm(value: string): boolean {
  return GATE_CAPABILITY_RE.test(value)
}

export class TaskSelfGateError extends Error {
  constructor(message = 'gate_owner cannot be the task assignee; self-approval is forbidden and causes deadlock') {
    super(message)
    this.name = 'TaskSelfGateError'
  }
}

/**
 * Self-Gate Deadlock Prevention (Issue #1030 / FLIGHT EXEC-02).
 * Rejects gate_owner == assignee_agent_id at write time for all gates other than
 * gate:agent-self-completion. A task where the gate_owner resolves to the assignee
 * cannot be approved because self-verdicts are forbidden, permanently deadlocking the task.
 */
export async function isSelfGatedConflict(
  env: Env,
  gateOwner: string | null | undefined,
  assigneeAgentId: string | null | undefined,
): Promise<boolean> {
  if (!gateOwner || !assigneeAgentId) return false
  const trimmedGate = gateOwner.trim()
  const trimmedAssignee = assigneeAgentId.trim()
  if (!trimmedGate || !trimmedAssignee) return false
  if (trimmedGate === 'gate:agent-self-completion') return false

  // Direct equality or 'gate:' prefix equality
  if (trimmedGate === trimmedAssignee) return true
  if (trimmedGate === `gate:${trimmedAssignee}`) return true

  // Resolve agent in DB by id or slug
  try {
    const agent = await env.DB.prepare(
      `SELECT id, slug FROM agents WHERE id = ?1 OR slug = ?1 LIMIT 1`,
    ).bind(trimmedAssignee).first<{ id: string; slug: string }>()

    if (agent) {
      if (trimmedGate === agent.id || trimmedGate === agent.slug) return true
      if (trimmedGate === `gate:${agent.id}` || trimmedGate === `gate:${agent.slug}`) return true

      const soleAgent = await resolveSoleGateOwnerAgent(env, trimmedGate)
      if (soleAgent && (soleAgent === agent.id || soleAgent === agent.slug)) return true

      const grant = await env.DB.prepare(
        `SELECT 1 FROM gate_grants WHERE capability = ?1 AND principal_type = 'agent' AND (principal_id = ?2 OR principal_id = ?3) LIMIT 1`,
      ).bind(trimmedGate, agent.id, agent.slug).first()
      if (grant) return true
    } else {
      const soleAgent = await resolveSoleGateOwnerAgent(env, trimmedGate)
      if (soleAgent && soleAgent === trimmedAssignee) return true
      if (trimmedGate.startsWith('gate:') && trimmedGate.slice(5).trim() === trimmedAssignee) return true
    }
  } catch {
    if (trimmedGate === trimmedAssignee || trimmedGate === `gate:${trimmedAssignee}`) return true
    if (trimmedGate.startsWith('gate:') && trimmedGate.slice(5).trim() === trimmedAssignee) return true
  }

  return false
}

export type TaskStatus = Task['status']
export const ALL_TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'review',
  'approved',
  'rejected',
]

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (ALL_TASK_STATUSES as readonly string[]).includes(v)
}

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
// 2nd re-gate (same day): the first pass at BLOCK-1/BLOCK-2 above still left two
// gaps — a wider BLOCK-1 laundering lap through 'blocked' (not just
// 'in_progress'), and a WARN where rejected→done skipped both assigneeSelfClose
// (fromStatus check was in_progress-only) and patchToDoneBypassesGate (fires
// only when gate_owner is set). Both are closed below; see the status sets and
// their comments for the exact shape of each.
//
// Statuses from which a →done PATCH is a legal transition (TRANSITIONS above)
// with NO verdict/gate step in between — 'in_progress' directly, and 'rejected'
// (a rework cycle a DIFFERENT principal's rejection put the task into; the
// assignee still holds assignee_agent_id and 'rejected'→'done' is a legal edge
// with no verdict gating it). 'approved'→'done' is deliberately excluded: a
// non-assignee verdict has already passed the gate by the time a task reaches
// 'approved' (the verdict endpoint's own self-verdict check keeps a
// self-approval from ever landing 'approved' in the first place, so a
// subsequent approved→done by the same assignee is not re-grading its own work).
const ASSIGNEE_UNVERIFIED_DONE_SOURCES: ReadonlySet<TaskStatus> = new Set(['in_progress', 'rejected'])

// The full set of non-terminal statuses from which the ASSIGNEE can, via legal
// transitions it alone drives, still reach 'done' — so mutating the assignee
// field from ANY of them can launder around the self-close guard (null the
// assignee, then route into 'done' with no self-match left). The coverage set
// MUST equal every done-reachable non-terminal status, NOT just the direct
// →done edges — that gap is what let the 2nd/3rd re-gates find new laps:
//   - 'open' → in_progress → done
//   - 'in_progress' → done  (and → blocked → in_progress → done)
//   - 'blocked' → in_progress → done
//   - 'review' → (self-verdict once unassigned) → approved → done
//   - 'rejected' → in_progress → done  (overrides another principal's rejection!)
// Only 'approved' is excluded: approved→done is the INTENDED post-verdict close,
// and a different principal already verified the work to reach 'approved', so an
// assignee unassigning from there cannot manufacture a fake-green. 'done' is
// terminal. Non-assignees (operators, admins, a different agent) are unaffected.
const ASSIGNEE_STEERABLE_TOWARD_DONE: ReadonlySet<TaskStatus> = new Set([
  'open',
  'in_progress',
  'blocked',
  'review',
  'rejected',
])

// Returns true when the move MUST be refused: the actor is the task's current
// assignee, closing its OWN task straight to 'done' from a status reachable
// with zero outside verification (see ASSIGNEE_UNVERIFIED_DONE_SOURCES).
// rejected→done IS refused (2026-07-20, 2nd re-gate — WARN close): after a
// DIFFERENT principal rejects a task, the assignee still holds
// assignee_agent_id and 'rejected' legally transitions straight to 'done' with
// no verdict in between — a self-close from there is exactly the same "grading
// your own homework" shape as in_progress→done, just reached via a different
// legal edge, so it must be refused too.
export function assigneeSelfClose(
  actorAgentId: string | null | undefined,
  fromStatus: TaskStatus,
  assigneeAgentId: string | null | undefined,
  toStatus: TaskStatus,
): boolean {
  if (toStatus !== 'done') return false
  if (!ASSIGNEE_UNVERIFIED_DONE_SOURCES.has(fromStatus)) return false
  if (!actorAgentId || !assigneeAgentId) return false
  return actorAgentId === assigneeAgentId
}

// BLOCK-1 close (widened 2026-07-20, 2nd re-gate): assigneeSelfClose only fires
// on the actual →done move, so an agent could launder around it by mutating the
// assignee field first, THEN closing — by then assigneeAgentId no longer
// matches and assigneeSelfClose sees no self-match. The first fix only closed
// this while fromStatus==='in_progress'; the adversarial gate found a second
// lap through the SAME hole: in_progress→blocked (legal) → unassign (the OLD
// guard skipped it, status was 'blocked') → blocked→in_progress (assignee now
// null) → →done (assigneeSelfClose sees assigneeAgentId=null, no self-match).
// Fix: an agent bound-token that IS the CURRENT assignee of a task in any
// done-reachable non-terminal status (ASSIGNEE_STEERABLE_TOWARD_DONE — every
// status except 'approved' and terminal 'done') may not change
// assignee_agent_id on it at all (unassign or reassign to anyone else). The
// 3rd re-gate proved the set must be the FULL done-reachable set, not just the
// direct →done edges: 'rejected' was omitted on the reasoning that
// assigneeSelfClose covers rejected→done directly, but rejected→(unassign)→
// in_progress→done routes around it. Non-assignees (operators, admins, a
// different agent) are unaffected — this only fires when the actor and the
// existing assignee match.
export function assigneeCannotMutateOwnAssignment(
  actorAgentId: string | null | undefined,
  fromStatus: TaskStatus,
  assigneeAgentId: string | null | undefined,
): boolean {
  if (!ASSIGNEE_STEERABLE_TOWARD_DONE.has(fromStatus)) return false
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
  /** Rank (migrations/0079). Omitted/null = untriaged, which is a real state, not a default. */
  priority?: TaskPriority | null
  /** Subtask link (migrations/0079). Omitted/null = top-level. */
  parent_task_id?: string | null
}

export interface CreateTaskOptions {
  actor?: TaskActor
  /** Internal deterministic identity for crash-safe control-plane replay. */
  id?: string
  /** Persist without a task.created runtime wake when another durable dispatch owns activation. */
  skipEvent?: boolean
  // Skip the outbound GitHub-issue mirror. Set for tasks that ORIGINATE from a GitHub
  // event (the inbound webhook) — mirroring a GitHub event back into a GitHub issue is
  // redundant AND reflects attacker-influenced PR/CI fields out under our token (a loop
  // + mention/ref injection). Webhook-origin tasks are inbound-only.
  skipMirror?: boolean
  /** Internal atomic fence used by Routine dispatch before creating control work. */
  routineRunFence?: { runId: string; tenant: string }
  // PR #659 P0 fix: provenance marker for a task written by a governed external
  // integration (see Task.external_source, migrations/0077). Undefined/null on every
  // normal create call -- only src/integrations/linear-issues.ts and the task_create
  // MCP tool's carry-forward path (steward reissue) set this today. Monotonic-safe to
  // expose broadly: it only ever ADDS restriction (no auto-pickup, admin-gated
  // reassignment, untrusted-content prompt fence), never removes it, so a caller
  // setting it on its own new task cannot escalate privilege.
  /**
   * Allow creation with a recognized placeholder sentinel (e.g. agent-do fallback, loop spawn, channel quick-add).
   * The task is still blocked from transitioning to 'done' by assertCompletableDoneWhen until a real predicate is set.
   */
  allowDeferredPredicate?: boolean
  externalSource?: string | null
}

/**
 * Internal composition seam: the fully validated task plus its one direct DML
 * insert. It deliberately exposes no prepared statement and performs no write,
 * mirror or event on its own.
 */
export interface PreparedGuardedTaskInsert {
  readonly task: Task
  readonly sql: string
  readonly bindings: readonly (string | number | boolean | null)[]
}

export class TaskCreateFenceError extends Error {
  constructor() {
    super('routine_dispatch_fenced')
    this.name = 'TaskCreateFenceError'
  }
}

export type TaskProjectErrorCode =
  | 'invalid_project_id'
  | 'project_not_found'
  | 'archived_project'
  | 'project_access_forbidden'
  | 'detach_locked_result_present'

export class TaskProjectError extends Error {
  constructor(readonly code: TaskProjectErrorCode) {
    super(code)
    this.name = 'TaskProjectError'
  }
}

export type TaskUpdateConflictCode = 'task_update_conflict' | 'task_project_locked' | 'detach_locked_result_present'

export class TaskUpdateConflictError extends Error {
  constructor(readonly code: TaskUpdateConflictCode) {
    super(code)
    this.name = 'TaskUpdateConflictError'
  }
}

// #400 fast-follow: the app-side half of the detach-evidence lock. Mirrors the
// migration-layer tasks_project_detach_locked_by_result trigger (see the
// newest migration) so the caller gets a clear domain error instead of a raw
// SQLite ABORT message. `detaching` carries the CURRENT (pre-update) row's
// project_id/result — only present when this validation is running against an
// existing task (task_update), never on createTask (there is no prior row to
// detach FROM). Deliberately excludes any receipt/RBAC check: 0059's
// tasks_project_locked_by_receipt already owns the receipt-backed case, and an
// authz check on the OLD project is a separate, deferred decision (#402) — this
// is purely "don't let a receipt-less task with real evidence fall out of the
// project's evidence board un-locked."
export interface TaskDetachContext {
  projectId: string | null
  result: string | null
}

export async function validateTaskProjectAttribution(
  env: Env,
  projectId: string | null,
  squadId: string,
  detaching?: TaskDetachContext,
): Promise<void> {
  if (projectId === null) {
    if (detaching && detaching.projectId !== null && isNonEmptyString(detaching.result)) {
      throw new TaskProjectError('detach_locked_result_present')
    }
    return
  }
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

// #399 — evidence fence for automation write paths.
//
// Migration 0061 narrowed the task-access trigger (validate_tasks_project_id_update)
// to fire only on UPDATE OF squad_id, project_id — correct for #391 (in-flight status
// transitions must not abort just because a squad was later downgraded on a project).
// Side effect: any automation write whose SET clause never touches those two columns
// bypasses the trigger entirely, even when the task is project-attached. Three such
// paths write evidence-bearing content onto a task (tasks.result feeds
// idx_tasks_project_evidence_keyset, 0059; task_verdicts.note feeds
// idx_task_verdicts_evidence_keyset) without ever re-checking whether the task's
// OWNING squad (task.squad_id) still holds write/admin on task.project_id:
// syncCiResultToTask, syncTaskStatusFromIssue, writeVerdict. Policy decision (#399):
// a downgrade fences the squad's automation OUT of that project's evidence surface
// immediately — it does not get to finish landing new/refreshed evidence there.
//
// This is the single check all three call before writing. It reuses the SAME
// primitive the rest of v0.24 uses for per-project write access
// (src/projects/access.ts#hasProjectWriteForSquads — the write/admin threshold used
// by flight dispatch's #402 project-write gate) rather than re-deriving the
// project_squad_access.access_level comparison here. Fail-closed: a thrown/unresolved
// access lookup is treated as no access, never as a bypass.
async function squadCanWriteProjectEvidence(
  env: Env,
  projectId: string | null | undefined,
  squadId: string,
): Promise<boolean> {
  if (projectId === null || projectId === undefined) return true // detached task — nothing to fence
  try {
    return await hasProjectWriteForSquads(env, projectId, [squadId])
  } catch {
    return false // fail-closed
  }
}

// Filters a batch of automation-write candidates (loaded by a non-id WHERE clause —
// github_issue_url match, PR-number suffix match) down to the ones whose owning squad
// may still write project evidence. Rows for detached tasks (project_id null) always
// pass. Used by syncCiResultToTask and syncTaskStatusFromIssue, which cannot know in
// advance which task(s) their WHERE clause will match.
async function filterProjectWritableTaskIds(
  env: Env,
  rows: Array<{ id: string; project_id: string | null; squad_id: string }>,
): Promise<string[]> {
  const writable: string[] = []
  for (const row of rows) {
    if (await squadCanWriteProjectEvidence(env, row.project_id, row.squad_id)) writable.push(row.id)
  }
  return writable
}

// Thrown by writeVerdict when the task's owning squad no longer holds write/admin on
// the task's project (#399). Unlike the CI-sync/issue-sync automation paths (which
// silently skip — there is no caller waiting synchronously on a specific response),
// the verdict endpoint is always a live caller (member/agent/IM) expecting a definite
// result, so this surfaces as an explicit error the route layer maps to 403 rather
// than a silent no-op that could read as "verdict recorded" when it was not.
export class TaskEvidenceFenceError extends Error {
  constructor(readonly taskId: string) {
    super(`task_evidence_fenced: task ${taskId}'s owning squad no longer holds write access to its project`)
    this.name = 'TaskEvidenceFenceError'
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
  // #400 fast-follow (adversarial gate, LOW): the app-layer emptiness check
  // (isNonEmptyString → JS .trim()) and migration 0065's trigger guard
  // (SQLite trim(), ASCII-space only) disagree on Unicode/whitespace-only
  // results (e.g. "\t\n", a U+00A0 NBSP-only string) — JS .trim() treats them
  // as empty (app allows the detach) while SQLite's trim() does not (the
  // trigger still aborts). That is the intentionally-safe direction (the DB
  // is the backstop, never looser than the app), but the raw ABORT message
  // wasn't mapped here, so it fell through `throw error` as an uncaught 500
  // instead of the same 409 the app-layer check already returns for the
  // ASCII-agreeing case. Map it to the identical error code so the caller
  // sees one consistent 409 regardless of which fence actually fired.
  if (message.includes('task detach locked by result')) {
    throw new TaskUpdateConflictError('detach_locked_result_present')
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
  // Self-Gate Deadlock Prevention (Issue #1030 / FLIGHT EXEC-02)
  if (await isSelfGatedConflict(env, next.gate_owner, next.assignee_agent_id)) {
    throw new TaskSelfGateError()
  }

  // Chokepoint enforcement for priority discipline (Issue #1040 Phase 2):
  // When a task is escalated or mutated to P0/P1, validate intake contract requirements
  if ((existing.priority !== next.priority || existing.body !== next.body || existing.project_id !== next.project_id || existing.parent_task_id !== next.parent_task_id) && (next.priority === 'P0' || next.priority === 'P1')) {
    assertValidIntakeContract(next, { allowDeferredPredicate: true })
  }

  let result
  try {
    result = await env.DB.prepare(
      `UPDATE tasks
          SET title = ?, body = ?, done_when = ?, status = ?, priority = ?, parent_task_id = ?, assignee_agent_id = ?, github_issue_url = ?, gate_owner = ?, project_id = ?, completed_at = ?, updated_at = ?, substitute_executor_id = ?, fallback_reason = ?
        WHERE id = ? AND updated_at = ? AND project_id IS ?`,
    )
      .bind(
        next.title,
        next.body,
        next.done_when,
        next.status,
        next.priority ?? null,
        next.parent_task_id ?? null,
        next.assignee_agent_id,
        next.github_issue_url,
        next.gate_owner,
        next.project_id,
        next.completed_at,
        next.updated_at,
        next.substitute_executor_id ?? null,
        next.fallback_reason ?? null,
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

export async function mirrorTaskUpdate(
  env: Env,
  task: Task,
  opts?: { statusChanged?: boolean },
): Promise<string | null> {
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

  // Defect #1040: Only include `state` in the GitHub PATCH payload if the task status actually changed
  // or is terminal (`done`). If status was not modified in this update (e.g. title/body/assignee edit),
  // omitting `state` prevents accidentally re-opening an issue that was closed upstream on GitHub.
  const payload: { title: string; body: string; state?: 'open' | 'closed' } = {
    title: task.title,
    body: issueBody(task),
  }
  if (opts?.statusChanged !== false || task.status === 'done') {
    payload.state = issueState(task.status)
  }

  return (await requestGitHubIssue(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: githubHeaders(token),
    body: JSON.stringify(payload),
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
  const matchStatuses = action === 'closed' ? ['open', 'in_progress'] : ['done']

  // #399: this write's SET clause never touches squad_id/project_id, so 0061's
  // narrowed trigger does not fire — re-check per-row before touching a
  // project-attached task whose owning squad may have been downgraded since.
  // A closed→done flip also bumps completed_at, which reorders a task already
  // carrying a result within the evidence keyset; fencing the whole row (not
  // just a hypothetical result field) is what "don't refresh evidence" requires.
  const candidates = await env.DB.prepare(
    `SELECT id, project_id, squad_id FROM tasks
      WHERE github_issue_url = ? AND status IN (${matchStatuses.map(() => '?').join(', ')})`,
  ).bind(issueUrl, ...matchStatuses).all<{ id: string; project_id: string | null; squad_id: string }>()
  const writableIds = await filterProjectWritableTaskIds(env, candidates.results ?? [])
  if (writableIds.length === 0) return { updated: false }
  const idList = writableIds.map(() => '?').join(', ')

  if (action === 'closed') {
    // open/in_progress → done. Leave review/approved/rejected/done untouched.
    const res = await env.DB.prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?
        WHERE status IN ('open','in_progress') AND id IN (${idList})`,
    )
      .bind(now, now, ...writableIds)
      .run()
    return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
  }
  // reopened: done → open (only if it was closed by us). Never touch gate states.
  const res = await env.DB.prepare(
    `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = ?
      WHERE status = 'done' AND id IN (${idList})`,
  )
    .bind(now, ...writableIds)
    .run()
  return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
}

/**
 * Escape SQLite LIKE metacharacters (% and _) plus the escape char itself.
 * Use with `LIKE ? ESCAPE '\\'`.
 */
function escapeSqliteLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Close stale GitHub PR *event-mirror* tasks when a PR is closed/merged.
 *
 * Webhooks create open tasks titled `[GH <repo>] PR #<n> opened: …`. Without a
 * close path those rows linger forever (the ECC close-stale pattern). This closes
 * ungated open/in_progress mirrors for that repo+number. Never touches rows with
 * gate_owner set (gated review work is not event noise).
 *
 * #455 (4th instance of the #399 shape, first 3 fixed in #454): this UPDATE's SET
 * clause never touches squad_id/project_id, so 0061's task-access trigger never
 * fires — a bulk write here on a project-attached task would land/refresh evidence
 * in idx_tasks_project_evidence_keyset with no per-row access check. Unlike
 * syncCiResultToTask/syncTaskStatusFromIssue (which match rows they can't predict
 * in advance and so need the per-row filterProjectWritableTaskIds fence), these
 * mirror rows are always minted detached (github-routes.ts's createTask call omits
 * project_id) — this path is only ever meant to reap that event-noise. So the fix
 * is `AND project_id IS NULL` in the WHERE: it makes the bulk UPDATE structurally
 * unable to touch a project-attached row (deliberately attaching a mirror opts it
 * out of this auto-close path entirely, which is correct — it's no longer noise),
 * closing the class without needing a per-row fence on this bulk path.
 */
export async function closeGitHubPrMirrorTasks(
  env: Env,
  repoFullName: string,
  prNumber: number,
): Promise<{ closed: number }> {
  const repo = repoFullName.trim()
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) return { closed: 0 }
  const now = new Date().toISOString()
  // Title shape from taskFromGitHubEvent: `[GH <repo>] PR #<n> <action>: …`
  const prefix = `[GH ${repo}] PR #${prNumber} `
  const like = `${escapeSqliteLikeLiteral(prefix)}%`
  const res = await env.DB.prepare(
    `UPDATE tasks SET status = 'done', completed_at = ?1, updated_at = ?1, result = COALESCE(result, 'github_pr_closed')
      WHERE status IN ('open', 'in_progress')
        AND gate_owner IS NULL
        AND project_id IS NULL
        AND title LIKE ?2 ESCAPE '\\'`,
  )
    .bind(now, like)
    .run()
  return { closed: Number(res.meta?.changes ?? 0) }
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
  const matchStatuses = failed ? ['review'] : ['review', 'in_progress', 'open']

  // #399: this write's SET clause never touches squad_id/project_id, so 0061's
  // narrowed trigger does not fire — re-check per-row before writing `result`
  // (evidence-bearing, idx_tasks_project_evidence_keyset) onto a project-attached
  // task whose owning squad may have been downgraded since the PR was opened.
  const candidates = await env.DB.prepare(
    `SELECT id, project_id, squad_id FROM tasks
      WHERE github_issue_url LIKE ? AND status IN (${matchStatuses.map(() => '?').join(', ')})`,
  ).bind(suffix, ...matchStatuses).all<{ id: string; project_id: string | null; squad_id: string }>()
  const writableIds = await filterProjectWritableTaskIds(env, candidates.results ?? [])
  if (writableIds.length === 0) return { updated: false }
  const idList = writableIds.map(() => '?').join(', ')

  if (failed) {
    const res = await env.DB.prepare(
      `UPDATE tasks SET result = ?, status = 'in_progress', updated_at = ?
        WHERE status = 'review' AND id IN (${idList})`,
    )
      .bind(note, now, ...writableIds)
      .run()
    return { updated: Boolean(res.meta?.changes && res.meta.changes > 0) }
  }
  // success/neutral/skipped: record the note without changing a gate state.
  const res = await env.DB.prepare(
    `UPDATE tasks SET result = ?, updated_at = ?
      WHERE status IN ('review','in_progress','open') AND id IN (${idList})`,
  )
    .bind(note, now, ...writableIds)
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
//  - '(backfill required)'                          — DB migration column default
//  - '(set via task update)'                        — IM / channel inbound path
//  - '(agent-generated — set via task update)'      — agent-do / loop model-fallback
//  - '(operator resolves — set via task update)'    — escalation emit fallback
//
// Matching is case-insensitive and whitespace-trimmed so minor typos in old rows
// still hit the guard. New sentinels should be added here AND at the inbound call
// site that produces them.
const PLACEHOLDER_SENTINELS: ReadonlySet<string> = new Set([
  '(backfill required)',
  '(set via task update)',
  '(agent-generated — set via task update)',
  '(operator resolves — set via task update)',
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

/**
 * Point-of-Capture Evidence Discipline & Intake Governance (Mupot #1040).
 * 
 * Enforces verifiable intake contracts at task creation:
 * 1. Non-empty, non-sentinel verifiable success predicate (`done_when`), unless explicitly allowed by caller option.
 * 2. Minimum predicate length (min 5 chars).
 * 3. Structural P0 priority discipline: requires substantive justification in body (min 20 chars).
 */
export interface TaskIntakePayload {
  title: string
  done_when: string
  body?: string
  priority?: TaskPriority | null
  project_id?: string | null
  parent_task_id?: string | null
}

export class TaskIntakeContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TaskIntakeContractError'
  }
}

export function assertValidIntakeContract(
  input: TaskIntakePayload,
  options: { allowDeferredPredicate?: boolean } = {},
): void {
  if (!isDoneWhenValid(input.done_when)) {
    throw new TaskIntakeContractError(
      'done_when_required',
      'task creation requires a non-empty verifiable success predicate (done_when)',
    )
  }

  const trimmedDoneWhen = input.done_when.trim()
  const isSentinel = isPlaceholderDoneWhen(trimmedDoneWhen)

  if (isSentinel) {
    if (!options.allowDeferredPredicate) {
      throw new TaskIntakeContractError(
        'done_when_placeholder_rejected',
        `placeholder sentinel "${trimmedDoneWhen}" is not a verifiable success predicate — provide checkable completion criteria`,
      )
    }
  } else if (!options.allowDeferredPredicate) {
    // Non-sentinel predicates must satisfy minimum length to prevent trivial bypasses
    if (trimmedDoneWhen.length < 5) {
      throw new TaskIntakeContractError(
        'done_when_insufficient',
        'done_when predicate is too short to be verifiable — provide concrete verification instructions (min 5 chars)',
      )
    }
  }

  // P0 Priority Discipline: requires non-trivial justification in body explaining emergency/impact
  if (input.priority === 'P0') {
    const bodyText = (input.body ?? '').trim()
    if (bodyText.length < 20) {
      throw new TaskIntakeContractError(
        'p0_justification_required',
        'P0 priority requires a detailed explanation of impact/urgency in task body (minimum 20 characters)',
      )
    }
  }

  // P1 Priority Discipline (Issue #1040 Phase 2):
  // P1 designates active Flight Blockers or urgent sprint milestones.
  // Gated rule: A task at priority P1 requires either:
  // 1. Direct linkage to a Project (input.project_id) or Parent Task (input.parent_task_id), OR
  // 2. Escape Hatch: Explicit named owner + review TTL stated in body/metadata (e.g. "[owner: @kasra, ttl: 7d]").
  if (input.priority === 'P1') {
    const hasLinkage = isNonEmptyString(input.project_id) || isNonEmptyString(input.parent_task_id)
    if (!hasLinkage) {
      const bodyText = input.body ?? ''
      const HATCH_RE = /\[owner:\s*@?[\w.-]+,\s*ttl:\s*\d+[dwmyh](?:,\s*re-review)?\]/i
      const hasEscapeHatch = HATCH_RE.test(bodyText)

      if (!hasEscapeHatch) {
        throw new TaskIntakeContractError(
          'p1_linkage_required',
          'P1 priority requires flight/project linkage (project_id or parent_task_id) or explicit escape hatch in body (e.g. "[owner: @name, ttl: 7d]")',
        )
      }
    }
  }
}

export interface TaskIntakeAuditResult {
  compliant: boolean
  code?: string
  reason?: string
}

/**
 * Pure, non-throwing evaluator for task intake compliance (Issue #1040 Phase 3).
 * Used by audit linters, sweepers, and dashboard inspectors to evaluate compliance
 * of existing tasks without throwing runtime errors.
 * Evaluates strictly by default (allowDeferredPredicate: false) so placeholder sentinels
 * are identified as non-compliant debt items.
 */
export function evaluateTaskIntakeContract(
  task: TaskIntakePayload,
  options: { allowDeferredPredicate?: boolean } = {},
): TaskIntakeAuditResult {
  try {
    assertValidIntakeContract(task, { allowDeferredPredicate: Boolean(options.allowDeferredPredicate) })
    return { compliant: true }
  } catch (err) {
    if (err instanceof TaskIntakeContractError) {
      return {
        compliant: false,
        code: err.code,
        reason: err.message,
      }
    }
    throw err
  }
}

export async function prepareGuardedTaskInsert(
  env: Env,
  input: CreateTaskInput,
  options: CreateTaskOptions = {},
): Promise<PreparedGuardedTaskInsert> {
  // Enforce Point-of-Capture Intake Contract before touching the DB.
  assertValidIntakeContract(input, { allowDeferredPredicate: options.allowDeferredPredicate })

  const projectId = input.project_id ?? null
  await validateTaskProjectAttribution(env, projectId, input.squad_id)

  const now = new Date().toISOString()
  // PROVENANCE NORMALIZATION (adversarial gate BLOCK, 2026-08-04). migrations/0077
  // defines the trust boundary as `external_source IS NULL` vs `IS NOT NULL`, but every
  // runtime check below expressed it with JavaScript truthiness. An empty string is
  // NON-NULL external provenance in the database and FALSY in JS, so the two layers
  // disagreed about the same row: SQL called it external, `externalSource ? ... : ...`
  // called it first-party. Passing `externalSource: ''` therefore produced a stored row
  // with external_source='' that KEPT its assignee and executed through to a model turn.
  //
  // Blank provenance is rejected rather than coerced. Silently mapping '' to null would
  // turn a caller's bug into trusted absence — the exact "absence means permission"
  // shape this whole audit set has been about — and silently mapping it to a marker
  // would invent provenance nobody supplied. A caller that has an external source knows
  // its name; one that does not should pass null explicitly.
  const rawExternalSource = options.externalSource
  if (rawExternalSource !== undefined && rawExternalSource !== null && isBlankProvenance(rawExternalSource)) {
    throw new Error(
      'createTask: externalSource must be a non-blank identifier or null — ' +
      'blank provenance is neither trusted-local nor attributable',
    )
  }
  const externalSource = rawExternalSource ?? null
  // CHOKE-POINT FIX (PR #659 P0, widened per kasra-core's parallel-audit finding on
  // src/integrations/github-projects.ts:239-251 — confirmed live on main): an
  // external-origin task must NEVER be created pre-assigned. Before this guard,
  // createTask happily accepted assignee_agent_id + an external marker together,
  // which is exactly the shape github-projects.ts used to auto-assign a task (title
  // sourced from an attacker-editable GitHub Project field) straight to a named agent
  // AND emit task.created -> dispatchSquad -> execution, with ZERO gate: not the
  // unassigned-auto-pickup check (#404/#659, N/A once assignee_agent_id is non-null
  // at creation) and not the admin-gated reassignment check (tasks/index.ts,
  // mcp/index.ts — those only fire on a LATER task_update/PATCH call, never on the
  // original createTask). Forcing assignee_agent_id to null here whenever an external
  // marker is present makes the ORIGINAL Linear invariant ("propose, never authorize")
  // structural for every current AND FUTURE external-integration caller, not just the
  // ones that happen to remember not to pass an assignee. An admin must still take the
  // explicit, admin-gated task_update/PATCH step (already required for any
  // source_pot/external_source-tagged task) before the task is assignable.
  //
  // Explicit null semantics, matching migrations/0077 exactly. Not truthiness: any
  // non-null value is external, including one the validation above would have rejected
  // but that reached here another way (a legacy row, a future caller, a direct write).
  // Fail closed on anything that is not literally absent.
  const assigneeAgentId = externalSource !== null ? null : (input.assignee_agent_id ?? null)
  // Self-Gate Deadlock Prevention (Issue #1030 / FLIGHT EXEC-02)
  if (await isSelfGatedConflict(env, input.gate_owner, assigneeAgentId)) {
    throw new TaskSelfGateError()
  }
  const task: Task = {
    id: options.id ?? crypto.randomUUID(),
    squad_id: input.squad_id,
    project_id: projectId,
    priority: input.priority ?? null,
    parent_task_id: input.parent_task_id ?? null,
    title: input.title.trim(),
    body: input.body ?? '',
    done_when: input.done_when.trim(),
    status: input.status ?? 'open',
    assignee_agent_id: assigneeAgentId,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: input.gate_owner ?? null,
    substitute_executor_id: null,
    fallback_reason: null,
    created_at: now,
    updated_at: now,
    external_source: externalSource,
  }

  const fence = options.routineRunFence
  const baseColumns = 'id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at'
  const baseValues: (string | number | boolean | null)[] = [
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
  ]
  // Keep optional legacy columns conditional so the common path remains compatible
  // with pinned test schemas that predate them.
  const extraColumns: string[] = []
  const extraValues: (string | number | boolean | null)[] = []
  if (externalSource !== null) { extraColumns.push('external_source'); extraValues.push(externalSource) }
  if (input.priority != null) { extraColumns.push('priority'); extraValues.push(input.priority) }
  if (input.parent_task_id != null) { extraColumns.push('parent_task_id'); extraValues.push(input.parent_task_id) }
  if (task.substitute_executor_id != null) { extraColumns.push('substitute_executor_id'); extraValues.push(task.substitute_executor_id) }
  if (task.fallback_reason != null) { extraColumns.push('fallback_reason'); extraValues.push(task.fallback_reason) }

  const columns = extraColumns.length > 0 ? `${baseColumns}, ${extraColumns.join(', ')}` : baseColumns
  const values = [...baseValues, ...extraValues]
  const placeholders = values.map(() => '?').join(', ')
  if (fence) {
    return Object.freeze({
      task,
      sql: `INSERT INTO tasks (${columns})
         SELECT ${placeholders}
          WHERE EXISTS (
            SELECT 1 FROM routine_runs rr
             WHERE rr.id = ? AND rr.tenant = ? AND rr.project_id = ?
               AND rr.status IN ('leased','observing')
               AND NOT EXISTS (
                 SELECT 1 FROM routine_run_events requested
                  WHERE requested.run_id = rr.id AND requested.tenant = rr.tenant
                    AND requested.kind = 'cancellation_requested'
               )
          )`,
      bindings: Object.freeze([...values, fence.runId, fence.tenant, task.project_id]),
    })
  }
  return Object.freeze({
    task,
    sql: `INSERT INTO tasks (${columns}) VALUES (${placeholders})`,
    bindings: Object.freeze(values),
  })
}

export async function createTask(
  env: Env,
  input: CreateTaskInput,
  options: CreateTaskOptions = {},
): Promise<Task> {
  const prepared = await prepareGuardedTaskInsert(env, input, options)
  const task = prepared.task
  const externalSource = task.external_source ?? null
  let taskInsert
  try {
    taskInsert = await env.DB.prepare(prepared.sql).bind(...prepared.bindings).run()
  } catch (error) {
    mapTaskProjectInsertError(error)
  }
  if (options.routineRunFence && (taskInsert?.meta?.changes ?? 0) === 0) {
    throw new TaskCreateFenceError()
  }
  // Receipt (#186): a 0-row INSERT resolves without throwing — verify the row
  // actually landed before we emit "created" and return the task as success.
  assertWritten(taskInsert, 'tasks.insert')

  // A task that ALREADY NAMES A HOME does not get a second one manufactured for it.
  //
  // mirrorTaskCreate resolves its destination from one tenant-wide GITHUB_REPO var, so
  // every mirror lands in the same repo regardless of where the work lives. That is not a
  // misconfiguration — there is no per-task repo input anywhere in this path, so the
  // bridge CANNOT target the right repo for cross-repo work. Measured 2026-08-14: 529
  // mumega-com issues carry the issueBody() footer (auto-mirrors); ZERO mupot-repo issues
  // do; 296/296 task github_issue_urls point at mumega-com. Capability and history agree.
  //
  // The damage is not the duplicate issue, it is that the duplicate is created with an
  // IDENTICAL title and body — which defeats dedup-by-search and leaves no signal about
  // which home is canonical. A finding filed by hand in the right repo then acquires a
  // second, indistinguishable home nobody asked for.
  //
  // So: an explicit provenance marker or a caller-supplied issue URL SUPPRESSES creation.
  // Until now `external_source` was persisted (migrations/0077) and gated assignability
  // (the trust boundary below), but neither mirror site read it — a caller could set it,
  // get no rejection, and change nothing about the behaviour they were trying to
  // influence. That is a field honored by one subsystem and invisible to another.
  //
  // NOTE THE COMPARISON: `externalSource === null`, not truthiness. Be precise about why,
  // because the honest version is weaker than it first looks. '' is NON-NULL external
  // provenance in SQL and FALSY in JS, and that exact split already shipped one live
  // defect here (#0077, adversarial gate BLOCK 2026-08-04). But blanks are REJECTED
  // upstream (see the normalization above), so by this line the value is only null or a
  // real identifier — and for those two, truthiness and `=== null` agree exactly.
  //
  // Verified, not assumed: mutating this to `!externalSource` leaves all four tests in
  // tests/task-bridge-external-source-suppression.test.ts GREEN. It is an EQUIVALENT
  // MUTANT today, not an unwitnessed line. The explicit null test is defence in depth
  // against the upstream rejection being relaxed later — if blanks ever reach here, the
  // two layers must not disagree about the same row. Keeping it costs nothing; claiming
  // it currently prevents a live bug would be false.
  //
  // This does NOT make the bridge repo-aware — that is the real fix and it changes where
  // issues land for every existing caller, so it gets a design pass, not a patch. This
  // only stops manufacturing homes for work that already has one.
  //
  // Deliberately NOT also testing `task.github_issue_url !== null` here: the task literal
  // above hardcodes `github_issue_url: null` and createTask exposes no input for it, so
  // that arm could never be true. A guard clause that cannot fire reads as protection
  // while providing none — the same "exemption justified by a case that cannot occur"
  // shape found in the #847 dashboard capability floor. If a caller-supplied issue URL is
  // ever wanted, it needs a real input on CreateTaskOptions, not a dead disjunct here.
  if (!options.skipMirror && externalSource === null) {
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

  if (!options.skipEvent) await emitTaskEvent(env, 'task.created', task, options.actor)
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

  // #399: like the UPDATEs below, this write's SET/INSERT never touches
  // squad_id/project_id, so 0061's narrowed trigger never fires for it. Re-check
  // before writing the verdict note (evidence-bearing, feeds
  // idx_task_verdicts_evidence_keyset) onto a project-attached task whose owning
  // squad may no longer hold write/admin on that project.
  if (!(await squadCanWriteProjectEvidence(env, input.task.project_id, input.task.squad_id))) {
    throw new TaskEvidenceFenceError(input.task.id)
  }

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

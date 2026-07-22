// mupot — per-project concierge (Module Kernel Leg 1: the always-on dispatcher).
//
// Design: docs/architecture/mupot-module-kernel.md § "Per-project concierge (the
// always-on dispatcher, CF-native)". Builds ON Port 1 (module_registry + presence,
// migration 0066, src/registry/service.ts, PR #457) — the concierge is itself a
// module: it registers as an agent_system module bound to its project, so it shows
// up `concierge: online` on that project's own roster.
//
// NOT a host process. This is a per-project loop driven by the mupot Worker cron
// (src/index.ts#scheduled), exactly like runLoopsTick (src/loops/driver.ts): CF
// runs it every heartbeat, so it is always-on by construction, zero idle cost,
// and cannot die the way a systemd process per project could (the VPS-liability
// anti-pattern the design doc calls out).
//
// Two layers, cleanly split (design doc): the concierge DECIDES, the shared host
// operator DRIVERS (cursor/claude/mumcp) EXECUTE what it dispatches. This file only
// ever creates a board task — it never runs build work itself.
//
// MVP: heuristic decision, no model call. `decide` is a pure function of the state
// this file reads (goal + roster + advancing-task check) so a Sol/Hermes escalation
// can replace it later without touching the register/read/dispatch plumbing — see
// the "model-seam for later" note on decideHeuristically().
//
// IDEMPOTENCY IS THE LAW (brain=ATC: rank, never act-loop). This is an MVP heuristic,
// not the goal-tracking Sol-brain — its job is to give a stalled project ONE nudge,
// never to keep re-dispatching toward the goal forever. So the invariant is
// dispatch-once-ever per project: once the concierge has ever created a starter task
// for a project, it never creates another one, no matter what happens to that task
// afterward (reworked, rejected, approved, done — none of it clears the "already
// nudged this project" fact). "Keep advancing the goal" is deliberately NOT this
// file's job.
//
// Two dedup layers enforce that:
//   1. hasConciergeStarter — ANY-STATUS existence check for a prior concierge-
//      originated task (CONCIERGE_STARTER_MARKER in the body) on this project. This is
//      the primary guard and it does not filter by status at all (see its own doc
//      comment for why enumerating statuses is exactly the bug class this fixes).
//   2. hasAdvancingTask — the pre-existing "does ANYONE (not just the concierge) have
//      live work on this project right now" check, kept for the separate case of a
//      human/other-automation task already in flight that the concierge should not
//      pile onto.
// Both run AFTER a dispatch decision would otherwise fire and BEFORE any task is
// created. A residual check-then-create race is closed at the DB layer by migration
// 0067's partial UNIQUE index on tasks(project_id) WHERE the marker is present — see
// isConciergeStarterUniqueViolation below.

import type { Env, Project } from '../types'
import { listProjects } from '../projects/service'
import { createTask, type CreateTaskInput } from '../tasks/service'
import type { Task } from '../types'
import { registerModule, listPresence, type ModulePresence, type RegistryResult } from '../registry/service'

/** Capability marker for "this roster entry can execute build work." The ONE place
 * that defines what counts as build-capable for dispatch purposes — extend here,
 * not at each call site, if a second capability should also qualify. */
export const BUILD_CAPABILITY = 'build'

/** Capabilities the concierge itself registers under. It is a dispatcher, never a
 * build target — CONCIERGE_IDENTITY_PREFIX + BUILD_CAPABILITY exclusion below is
 * what keeps it from ever selecting itself as the dispatch candidate even if a
 * future capability list drifts. */
const CONCIERGE_CAPABILITIES: readonly string[] = ['dispatch', 'concierge']

/** Task statuses that mean "someone (anyone) already has live work on this project
 * right now" — the secondary dedup guard, kept for the case of a human/other-
 * automation task already in flight. Matches the set src/projects/situation.ts
 * treats as active work (blocked/review/in_progress/open): a blocked task still
 * means someone is already engaged with the project, so it also counts as "not
 * idle capacity" and is included below.
 *
 * NOTE: this is deliberately NOT the guard against re-dispatching a concierge
 * starter — that was the P0 (adversarial gate, PR #459): a starter task that left
 * this "live" set (approved/rejected/done) while the project goal was still set
 * caused an unbounded re-dispatch loop, because nothing here ever re-checks
 * "did *I* already start this project." That guard is hasConciergeStarter below,
 * which intentionally does NOT filter by status at all — see its doc comment. */
const ADVANCING_STATUSES = ['open', 'in_progress', 'review', 'blocked'] as const

/** Sentinel embedded in the body of every task the concierge dispatches. This is the
 * ONLY thing that distinguishes a concierge-originated starter from any other task on
 * the board — the tasks table has no structured origin/kind/source column for
 * locally-created tasks (source_pot, migration 0063, is a *different* concept: NULL
 * vs. a linked-pot slug for cross-pot provenance, not "which local subsystem wrote
 * this row"). A body sentinel is the cheapest correct option that needs no schema
 * change to CreateTaskInput/tasks and is trivial to query with instr(). */
export const CONCIERGE_STARTER_MARKER = '[concierge-starter]'

/** Cap on projects driven per cron tick — mirrors loops/driver.ts's MAX_LOOPS_PER_TICK. */
export const MAX_PROJECTS_PER_TICK = 25

/** Fallback squad for a project that has no squad holding write/admin access yet.
 * Named per house style (single place defining the default). Mirrors the existing
 * 'squad-core' convention (src/channels/admin.ts's inbound-task default). */
export const DEFAULT_DISPATCH_SQUAD_ID = 'squad-core'

export function conciergeIdentity(projectId: string): string {
  return `concierge:${projectId}`
}

export type ConciergeNoopReason =
  | 'no_goal' // project.goal is empty — nothing to dispatch toward
  | 'no_online_builder' // no roster entry is online with BUILD_CAPABILITY and resolves to a real active agent
  | 'has_advancing_work' // an open/in_progress/review/blocked task already exists for this project
  | 'already_dispatched' // a concierge starter for this project already exists in ANY status (dispatch-once-ever), or a concurrent tick just created one (migration 0067 unique-index race loss)
  | 'error' // a read seam (roster / dedup check) failed; fail-closed to no-op, never dispatch on uncertain state

export type ConciergeDecision =
  | { action: 'dispatch'; agentId: string }
  | { action: 'noop'; reason: ConciergeNoopReason }

export interface ConciergeCycleResult {
  /** Whether this cycle's presence registration succeeded (best-effort; a failure
   * here never blocks the decide/dispatch step below — see runProjectConcierge). */
  registered: boolean
  decision: ConciergeDecision
  taskId: string | null
}

/** A minimal, resolved dispatch candidate — a roster identity that maps to a real,
 * active row in `agents` (so it can legally be tasks.assignee_agent_id, which is an
 * FK to agents(id)). Not every module_registry identity is an agent row (e.g. a
 * member-token principal never welded to an agent) — resolveAgent below is what
 * tells the two apart. */
export interface ResolvedAgent {
  id: string
  squad_id: string
  status: string
}

// ── Default I/O seams (real D1) ──────────────────────────────────────────────

async function defaultResolveAgent(env: Env, identity: string): Promise<ResolvedAgent | null> {
  return env.DB.prepare(`SELECT id, squad_id, status FROM agents WHERE id = ?1 LIMIT 1`)
    .bind(identity)
    .first<ResolvedAgent>()
}

async function defaultHasAdvancingTask(env: Env, projectId: string): Promise<boolean> {
  const placeholders = ADVANCING_STATUSES.map((_, i) => `?${i + 2}`).join(', ')
  const row = await env.DB.prepare(
    `SELECT 1 FROM tasks WHERE project_id = ?1 AND status IN (${placeholders}) LIMIT 1`,
  )
    .bind(projectId, ...ADVANCING_STATUSES)
    .first()
  return row !== null
}

/**
 * defaultHasConciergeStarter — "has the concierge EVER dispatched a starter task for
 * this project, in any status?" Deliberately does NOT filter by status at all (no
 * enumerated status list to keep in sync) — that is the exact bug class the P0 fixed:
 * ADVANCING_STATUSES enumerated only the "live" subset, so a starter that moved to
 * approved/rejected/done fell out of the check and got re-dispatched. Matching on the
 * body marker with no status predicate means a future status value (were one ever
 * added) cannot silently reopen the same hole — there is no list to forget to extend.
 */
async function defaultHasConciergeStarter(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM tasks WHERE project_id = ?1 AND instr(body, ?2) > 0 LIMIT 1`)
    .bind(projectId, CONCIERGE_STARTER_MARKER)
    .first()
  return row !== null
}

/**
 * isConciergeStarterUniqueViolation — true when `error` is the D1/SQLite constraint
 * failure from migration 0067's partial unique index (tasks(project_id) WHERE the
 * concierge-starter marker is present). This is the TOCTOU backstop: two overlapping
 * cron ticks for the same project can both pass the hasConciergeStarter read as "no
 * starter yet" before either writes; whichever INSERT lands second hits this
 * constraint instead of creating a duplicate row. The caller treats it exactly like
 * finding a prior starter on the read path — reason 'already_dispatched' — rather
 * than counting it as a tick error.
 */
function isConciergeStarterUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error
    && error.message.includes('UNIQUE constraint failed')
    && error.message.includes('tasks.project_id')
  )
}

async function defaultResolveDispatchSquad(env: Env, projectId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT squad_id FROM project_squad_access
      WHERE project_id = ?1 AND access_level IN ('write', 'admin')
      ORDER BY squad_id LIMIT 1`,
  )
    .bind(projectId)
    .first<{ squad_id: string }>()
  return row?.squad_id ?? DEFAULT_DISPATCH_SQUAD_ID
}

const defaultListProjects = (env: Env): Promise<Project[]> => listProjects(env, { status: 'active' })
const defaultListPresence = (env: Env, opts: { projectId?: string | null }): Promise<ModulePresence[]> =>
  listPresence(env, opts)

// ── Seams (all I/O injected — no D1, no model, in unit tests) ───────────────

export interface ConciergeDeps {
  listProjects?: (env: Env) => Promise<Project[]>
  listPresence?: (env: Env, opts: { projectId?: string | null }) => Promise<ModulePresence[]>
  hasAdvancingTask?: (env: Env, projectId: string) => Promise<boolean>
  hasConciergeStarter?: (env: Env, projectId: string) => Promise<boolean>
  resolveAgent?: (env: Env, identity: string) => Promise<ResolvedAgent | null>
  resolveDispatchSquad?: (env: Env, projectId: string) => Promise<string>
  createTask?: (env: Env, input: CreateTaskInput) => Promise<Task>
  registerPresence?: (
    env: Env,
    input: Parameters<typeof registerModule>[1],
    now?: Date,
  ) => Promise<RegistryResult<ModulePresence>>
  /** Injected clock — deterministic tests, matches src/registry/service.ts's own `now` seam. */
  now?: () => Date
}

/**
 * pickOnlineBuilder — scan a project's roster for the first entry that is online,
 * declares BUILD_CAPABILITY, is not the concierge itself, and resolves to a real
 * active `agents` row (the only thing that can legally be an assignee). Returns
 * null when no such candidate exists — the caller reports `no_online_builder`.
 */
async function pickOnlineBuilder(
  env: Env,
  roster: ModulePresence[],
  selfIdentity: string,
  resolveAgent: (env: Env, identity: string) => Promise<ResolvedAgent | null>,
): Promise<ResolvedAgent | null> {
  for (const module of roster) {
    if (module.identity === selfIdentity) continue
    if (module.status !== 'online') continue
    if (!module.capabilities.includes(BUILD_CAPABILITY)) continue
    const agent = await resolveAgent(env, module.identity)
    if (agent && agent.status === 'active') return agent
  }
  return null
}

/**
 * runProjectConcierge — one cycle for ONE project.
 *
 *  a. Register presence (best-effort; a failure here never blocks the rest of the
 *     cycle — the concierge showing offline for one tick is a display gap, not a
 *     dispatch-safety issue).
 *  b. Read state: goal, roster.
 *  c. Decide (heuristic, idempotent): non-empty goal AND an online build-capable
 *     agent AND no prior concierge starter for this project (any status) AND zero
 *     advancing tasks -> dispatch one starter task. Otherwise no-op.
 *  d. Dispatch: create the task via the existing createTask() path (never a raw
 *     INSERT) so every invariant it enforces (done_when required, project/squad
 *     attribution, GitHub mirror, task.created event) applies here too. The insert
 *     can itself fail closed on migration 0067's unique index (concurrent-tick race).
 */
export async function runProjectConcierge(
  env: Env,
  project: Project,
  deps: ConciergeDeps = {},
): Promise<ConciergeCycleResult> {
  const now = deps.now ?? (() => new Date())
  const registerPresence = deps.registerPresence ?? registerModule
  const listRoster = deps.listPresence ?? defaultListPresence
  const hasAdvancingTask = deps.hasAdvancingTask ?? defaultHasAdvancingTask
  const hasConciergeStarter = deps.hasConciergeStarter ?? defaultHasConciergeStarter
  const resolveAgent = deps.resolveAgent ?? defaultResolveAgent
  const resolveDispatchSquad = deps.resolveDispatchSquad ?? defaultResolveDispatchSquad
  const create = deps.createTask ?? createTask

  const identity = conciergeIdentity(project.id)

  // (a) Register presence — server-side/trusted write: the concierge IS the kernel
  // acting, so this calls registerModule directly rather than going through the MCP
  // presence_register tool (that tool's identity-derivation + project-read gate
  // exists for EXTERNAL callers; the kernel dispatching its own concierge is not one).
  let registered = false
  try {
    const result = await registerPresence(
      env,
      {
        identity,
        kind: 'agent_system',
        adapter: 'concierge',
        projectId: project.id,
        capabilities: [...CONCIERGE_CAPABILITIES],
      },
      now(),
    )
    registered = result.ok
  } catch {
    // Fail-soft: presence is a display concern, not a dispatch-safety one.
    registered = false
  }

  // (b/c) Decide — cheapest checks first so a stalled read never wastes a query.
  const goal = project.goal.trim()
  if (!goal) {
    return { registered, decision: { action: 'noop', reason: 'no_goal' }, taskId: null }
  }

  // Build DRIVERS are SHARED, not per-project — the standing operator's cursor/claude/
  // mumcp register presence in the shared pool (project_id = null), per the module-kernel
  // design ("decision is per-project + always-on; execution is shared"). So the dispatch
  // candidate set is the project-scoped roster UNION the shared build pool. Querying only
  // the project scope was why the concierge saw `no_online_builder` and NEVER dispatched
  // (the build agents are all project_id=null). The concierge's own per-project presence
  // (project-scoped, caps=[dispatch,concierge]) is excluded by selfIdentity + the
  // BUILD_CAPABILITY filter in pickOnlineBuilder, so unioning cannot make it pick itself.
  let roster: ModulePresence[]
  try {
    const [projectRoster, sharedRoster] = await Promise.all([
      listRoster(env, { projectId: project.id }),
      listRoster(env, { projectId: null }),
    ])
    roster = [...projectRoster, ...sharedRoster]
  } catch {
    return { registered, decision: { action: 'noop', reason: 'error' }, taskId: null }
  }

  const builder = await pickOnlineBuilder(env, roster, identity, resolveAgent)
  if (!builder) {
    return { registered, decision: { action: 'noop', reason: 'no_online_builder' }, taskId: null }
  }

  // Dispatch-once-ever (P0 fix, adversarial gate on PR #459): has the concierge EVER
  // dispatched a starter for this project, in ANY status? Checked before the "live
  // work" check below and independent of it — a starter that has gone
  // approved/rejected/done must NOT be re-dispatched just because it fell out of the
  // "advancing" set. See hasConciergeStarter's doc comment for why this has no status
  // filter at all.
  let alreadyDispatched: boolean
  try {
    alreadyDispatched = await hasConciergeStarter(env, project.id)
  } catch {
    return { registered, decision: { action: 'noop', reason: 'error' }, taskId: null }
  }
  if (alreadyDispatched) {
    return { registered, decision: { action: 'noop', reason: 'already_dispatched' }, taskId: null }
  }

  let advancing: boolean
  try {
    advancing = await hasAdvancingTask(env, project.id)
  } catch {
    // Fail-closed: if we can't verify the board is empty, never dispatch on
    // uncertain state — a missed dispatch this tick self-corrects next tick; a
    // duplicate dispatch does not.
    return { registered, decision: { action: 'noop', reason: 'error' }, taskId: null }
  }
  if (advancing) {
    return { registered, decision: { action: 'noop', reason: 'has_advancing_work' }, taskId: null }
  }

  // (d) Dispatch — exactly one starter task, through the canonical createTask() path.
  // The body carries CONCIERGE_STARTER_MARKER so future cycles' hasConciergeStarter
  // check (and migration 0067's unique index) can recognize this row as "already
  // nudged this project" for the rest of its life, regardless of status.
  const squadId = await resolveDispatchSquad(env, project.id)
  let task: Task
  try {
    task = await create(env, {
      squad_id: squadId,
      project_id: project.id,
      title: `Starter: ${project.name}`,
      body: `Concierge dispatch (MVP heuristic) — project has capacity and no active work.\n\nProject goal: ${goal}\n\n${CONCIERGE_STARTER_MARKER}`,
      done_when: `Progress made toward the project goal: ${goal}`,
      assignee_agent_id: builder.id,
      gate_owner: 'gate:kasra-core',
      status: 'open',
    })
  } catch (error) {
    // TOCTOU backstop (P1 fix): a concurrent tick raced us between the
    // hasConciergeStarter read above and this INSERT and won — migration 0067's
    // partial unique index refuses the second row at the DB layer. Treat exactly
    // like finding a prior starter on the read path; do not let it surface as a
    // sweep error (runConciergeTick would otherwise count a benign race as a
    // broken project).
    if (isConciergeStarterUniqueViolation(error)) {
      return { registered, decision: { action: 'noop', reason: 'already_dispatched' }, taskId: null }
    }
    throw error
  }

  return { registered, decision: { action: 'dispatch', agentId: builder.id }, taskId: task.id }
}

export interface ConciergeTickResult {
  ok: boolean
  projects: number
  registered: number
  dispatched: number
  noop: number
  errors: number
}

/**
 * runConciergeTick — iterate active projects (capped, best-effort) and run one
 * concierge cycle for each. Mirrors runLoopsTick's fan-out contract: a failed
 * project listing degrades to {ok:false}; a single project's cycle throwing is
 * caught and counted, never aborting the sweep — one broken project must not take
 * down every other project's concierge.
 */
export async function runConciergeTick(env: Env, deps: ConciergeDeps = {}): Promise<ConciergeTickResult> {
  const list = deps.listProjects ?? defaultListProjects

  let projects: Project[]
  try {
    projects = await list(env)
  } catch {
    return { ok: false, projects: 0, registered: 0, dispatched: 0, noop: 0, errors: 0 }
  }

  const batch = projects.slice(0, MAX_PROJECTS_PER_TICK)
  let registered = 0
  let dispatched = 0
  let noop = 0
  let errors = 0

  for (const project of batch) {
    try {
      const result = await runProjectConcierge(env, project, deps)
      if (result.registered) registered++
      if (result.decision.action === 'dispatch') dispatched++
      else noop++
    } catch {
      errors++ // one bad project cycle must not stop the rest of the sweep
    }
  }

  return { ok: true, projects: batch.length, registered, dispatched, noop, errors }
}

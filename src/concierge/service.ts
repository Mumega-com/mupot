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
// IDEMPOTENCY IS THE LAW (brain=ATC: rank, never act-loop). The dedup check
// (hasAdvancingTask) runs AFTER a dispatch decision would otherwise fire and BEFORE
// any task is created — a project with any open/in_progress/review task never gets
// a second starter task. Same state in -> same decision out -> no duplicate
// dispatch, no matter how many times the cron tick calls this per heartbeat.

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

/** Task statuses that mean "the project already has advancing work" — the dedup
 * guard behind the anti-spam invariant. Matches the set src/projects/situation.ts
 * treats as active work (blocked/review/in_progress/open) minus 'blocked': a
 * blocked task still means someone is already engaged with the project, so it also
 * counts as "not idle capacity" and is included below. */
const ADVANCING_STATUSES = ['open', 'in_progress', 'review', 'blocked'] as const

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
 *     agent AND zero advancing tasks -> dispatch one starter task. Otherwise no-op.
 *  d. Dispatch: create the task via the existing createTask() path (never a raw
 *     INSERT) so every invariant it enforces (done_when required, project/squad
 *     attribution, GitHub mirror, task.created event) applies here too.
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

  let roster: ModulePresence[]
  try {
    roster = await listRoster(env, { projectId: project.id })
  } catch {
    return { registered, decision: { action: 'noop', reason: 'error' }, taskId: null }
  }

  const builder = await pickOnlineBuilder(env, roster, identity, resolveAgent)
  if (!builder) {
    return { registered, decision: { action: 'noop', reason: 'no_online_builder' }, taskId: null }
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
  const squadId = await resolveDispatchSquad(env, project.id)
  const task = await create(env, {
    squad_id: squadId,
    project_id: project.id,
    title: `Starter: ${project.name}`,
    body: `Concierge dispatch (MVP heuristic) — project has capacity and no active work.\n\nProject goal: ${goal}`,
    done_when: `Progress made toward the project goal: ${goal}`,
    assignee_agent_id: builder.id,
    gate_owner: 'gate:kasra-core',
    status: 'open',
  })

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

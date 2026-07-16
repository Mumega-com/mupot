// mupot — task ranking (#22 v1: "Brain = ATC — gate-keep flights like airport
// control"). Scope: mupot-INTERNAL task-list ordering only, NOT the broader
// cross-repo orchestration story #22 also names. The concrete gap: task_list
// surfaces (the dashboard GET /api/tasks route in src/tasks/index.ts, and the
// agent-facing MCP `task_list` tool in src/mcp/index.ts) both did pure
// `ORDER BY created_at DESC` — recency, zero prioritization. An agent or human
// scanning the list had no signal for "work this one first."
//
// This module is the pure scoring core. It takes ZERO I/O — no env.DB, no
// fetch, nothing — so it is fully unit-testable without a database. The two
// call sites (src/tasks/index.ts, src/mcp/index.ts) do the D1 reads (task rows
// + agent runtime states) and hand the plain arrays/maps in here.
//
// No schema migration: every signal used below already exists on the `tasks`
// row (status, created_at, assignee_agent_id) or comes from the existing
// radar classifier (dashboard/observatory.ts loadAgentRuntimeStates) — no new
// column, no new table.

import type { Task } from '../types'
import type { AgentRuntimeState } from '../dashboard/observatory'

// A ranked task = the original row plus one derived signal. We never hide or
// mutate the underlying task — we ANNOTATE it, so a caller (dashboard render,
// agent picking up work) can show "needs reassignment" instead of the task
// silently sitting assigned-but-abandoned to a dead agent.
export interface RankedTask extends Task {
  // true when assignee_agent_id is set AND the assignee's radar runtime_state
  // is anything other than 'live' — see rankTasks doc comment for the full
  // reasoning. Always false when the task is unassigned (nothing to flag).
  stale_assignee: boolean
}

// ── status → priority band ───────────────────────────────────────────────────
//
// Only statuses that represent ACTIONABLE-OR-BLOCKED work participate in
// ranking. Lower band number = worked first.
//
//   0. in_progress — an agent already has hands on it. Finishing what's
//      started beats picking up something new: context-switching mid-task
//      costs more than the small delay of clearing it first, and it caps
//      partial-work sprawl (many things half-done, nothing shipped).
//   1. open — ready to start, unclaimed.
//   2. blocked — cannot be worked right now (waiting on something external).
//      It stays in the ranked output (so it is never silently forgotten —
//      that's a job for whoever clears the blocker), but it always sorts
//      below anything actually workable today. Surfacing a blocked task
//      above open/in_progress work would waste attention on something
//      nobody can act on yet.
//
// Any status NOT in this table (done, review, approved, rejected) is a
// terminal or gate-pipeline state, not "what should I work on next" — see
// excludeFromRanking below.
const STATUS_BAND: Readonly<Record<string, number>> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
}

// True for any task status rankTasks does not score (done + the gate states
// review/approved/rejected). Exported so both call sites can reason about the
// same rule rankTasks uses internally, rather than re-deriving it.
//
// IMPORTANT: rankTasks does NOT drop these tasks from its output — dropping
// would silently break any caller that today sees the full unfiltered list
// (e.g. a "show everything" dashboard view). They are appended after the
// ranked tasks, in whatever order they arrived in (untouched, unscored) —
// "excluded entirely" means excluded from SCORING, not from the response.
export function excludeFromRanking(status: Task['status']): boolean {
  return !(status in STATUS_BAND)
}

/**
 * Pure ranking of tasks for the ATC "what should be worked next" surface.
 *
 * Tie-break order (most-significant first), applied only within the ranked
 * (in_progress/open/blocked) subset:
 *   1. status band — in_progress (0) < open (1) < blocked (2).
 *   2. created_at ASCENDING (older first) — anti-starvation/fairness: a task
 *      filed last week must not rot forever behind a stream of freshly filed
 *      ones. Applied WITHIN a band, never across bands — an old blocked task
 *      never jumps ahead of a fresh open one, because it still can't be
 *      worked. (Judgment call: the spec text only calls out staleness
 *      ordering for open/in_progress explicitly; blocked gets the same rule
 *      for consistency — one global tie-break, not a special case — but
 *      it's moot in practice since blocked is always last regardless of age.)
 *   3. id ASCENDING — deterministic final tie-break when created_at collides
 *      (same-millisecond creation), so output order is reproducible.
 *
 * stale_assignee: true when assignee_agent_id is set AND agentStates does not
 * map it to 'live'. This deliberately covers FOUR cases the same way:
 * 'stale', 'offline', 'unattached' (the radar's three non-live states) and
 * "agentStates has no entry for this id at all" (unknown — e.g. the agent
 * row was deleted, or the caller's radar snapshot is narrower than the task
 * set). An unknown agent is exactly as untrustworthy as one the radar knows
 * is dead — both mean "do not assume this is actually being worked" — so
 * both flag true. false when the task is unassigned, or the assignee IS
 * 'live'.
 *
 * Never drops a task, never duplicates one: every input task appears exactly
 * once in the output, either in the ranked (scored + sorted) prefix or the
 * passthrough (unscored, original relative order) suffix. See
 * excludeFromRanking for which bucket a given status lands in.
 *
 * No I/O. Does not mutate the input array or its elements (returns new
 * objects/array).
 */
export function rankTasks(
  tasks: readonly Task[],
  agentStates: ReadonlyMap<string, AgentRuntimeState>,
): RankedTask[] {
  const withStaleFlag = (t: Task): RankedTask => ({
    ...t,
    stale_assignee:
      t.assignee_agent_id !== null && agentStates.get(t.assignee_agent_id) !== 'live',
  })

  const ranked: RankedTask[] = []
  const passthrough: RankedTask[] = []
  for (const t of tasks) {
    ;(excludeFromRanking(t.status) ? passthrough : ranked).push(withStaleFlag(t))
  }

  ranked.sort((a, b) => {
    const bandDiff = STATUS_BAND[a.status] - STATUS_BAND[b.status]
    if (bandDiff !== 0) return bandDiff
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })

  return [...ranked, ...passthrough]
}

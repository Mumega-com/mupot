/**
 * Governed autonomous priority engine.
 *
 * Builds on existing ATC ranking (`src/tasks/ranking.ts`) and authoritative
 * Mupot task/project/presence/budget/gate facts. It does not introduce a
 * parallel work queue. Default mode is dry-run propose. Canary may dispatch
 * exactly one proven-active non-production task through an injected callback.
 *
 * This module is not auto-wired into MCP, routines, or production dispatch.
 * `snapshot.actor` must be the authenticated session principal supplied by a
 * future live caller — the engine never invents or overrides it.
 */
import { PRIORITY_RANK, rankTasks } from '../tasks/ranking'
import { isDoneWhenValid, isPlaceholderDoneWhen } from '../tasks/service'
import type { AgentRuntimeState } from '../dashboard/observatory'
import type { ProjectStatus, Task } from '../types'

export type EngineMode = 'propose' | 'canary'

export interface EngineProject {
  id: string
  status: ProjectStatus
  production: boolean
}

export interface EngineAgent {
  id: string
  status: 'active' | 'paused' | 'inactive'
  compatible: boolean
  in_progress_count: number
}

export interface EngineBudget {
  remaining_micro_usd: number
  selected_cost_micro_usd: number
}

export interface EngineControl {
  paused: boolean
  killed: boolean
}

export interface EngineSnapshot {
  tasks: readonly Task[]
  projects: ReadonlyMap<string, EngineProject>
  agentStates: ReadonlyMap<string, AgentRuntimeState>
  agents: readonly EngineAgent[]
  budget: EngineBudget
  actor: string
}

export type ExclusionReason =
  | 'engine_killed'
  | 'engine_paused'
  | 'status_not_open'
  | 'missing_done_when'
  | 'placeholder_done_when'
  | 'unresolved_dependency'
  | 'human_gate'
  | 'unsafe_side_effect'
  | 'project_archived_or_paused'
  | 'missing_or_inactive_project'
  | 'member_owned'
  | 'stale_or_incompatible_agent'
  | 'over_budget'
  | 'contradictory_telemetry'
  | 'no_live_compatible_agent'
  | 'production_or_unproven_scope'
  | 'idempotency_in_flight'
  | 'dispatch_failed'

export interface ScoreComponents {
  status_band: number
  priority_rank: number
  created_at: string
  id: string
}

export interface ExclusionRecord {
  task_id: string
  reason: ExclusionReason
}

export interface DecisionReceipt {
  mode: EngineMode
  actor: string
  idempotency_key: string
  cas_key: string
  paused: boolean
  killed: boolean
  candidates: string[]
  exclusions: ExclusionRecord[]
  score_components: Record<string, ScoreComponents>
  selected_task_id: string | null
  selected_agent_id: string | null
  budget: EngineBudget
  dispatch: { attempted: boolean, receipt_id: string | null }
  result: 'proposed' | 'dispatched' | 'none' | 'refused' | 'failed'
  gate: 'athena_required'
  learning: { selected: boolean, exclusion_count: number }
  created_at: string
}

export type BeginResult =
  | { status: 'acquired' }
  | { status: 'existing', receipt: DecisionReceipt }
  | { status: 'in_flight' }

export interface TickStore {
  get(idempotencyKey: string): Promise<DecisionReceipt | undefined> | DecisionReceipt | undefined
  begin(idempotencyKey: string): Promise<BeginResult> | BeginResult
  claim(taskId: string, idempotencyKey: string): Promise<boolean> | boolean
  releaseClaim(taskId: string, idempotencyKey: string): Promise<void> | void
  put(receipt: DecisionReceipt): Promise<void> | void
}

export class MemoryTickStore implements TickStore {
  private readonly byKey = new Map<string, DecisionReceipt>()
  private readonly reserved = new Set<string>()
  private readonly claimed = new Map<string, string>()

  get(idempotencyKey: string): DecisionReceipt | undefined {
    return this.byKey.get(idempotencyKey)
  }

  begin(idempotencyKey: string): BeginResult {
    const existing = this.byKey.get(idempotencyKey)
    if (existing) return { status: 'existing', receipt: existing }
    if (this.reserved.has(idempotencyKey)) return { status: 'in_flight' }
    this.reserved.add(idempotencyKey)
    return { status: 'acquired' }
  }

  claim(taskId: string, idempotencyKey: string): boolean {
    const existing = this.claimed.get(taskId)
    if (existing !== undefined && existing !== idempotencyKey) return false
    this.claimed.set(taskId, idempotencyKey)
    return true
  }

  releaseClaim(taskId: string, idempotencyKey: string): void {
    if (this.claimed.get(taskId) === idempotencyKey) this.claimed.delete(taskId)
  }

  put(receipt: DecisionReceipt): void {
    if (this.byKey.has(receipt.idempotency_key)) return
    this.byKey.set(receipt.idempotency_key, receipt)
  }
}

const UNSAFE_RE = /\b(merge|deploy|restart|credential|payment|destructive|mint|grant|revoke|production enablement|wrangler deploy)\b/i
const HUMAN_GATE_RE = /(gate:hadi|human-wait|human_gate|human-gated)/i

function taskText(task: Task): string {
  return `${task.title}\n${task.body}\n${task.done_when}`
}

export function isHumanGated(task: Task): boolean {
  const gate = task.gate_owner ?? ''
  return HUMAN_GATE_RE.test(gate) || HUMAN_GATE_RE.test(taskText(task))
}

export function isUnsafeSideEffect(task: Task): boolean {
  return UNSAFE_RE.test(taskText(task))
}

export function isProvenNonProduction(project: EngineProject | undefined): boolean {
  return Boolean(project && project.status === 'active' && project.production === false)
}

function agentIsHonorable(agent: EngineAgent | undefined, state: AgentRuntimeState | undefined): boolean {
  return state === 'live' && Boolean(agent && agent.compatible && agent.status === 'active')
}

export function excludeTask(
  task: Task,
  snapshot: EngineSnapshot,
): ExclusionReason | null {
  if (task.status !== 'open') return 'status_not_open'
  if (task.assignee_member_id) return 'member_owned'
  if (!isDoneWhenValid(task.done_when)) return 'missing_done_when'
  if (isPlaceholderDoneWhen(task.done_when)) return 'placeholder_done_when'
  if (task.parent_task_id) {
    const parent = snapshot.tasks.find((row) => row.id === task.parent_task_id)
    if (!parent || (parent.status !== 'done' && parent.status !== 'approved')) {
      return 'unresolved_dependency'
    }
  }
  if (isHumanGated(task)) return 'human_gate'
  if (isUnsafeSideEffect(task)) return 'unsafe_side_effect'
  if (!task.project_id) return 'missing_or_inactive_project'
  const project = snapshot.projects.get(task.project_id)
  if (!project) return 'contradictory_telemetry'
  if (project.status === 'archived' || project.status === 'paused') {
    return 'project_archived_or_paused'
  }
  if (project.status !== 'active') return 'missing_or_inactive_project'
  if (task.assignee_agent_id) {
    const state = snapshot.agentStates.get(task.assignee_agent_id)
    const agent = snapshot.agents.find((row) => row.id === task.assignee_agent_id)
    if (!agentIsHonorable(agent, state)) return 'stale_or_incompatible_agent'
  }
  if (snapshot.budget.selected_cost_micro_usd > snapshot.budget.remaining_micro_usd) {
    return 'over_budget'
  }
  if (task.execution_receipt_id && task.status === 'open') {
    return 'contradictory_telemetry'
  }
  return null
}

function pickUnassignedAgent(snapshot: EngineSnapshot): string | null {
  const live = snapshot.agents.filter((agent) => (
    agent.status === 'active'
    && agent.compatible
    && agent.in_progress_count === 0
    && snapshot.agentStates.get(agent.id) === 'live'
  ))
  live.sort((a, b) => a.id.localeCompare(b.id))
  return live[0]?.id ?? null
}

export function resolveSelectedAgent(task: Task, snapshot: EngineSnapshot): string | null {
  if (task.assignee_agent_id) {
    const agent = snapshot.agents.find((row) => row.id === task.assignee_agent_id)
    const state = snapshot.agentStates.get(task.assignee_agent_id)
    return agentIsHonorable(agent, state) ? task.assignee_agent_id : null
  }
  return pickUnassignedAgent(snapshot)
}

function score(task: Task): ScoreComponents {
  return {
    status_band: task.status === 'open' ? 1 : 99,
    priority_rank: PRIORITY_RANK[task.priority ?? 'untriaged'] ?? 4,
    created_at: task.created_at,
    id: task.id,
  }
}

export function propose(snapshot: EngineSnapshot, control: EngineControl): Omit<DecisionReceipt, 'idempotency_key' | 'cas_key' | 'actor' | 'created_at' | 'mode'> & {
  eligible: Task[]
} {
  const exclusions: ExclusionRecord[] = []
  const eligible: Task[] = []
  if (control.killed) {
    return {
      paused: control.paused,
      killed: true,
      candidates: [],
      exclusions: snapshot.tasks.map((task) => ({ task_id: task.id, reason: 'engine_killed' })),
      score_components: {},
      selected_task_id: null,
      selected_agent_id: null,
      budget: snapshot.budget,
      dispatch: { attempted: false, receipt_id: null },
      result: 'refused',
      gate: 'athena_required',
      learning: { selected: false, exclusion_count: snapshot.tasks.length },
      eligible: [],
    }
  }
  if (control.paused) {
    return {
      paused: true,
      killed: false,
      candidates: [],
      exclusions: snapshot.tasks.map((task) => ({ task_id: task.id, reason: 'engine_paused' })),
      score_components: {},
      selected_task_id: null,
      selected_agent_id: null,
      budget: snapshot.budget,
      dispatch: { attempted: false, receipt_id: null },
      result: 'refused',
      gate: 'athena_required',
      learning: { selected: false, exclusion_count: snapshot.tasks.length },
      eligible: [],
    }
  }

  for (const task of snapshot.tasks) {
    const reason = excludeTask(task, snapshot)
    if (reason) exclusions.push({ task_id: task.id, reason })
    else eligible.push(task)
  }

  const ranked = rankTasks(eligible, snapshot.agentStates).filter((task) => task.status === 'open')
  const selected = ranked[0] ?? null
  const agentId = selected ? resolveSelectedAgent(selected, snapshot) : null
  if (selected && !agentId) {
    exclusions.push({ task_id: selected.id, reason: 'no_live_compatible_agent' })
  }

  const score_components: Record<string, ScoreComponents> = {}
  for (const task of eligible) score_components[task.id] = score(task)

  return {
    paused: false,
    killed: false,
    candidates: ranked.map((task) => task.id),
    exclusions,
    score_components,
    selected_task_id: selected && agentId ? selected.id : null,
    selected_agent_id: agentId && selected ? agentId : null,
    budget: snapshot.budget,
    dispatch: { attempted: false, receipt_id: null },
    result: selected && agentId ? 'proposed' : 'none',
    gate: 'athena_required',
    learning: {
      selected: Boolean(selected && agentId),
      exclusion_count: exclusions.length,
    },
    eligible,
  }
}

function emptyRefused(input: {
  snapshot: EngineSnapshot
  control: EngineControl
  mode: EngineMode
  idempotency_key: string
  created_at: string
  reason: ExclusionReason
}): DecisionReceipt {
  return {
    mode: input.mode,
    actor: input.snapshot.actor,
    idempotency_key: input.idempotency_key,
    cas_key: `${input.idempotency_key}:none`,
    paused: input.control.paused,
    killed: input.control.killed,
    candidates: [],
    exclusions: [{ task_id: 'none', reason: input.reason }],
    score_components: {},
    selected_task_id: null,
    selected_agent_id: null,
    budget: input.snapshot.budget,
    dispatch: { attempted: false, receipt_id: null },
    result: 'refused',
    gate: 'athena_required',
    learning: { selected: false, exclusion_count: 1 },
    created_at: input.created_at,
  }
}

export async function tick(input: {
  store: TickStore
  snapshot: EngineSnapshot
  control: EngineControl
  mode: EngineMode
  idempotency_key: string
  now?: string
  dispatch?: (taskId: string, agentId: string) => Promise<string>
}): Promise<DecisionReceipt> {
  if (!input.snapshot.actor.trim()) {
    throw new Error('priority_engine_actor_unavailable')
  }
  const created_at = input.now ?? new Date().toISOString()
  const began = await input.store.begin(input.idempotency_key)
  if (began.status === 'existing') return began.receipt
  if (began.status === 'in_flight') {
    return emptyRefused({
      snapshot: input.snapshot,
      control: input.control,
      mode: input.mode,
      idempotency_key: input.idempotency_key,
      created_at,
      reason: 'idempotency_in_flight',
    })
  }

  const proposed = propose(input.snapshot, input.control)
  const cas_key = `${input.idempotency_key}:${proposed.selected_task_id ?? 'none'}`
  let receipt: DecisionReceipt = {
    mode: input.mode,
    actor: input.snapshot.actor,
    idempotency_key: input.idempotency_key,
    cas_key,
    paused: proposed.paused,
    killed: proposed.killed,
    candidates: proposed.candidates,
    exclusions: proposed.exclusions,
    score_components: proposed.score_components,
    selected_task_id: proposed.selected_task_id,
    selected_agent_id: proposed.selected_agent_id,
    budget: proposed.budget,
    dispatch: { attempted: false, receipt_id: null },
    result: proposed.result,
    gate: 'athena_required',
    learning: proposed.learning,
    created_at,
  }

  if (receipt.selected_task_id) {
    if (!await input.store.claim(receipt.selected_task_id, input.idempotency_key)) {
      receipt = {
        ...receipt,
        selected_task_id: null,
        selected_agent_id: null,
        dispatch: { attempted: false, receipt_id: null },
        result: 'refused',
        learning: { selected: false, exclusion_count: receipt.exclusions.length + 1 },
        exclusions: [
          ...receipt.exclusions,
          { task_id: proposed.selected_task_id!, reason: 'contradictory_telemetry' },
        ],
      }
    } else if (input.mode === 'canary' && receipt.selected_agent_id) {
      const selected = input.snapshot.tasks.find((task) => task.id === receipt.selected_task_id)
      const project = selected?.project_id ? input.snapshot.projects.get(selected.project_id) : undefined
      if (!isProvenNonProduction(project)) {
        await input.store.releaseClaim(receipt.selected_task_id, input.idempotency_key)
        receipt = {
          ...receipt,
          selected_task_id: null,
          selected_agent_id: null,
          dispatch: { attempted: false, receipt_id: null },
          result: 'refused',
          exclusions: [
            ...receipt.exclusions,
            { task_id: proposed.selected_task_id!, reason: 'production_or_unproven_scope' },
          ],
          learning: { selected: false, exclusion_count: receipt.exclusions.length + 1 },
        }
      } else if (input.dispatch) {
        const claimedTaskId = receipt.selected_task_id
        const claimedAgentId = receipt.selected_agent_id
        try {
          const dispatchId = await input.dispatch(claimedTaskId, claimedAgentId)
          receipt = {
            ...receipt,
            dispatch: { attempted: true, receipt_id: dispatchId },
            result: 'dispatched',
          }
        } catch {
          await input.store.releaseClaim(claimedTaskId, input.idempotency_key)
          receipt = {
            ...receipt,
            selected_task_id: null,
            selected_agent_id: null,
            dispatch: { attempted: true, receipt_id: null },
            result: 'failed',
            exclusions: [
              ...receipt.exclusions,
              { task_id: proposed.selected_task_id!, reason: 'dispatch_failed' },
            ],
            learning: { selected: false, exclusion_count: receipt.exclusions.length + 1 },
          }
        }
      }
    }
  }

  const raced = await input.store.get(input.idempotency_key)
  if (raced) return raced
  await input.store.put(receipt)
  return receipt
}

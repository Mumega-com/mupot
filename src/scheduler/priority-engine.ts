/**
 * Governed autonomous priority engine.
 *
 * Builds on existing ATC ranking (`src/tasks/ranking.ts`) and authoritative
 * Mupot task/project/presence/budget/gate facts. It does not introduce a
 * parallel work queue. Default mode is dry-run propose. Canary may dispatch
 * exactly one non-production task through an injected callback — never live
 * merge/deploy/credential/payment/destructive work.
 *
 * This module is not auto-wired into MCP, routines, or production dispatch.
 * `snapshot.actor` must be the authenticated session principal supplied by a
 * future live caller — the engine never invents or overrides it. Durable CAS
 * belongs at the D1/DO claim layer; MemoryTickStore is the in-memory contract.
 */
import { rankTasks } from '../tasks/ranking'
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
  | 'stale_or_incompatible_agent'
  | 'over_budget'
  | 'contradictory_telemetry'
  | 'no_live_compatible_agent'

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
  result: 'proposed' | 'dispatched' | 'none' | 'refused'
  gate: 'athena_required'
  learning: { selected: boolean, exclusion_count: number }
  created_at: string
}

export interface TickStore {
  get(idempotencyKey: string): DecisionReceipt | undefined
  claim(taskId: string, idempotencyKey: string): boolean
  put(receipt: DecisionReceipt): void
}

export class MemoryTickStore implements TickStore {
  private readonly byKey = new Map<string, DecisionReceipt>()
  private readonly claimed = new Map<string, string>()

  get(idempotencyKey: string): DecisionReceipt | undefined {
    return this.byKey.get(idempotencyKey)
  }

  claim(taskId: string, idempotencyKey: string): boolean {
    const existing = this.claimed.get(taskId)
    if (existing !== undefined && existing !== idempotencyKey) return false
    this.claimed.set(taskId, idempotencyKey)
    return true
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

export function excludeTask(
  task: Task,
  snapshot: EngineSnapshot,
): ExclusionReason | null {
  if (task.status !== 'open') return 'status_not_open'
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
  if (task.project_id) {
    const project = snapshot.projects.get(task.project_id)
    if (!project) return 'contradictory_telemetry'
    if (project.status === 'archived' || project.status === 'paused') {
      return 'project_archived_or_paused'
    }
  }
  if (task.assignee_agent_id) {
    const state = snapshot.agentStates.get(task.assignee_agent_id)
    const agent = snapshot.agents.find((row) => row.id === task.assignee_agent_id)
    if (state !== 'live' || !agent || !agent.compatible || agent.status !== 'active') {
      return 'stale_or_incompatible_agent'
    }
  }
  if (snapshot.budget.selected_cost_micro_usd > snapshot.budget.remaining_micro_usd) {
    return 'over_budget'
  }
  if (task.execution_receipt_id && task.status === 'open') {
    return 'contradictory_telemetry'
  }
  return null
}

function pickAgent(snapshot: EngineSnapshot): string | null {
  const live = snapshot.agents.filter((agent) => (
    agent.status === 'active'
    && agent.compatible
    && agent.in_progress_count === 0
    && snapshot.agentStates.get(agent.id) === 'live'
  ))
  live.sort((a, b) => a.id.localeCompare(b.id))
  return live[0]?.id ?? null
}

function score(task: Task): ScoreComponents {
  const priority_rank = ({ P0: 0, P1: 1, P2: 2, P3: 3 } as const)[task.priority ?? 'P3'] ?? 4
  return {
    status_band: task.status === 'open' ? 1 : 99,
    priority_rank,
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
  const agentId = selected ? pickAgent(snapshot) : null
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
  const existing = input.store.get(input.idempotency_key)
  if (existing) return existing

  const proposed = propose(input.snapshot, input.control)
  const created_at = input.now ?? new Date().toISOString()
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
    if (!input.store.claim(receipt.selected_task_id, input.idempotency_key)) {
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
      if (project?.production) {
        receipt = {
          ...receipt,
          dispatch: { attempted: false, receipt_id: null },
          result: 'proposed',
        }
      } else if (input.dispatch) {
        const dispatchId = await input.dispatch(receipt.selected_task_id, receipt.selected_agent_id)
        receipt = {
          ...receipt,
          dispatch: { attempted: true, receipt_id: dispatchId },
          result: 'dispatched',
        }
      }
    }
  }

  const raced = input.store.get(input.idempotency_key)
  if (raced) return raced
  input.store.put(receipt)
  return receipt
}

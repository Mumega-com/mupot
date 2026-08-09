// mupot — Tier-2 stateless per-user chat contract (pure).
//
// Design: docs/superpowers/specs/2026-07-27-tier2-stateless-user-chat-design.md
// Machine contract: docs/tier2-user-chat-v1.json
//
// Design/spec commit only — no HTTP route, no D1 migration, no model call.
// These pure helpers lock the invariants so build slices cannot quietly
// reintroduce a Hermes-server-per-user (#505 Tier-1 pattern) for every member.

/** Marker prefix embedded in board tasks spawned from a Tier-2 chat turn. */
export const TIER2_CHAT_MARKER_PREFIX = '[tier2-chat:'

/** Pipeline steps in order. Cognition may run only after budgetGate. */
export const TIER2_TURN_PIPELINE = [
  'authorize',
  'loadContext',
  'budgetGate',
  'modelTurn',
  'dispatchTools',
  'persist',
  'respond',
] as const

export type Tier2TurnStep = (typeof TIER2_TURN_PIPELINE)[number]

/** Tools a Tier-2 turn may invoke. Board dispatch + reads only. */
export const TIER2_ALLOWED_TOOLS = [
  'task_create',
  'task_list',
  'task_get',
  'project_recall',
  'project_context',
  'project_remember',
] as const

export type Tier2AllowedTool = (typeof TIER2_ALLOWED_TOOLS)[number]

/** Tools that must never be exposed to a Tier-2 turn. */
export const TIER2_FORBIDDEN_TOOLS = [
  'gate_verdict',
  'merge',
  'deploy',
  'publish',
  'fleet_control',
  'hermes_sessions',
  'mint_agent_token',
] as const

export type Tier2ForbiddenTool = (typeof TIER2_FORBIDDEN_TOOLS)[number]

export type ChatRuntimeKind = 'tier1_persistent_mubot' | 'tier2_stateless_user_chat'

export interface Tier2BudgetSnapshot {
  /** Remaining pot monthly model budget in micro-USD (-1 = unlimited). */
  remainingMicroUsd: number
  /** Conservative estimate for this turn in micro-USD. */
  estimateMicroUsd: number
}

export type Tier2BudgetDecision =
  | { ok: true }
  | { ok: false; reason: 'budget_exhausted' }

export interface Tier2TaskCreateDraft {
  title: string
  body: string
  doneWhen: string
  sessionId: string
}

export type Tier2TaskCreateValidation =
  | { ok: true; body: string; doneWhen: string }
  | { ok: false; reason: 'done_when_required' | 'session_id_required' | 'title_required' }

export interface Tier2ResultFanInKey {
  sessionId: string
  taskId: string
  terminalStatus: string
}

/** True only for the cheap every-member path — never for kayhermes-style mubots. */
export function isTier2Runtime(kind: ChatRuntimeKind): boolean {
  return kind === 'tier2_stateless_user_chat'
}

/**
 * Idle model cost in micro-USD for the chat runtime kind.
 * Tier-2 idle is always 0 (dormant). Tier-1 idle is treated as non-zero
 * (upstream process). When a request is open this returns 0 — spend is
 * turn-attributed elsewhere, not via this idle helper.
 */
export function idleModelCostMicroUsd(kind: ChatRuntimeKind, hasOpenRequest: boolean): number {
  if (hasOpenRequest) return 0
  if (kind === 'tier2_stateless_user_chat') return 0
  return 1
}

/** Persistent process per user is allowed only for Tier-1. */
export function allowsPersistentProcessPerUser(kind: ChatRuntimeKind): boolean {
  return kind === 'tier1_persistent_mubot'
}

export function isTier2AllowedTool(tool: string): boolean {
  return (TIER2_ALLOWED_TOOLS as readonly string[]).includes(tool)
}

export function isTier2ForbiddenTool(tool: string): boolean {
  return (TIER2_FORBIDDEN_TOOLS as readonly string[]).includes(tool)
}

/**
 * Fail-closed tool gate: allowed set wins only if the name is not also
 * forbidden (defense in depth if the two lists ever drift).
 */
export function assertTier2ToolAllowed(tool: string): void {
  if (isTier2ForbiddenTool(tool) || !isTier2AllowedTool(tool)) {
    throw new Error(`tier2_tool_forbidden: ${tool}`)
  }
}

/**
 * Pre-call budget gate. Unlimited ceiling (`remainingMicroUsd < 0`) always
 * passes. Otherwise the estimate must fit in the remaining budget — reach
 * allowed, exceed refused. No model call on deny.
 */
export function decideTier2Budget(snapshot: Tier2BudgetSnapshot): Tier2BudgetDecision {
  if (snapshot.estimateMicroUsd < 0) {
    throw new Error('tier2_budget_invalid_estimate')
  }
  if (snapshot.remainingMicroUsd < 0) return { ok: true }
  if (snapshot.remainingMicroUsd >= snapshot.estimateMicroUsd) return { ok: true }
  return { ok: false, reason: 'budget_exhausted' }
}

/** Build the provenance sentinel for a session. */
export function tier2ChatMarker(sessionId: string): string {
  const id = sessionId.trim()
  if (!id) throw new Error('tier2_session_id_required')
  return `${TIER2_CHAT_MARKER_PREFIX}${id}]`
}

/** Extract session id from a task body marker, or null if absent/malformed. */
export function parseTier2ChatMarker(body: string): string | null {
  const idx = body.indexOf(TIER2_CHAT_MARKER_PREFIX)
  if (idx < 0) return null
  const start = idx + TIER2_CHAT_MARKER_PREFIX.length
  const end = body.indexOf(']', start)
  if (end < 0) return null
  const sessionId = body.slice(start, end).trim()
  return sessionId.length > 0 ? sessionId : null
}

/**
 * Validate a board-task draft from a chat turn. Ensures done_when + provenance
 * marker. Does not touch the DB.
 */
export function validateTier2TaskCreate(draft: Tier2TaskCreateDraft): Tier2TaskCreateValidation {
  const title = draft.title.trim()
  if (!title) return { ok: false, reason: 'title_required' }
  const sessionId = draft.sessionId.trim()
  if (!sessionId) return { ok: false, reason: 'session_id_required' }
  const doneWhen = draft.doneWhen.trim()
  if (!doneWhen) return { ok: false, reason: 'done_when_required' }
  const marker = tier2ChatMarker(sessionId)
  const body = draft.body.includes(marker) ? draft.body : `${draft.body.trim()}\n\n${marker}`
  return { ok: true, body, doneWhen }
}

/** Idempotency key for result fan-in into a chat session. */
export function tier2ResultFanInKey(parts: Tier2ResultFanInKey): string {
  const sessionId = parts.sessionId.trim()
  const taskId = parts.taskId.trim()
  const terminalStatus = parts.terminalStatus.trim()
  if (!sessionId || !taskId || !terminalStatus) {
    throw new Error('tier2_result_fan_in_key_incomplete')
  }
  return `${sessionId}:${taskId}:${terminalStatus}`
}

/**
 * Model cognition is legal only when budgetGate has already passed in this
 * turn. Encodes pipeline order without running I/O.
 */
export function mayRunModelTurn(completedSteps: readonly Tier2TurnStep[]): boolean {
  return completedSteps.includes('budgetGate') && !completedSteps.includes('modelTurn')
}

/** Cron/idle wake of Tier-2 cognition is forbidden. */
export function mayWakeIdleTier2Chat(hasUserMessage: boolean): boolean {
  return hasUserMessage
}

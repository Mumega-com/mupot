import type { RoutineActionKind } from './types'

export const ROUTINE_PROPOSAL_VERSION = 'routine.proposal/v1' as const

export interface RoutineProposalReference {
  type: 'task' | 'flight' | 'artifact'
  id: string
}

export type RoutineProposalAction =
  | { key: string; kind: 'create_task'; input: { title: string; description: string; assignee_agent_id?: string } }
  | { key: string; kind: 'dispatch_flight'; input: { goal: string; task_ids: string[]; artifact_refs: string[]; budget_micro_usd: number } }
  | { key: string; kind: 'request_review'; input: { source_type: 'task' | 'flight' | 'artifact'; source_id: string; summary: string } }
  | { key: string; kind: 'ask_human'; input: { question: string; choices?: string[]; references: RoutineProposalReference[] } }
  | { key: string; kind: 'no_action'; input: { reason: string; next_check_at?: string } }

export interface RoutineProposal {
  version: typeof ROUTINE_PROPOSAL_VERSION
  run_id: string
  project_id: string
  situation_digest: string
  summary: string
  action: RoutineProposalAction
}

export type ProposalParseResult =
  | { ok: true; value: RoutineProposal }
  | { ok: false; error: 'invalid_envelope' | 'unknown_key' | 'invalid_action' | 'unsupported_action' | 'invalid_action_input' }

const ACTION_KINDS = new Set<RoutineActionKind>([
  'create_task', 'dispatch_flight', 'request_review', 'ask_human', 'no_action',
])
const ACTION_KEY = /^[A-Za-z0-9_.:-]{1,200}$/
const DIGEST = /^[a-f0-9]{64}$/
const SOURCE_TYPES = new Set(['task', 'flight', 'artifact'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every(key => keys.has(key))
}

function bounded(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string') return false
  const length = new TextEncoder().encode(value).byteLength
  return value.trim().length >= min && length <= max
}

function boundedRef(value: unknown, max = 200): value is string {
  return bounded(value, 1, max)
}

function boundedUniqueStrings(value: unknown, maxItems: number, maxLength: number, minItems = 0): value is string[] {
  return Array.isArray(value)
    && value.length >= minItems
    && value.length <= maxItems
    && value.every(item => bounded(item, 1, maxLength))
    && new Set(value).size === value.length
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function parseReferences(value: unknown): ProposalParseResult | RoutineProposalReference[] {
  if (!Array.isArray(value) || value.length > 20) return { ok: false, error: 'invalid_action_input' }
  const references: RoutineProposalReference[] = []
  const identities = new Set<string>()
  for (const item of value) {
    if (!record(item)) return { ok: false, error: 'invalid_action_input' }
    if (!exactKeys(item, ['type', 'id'])) return { ok: false, error: 'unknown_key' }
    if (!SOURCE_TYPES.has(String(item.type)) || !boundedRef(item.id)) {
      return { ok: false, error: 'invalid_action_input' }
    }
    const reference = { type: item.type as RoutineProposalReference['type'], id: item.id }
    const identity = `${reference.type}:${reference.id}`
    if (identities.has(identity)) return { ok: false, error: 'invalid_action_input' }
    identities.add(identity)
    references.push(reference)
  }
  return references
}

function parseAction(action: Record<string, unknown>): ProposalParseResult | RoutineProposalAction {
  if (!exactKeys(action, ['key', 'kind', 'input'])) return { ok: false, error: 'unknown_key' }
  if (typeof action.kind !== 'string' || !ACTION_KINDS.has(action.kind as RoutineActionKind)) {
    return { ok: false, error: 'unsupported_action' }
  }
  if (typeof action.key !== 'string' || !ACTION_KEY.test(action.key)) {
    return { ok: false, error: 'invalid_action' }
  }
  if (!record(action.input)) return { ok: false, error: 'invalid_action_input' }
  const input = action.input

  if (action.kind === 'create_task') {
    if (!exactKeys(input, ['title', 'description', 'assignee_agent_id'])) return { ok: false, error: 'unknown_key' }
    if (!bounded(input.title, 1, 240) || !bounded(input.description, 1, 4000)) {
      return { ok: false, error: 'invalid_action_input' }
    }
    if (input.assignee_agent_id !== undefined && !boundedRef(input.assignee_agent_id)) {
      return { ok: false, error: 'invalid_action_input' }
    }
    return {
      key: action.key, kind: action.kind,
      input: {
        title: input.title,
        description: input.description,
        ...(input.assignee_agent_id === undefined ? {} : { assignee_agent_id: input.assignee_agent_id }),
      },
    }
  }

  if (action.kind === 'dispatch_flight') {
    if (!exactKeys(input, ['goal', 'task_ids', 'artifact_refs', 'budget_micro_usd'])) {
      return { ok: false, error: 'unknown_key' }
    }
    if (
      !bounded(input.goal, 1, 4000)
      || !boundedUniqueStrings(input.task_ids, 200, 200, 1)
      || !boundedUniqueStrings(input.artifact_refs, 200, 2000)
      || !Number.isSafeInteger(input.budget_micro_usd)
      || Number(input.budget_micro_usd) <= 0
    ) return { ok: false, error: 'invalid_action_input' }
    return {
      key: action.key, kind: action.kind,
      input: {
        goal: input.goal,
        task_ids: [...input.task_ids],
        artifact_refs: [...input.artifact_refs],
        budget_micro_usd: Number(input.budget_micro_usd),
      },
    }
  }

  if (action.kind === 'request_review') {
    if (!exactKeys(input, ['source_type', 'source_id', 'summary'])) return { ok: false, error: 'unknown_key' }
    if (!SOURCE_TYPES.has(String(input.source_type)) || !boundedRef(input.source_id) || !bounded(input.summary, 1, 4000)) {
      return { ok: false, error: 'invalid_action_input' }
    }
    return {
      key: action.key, kind: action.kind,
      input: { source_type: input.source_type as 'task' | 'flight' | 'artifact', source_id: input.source_id, summary: input.summary },
    }
  }

  if (action.kind === 'ask_human') {
    if (!exactKeys(input, ['question', 'choices', 'references'])) return { ok: false, error: 'unknown_key' }
    if (!bounded(input.question, 1, 2000)) return { ok: false, error: 'invalid_action_input' }
    if (input.choices !== undefined && !boundedUniqueStrings(input.choices, 5, 500, 2)) {
      return { ok: false, error: 'invalid_action_input' }
    }
    const references = parseReferences(input.references)
    if (!Array.isArray(references)) return references
    return {
      key: action.key, kind: action.kind,
      input: {
        question: input.question,
        ...(input.choices === undefined ? {} : { choices: [...input.choices] }),
        references,
      },
    }
  }

  if (!exactKeys(input, ['reason', 'next_check_at'])) return { ok: false, error: 'unknown_key' }
  if (!bounded(input.reason, 1, 4000) || (input.next_check_at !== undefined && !exactInstant(input.next_check_at))) {
    return { ok: false, error: 'invalid_action_input' }
  }
  return {
    key: action.key, kind: 'no_action',
    input: { reason: input.reason, ...(input.next_check_at === undefined ? {} : { next_check_at: input.next_check_at }) },
  }
}

export function parseRoutineProposal(value: unknown): ProposalParseResult {
  if (!record(value)) return { ok: false, error: 'invalid_envelope' }
  if (!exactKeys(value, ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'])) {
    return { ok: false, error: 'unknown_key' }
  }
  if (
    value.version !== ROUTINE_PROPOSAL_VERSION
    || !boundedRef(value.run_id)
    || !boundedRef(value.project_id)
    || typeof value.situation_digest !== 'string'
    || !DIGEST.test(value.situation_digest)
    || !bounded(value.summary, 1, 4000)
    || !record(value.action)
  ) return { ok: false, error: 'invalid_envelope' }
  const action = parseAction(value.action)
  if ('ok' in action) return action
  return {
    ok: true,
    value: {
      version: ROUTINE_PROPOSAL_VERSION,
      run_id: value.run_id,
      project_id: value.project_id,
      situation_digest: value.situation_digest,
      summary: value.summary,
      action,
    },
  }
}

// Port 4 — instinct persistence (D1). Observations + instincts.
// Pure domain rules live in instinct.ts; this module is the Durable-Object/D1 seam.

import type { Env } from '../types'
import {
  clampInstinctConfidence,
  isInstinctScope,
  reinforceInstinctConfidence,
  validateInstinctId,
  INSTINCT_REINFORCE_STEP,
  type Instinct,
  type InstinctCandidate,
  type InstinctScope,
} from './instinct'

export type InstinctResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type InstinctObservationEvent =
  | 'tool_start'
  | 'tool_complete'
  | 'user_message'
  | 'correction'
  | 'note'

const OBSERVATION_EVENTS: readonly InstinctObservationEvent[] = [
  'tool_start',
  'tool_complete',
  'user_message',
  'correction',
  'note',
]

export function isInstinctObservationEvent(v: unknown): v is InstinctObservationEvent {
  return typeof v === 'string' && (OBSERVATION_EVENTS as readonly string[]).includes(v)
}

interface InstinctRow {
  id: string
  agent_id: string | null
  project_id: string | null
  scope: string
  trigger_text: string
  confidence: number
  domain: string
  action_text: string
  evidence_json: string
  updated_at: string
  created_at: string
}

interface ObservationRow {
  id: string
  project_id: string
  agent_id: string | null
  session_id: string | null
  event: string
  payload_json: string
  created_at: string
}

export interface StoredObservation {
  id: string
  projectId: string
  agentId: string | null
  sessionId: string | null
  event: InstinctObservationEvent
  payload: Record<string, unknown>
  createdAt: string
}

function parseEvidence(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    throw new Error('instinct: corrupt evidence_json in storage')
  }
}

function rowToInstinct(row: InstinctRow): Instinct {
  if (!isInstinctScope(row.scope)) {
    throw new Error(`instinct: corrupt scope in storage: ${row.scope}`)
  }
  return {
    id: row.id,
    trigger: row.trigger_text,
    confidence: row.confidence,
    domain: row.domain,
    scope: row.scope,
    action: row.action_text,
    evidence: parseEvidence(row.evidence_json),
    projectId: row.project_id,
    agentId: row.agent_id,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }
}

function rowToObservation(row: ObservationRow): StoredObservation {
  if (!isInstinctObservationEvent(row.event)) {
    throw new Error(`instinct: corrupt observation event: ${row.event}`)
  }
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.payload_json)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object')
    }
    payload = parsed as Record<string, unknown>
  } catch {
    throw new Error('instinct: corrupt observation payload_json')
  }
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    event: row.event,
    payload,
    createdAt: row.created_at,
  }
}

export interface AppendObservationInput {
  projectId: string
  agentId: string | null
  sessionId: string | null
  event: InstinctObservationEvent
  payload: Record<string, unknown>
  now: string
}

export async function appendInstinctObservation(
  env: Env,
  input: AppendObservationInput,
): Promise<InstinctResult<StoredObservation>> {
  const projectId = input.projectId.trim()
  if (projectId.length === 0) return { ok: false, error: 'project_id_required' }
  if (!isInstinctObservationEvent(input.event)) {
    return { ok: false, error: 'invalid_event' }
  }

  const id = crypto.randomUUID()
  const payloadJson = JSON.stringify(input.payload)
  await env.DB.prepare(
    `INSERT INTO instinct_observations
       (id, tenant, project_id, agent_id, session_id, event, payload_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      projectId,
      input.agentId,
      input.sessionId,
      input.event,
      payloadJson,
      input.now,
    )
    .run()

  return {
    ok: true,
    value: {
      id,
      projectId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      event: input.event,
      payload: input.payload,
      createdAt: input.now,
    },
  }
}

export async function listRecentObservations(
  env: Env,
  projectId: string,
  limit: number,
): Promise<StoredObservation[]> {
  if (!(limit > 0)) {
    throw new Error('instinct: observation limit must be > 0')
  }
  const rows = await env.DB.prepare(
    `SELECT id, project_id, agent_id, session_id, event, payload_json, created_at
       FROM instinct_observations
      WHERE tenant = ?1 AND project_id = ?2
      ORDER BY created_at DESC
      LIMIT ?3`,
  )
    .bind(env.TENANT_SLUG, projectId, limit)
    .all<ObservationRow>()

  return (rows.results ?? []).map(rowToObservation)
}

export async function countObservations(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM instinct_observations
      WHERE tenant = ?1 AND project_id = ?2`,
  )
    .bind(env.TENANT_SLUG, projectId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export interface UpsertInstinctInput {
  id: string
  trigger: string
  confidence: number
  domain: string
  scope: InstinctScope
  action: string
  evidence: string[]
  projectId: string | null
  agentId: string | null
  now: string
}

export async function upsertInstinct(
  env: Env,
  input: UpsertInstinctInput,
): Promise<InstinctResult<Instinct>> {
  let id: string
  try {
    id = validateInstinctId(input.id)
  } catch {
    return { ok: false, error: 'invalid_instinct_id' }
  }
  if (!isInstinctScope(input.scope)) {
    return { ok: false, error: 'invalid_scope' }
  }
  if (input.scope === 'project' && !input.projectId) {
    return { ok: false, error: 'project_id_required' }
  }
  // Global instincts never carry a project_id (promotion result).
  if (input.scope === 'global' && input.projectId !== null) {
    return { ok: false, error: 'global_instinct_must_not_bind_project' }
  }

  const trigger = input.trigger.trim()
  const action = input.action.trim()
  const domain = input.domain.trim()
  if (trigger.length === 0 || trigger.length > 500) {
    return { ok: false, error: 'invalid_trigger' }
  }
  if (action.length === 0 || action.length > 2000) {
    return { ok: false, error: 'invalid_action' }
  }
  if (domain.length > 64) {
    return { ok: false, error: 'invalid_domain' }
  }

  let confidence: number
  try {
    confidence = clampInstinctConfidence(input.confidence)
  } catch {
    return { ok: false, error: 'invalid_confidence' }
  }

  const evidence = input.evidence.filter((e) => typeof e === 'string' && e.trim().length > 0)
  const evidenceJson = JSON.stringify(evidence)
  const projectId = input.scope === 'project' ? input.projectId : null
  const agentId = input.agentId

  await env.DB.prepare(
    `INSERT INTO instincts
       (id, tenant, agent_id, project_id, scope, trigger_text, confidence, domain,
        action_text, evidence_json, updated_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT (tenant, id, scope, project_key, agent_key) DO UPDATE SET
       trigger_text = excluded.trigger_text,
       confidence = excluded.confidence,
       domain = excluded.domain,
       action_text = excluded.action_text,
       evidence_json = excluded.evidence_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      agentId,
      projectId,
      input.scope,
      trigger,
      confidence,
      domain,
      action,
      evidenceJson,
      input.now,
    )
    .run()

  return {
    ok: true,
    value: {
      id,
      trigger,
      confidence,
      domain,
      scope: input.scope,
      action,
      evidence,
      projectId,
      agentId,
      updatedAt: input.now,
      createdAt: input.now,
    },
  }
}

/** Upsert a distilled candidate into project scope, reinforcing if it already exists. */
export async function upsertDistilledCandidate(
  env: Env,
  projectId: string,
  agentId: string | null,
  candidate: InstinctCandidate,
  now: string,
): Promise<InstinctResult<Instinct>> {
  const existing = await listInstinctsById(env, candidate.id)
  const prior = existing.find(
    (instinct) => instinct.scope === 'project' && instinct.projectId === projectId,
  )
  const confidence = prior
    ? reinforceInstinctConfidence(
      Math.max(prior.confidence, candidate.confidence),
      INSTINCT_REINFORCE_STEP,
    )
    : candidate.confidence
  const evidence = prior
    ? [...prior.evidence, ...candidate.evidence]
    : candidate.evidence

  return upsertInstinct(env, {
    id: candidate.id,
    trigger: candidate.trigger,
    confidence,
    domain: candidate.domain,
    scope: 'project',
    action: candidate.action,
    evidence,
    projectId,
    agentId,
    now,
  })
}

export async function listInstinctsForProject(
  env: Env,
  projectId: string | null,
): Promise<Instinct[]> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, project_id, scope, trigger_text, confidence, domain,
            action_text, evidence_json, updated_at, created_at
       FROM instincts
      WHERE tenant = ?1
        AND (
          scope = 'global'
          OR (scope = 'project' AND project_id IS NOT NULL AND project_id = ?2)
        )
      ORDER BY confidence DESC, id ASC`,
  )
    .bind(env.TENANT_SLUG, projectId)
    .all<InstinctRow>()

  return (rows.results ?? []).map(rowToInstinct)
}

export async function listInstinctsById(
  env: Env,
  instinctId: string,
): Promise<Instinct[]> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, project_id, scope, trigger_text, confidence, domain,
            action_text, evidence_json, updated_at, created_at
       FROM instincts
      WHERE tenant = ?1 AND id = ?2`,
  )
    .bind(env.TENANT_SLUG, instinctId)
    .all<InstinctRow>()

  return (rows.results ?? []).map(rowToInstinct)
}

export async function promoteInstinctToGlobal(
  env: Env,
  source: Instinct,
  now: string,
): Promise<InstinctResult<Instinct>> {
  return upsertInstinct(env, {
    id: source.id,
    trigger: source.trigger,
    confidence: source.confidence,
    domain: source.domain,
    scope: 'global',
    action: source.action,
    evidence: source.evidence,
    projectId: null,
    agentId: null,
    now,
  })
}

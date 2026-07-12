export const FLIGHT_META_V1_SCHEMA = 'mupot.flight.meta/v1' as const

export type FlightConfidentiality = 'private' | 'internal' | 'public-projection'
export type FlightPublicationTarget = 'none' | 'inkwell-draft' | 'mumega.com'

export interface FlightMetaV1 {
  schema: typeof FLIGHT_META_V1_SCHEMA
  goal_id: string
  objective_id: string
  squad_ids: string[]
  task_ids: string[]
  done_when: string[]
  artifact_refs: string[]
  receipt_refs: string[]
  confidentiality: FlightConfidentiality
  publication_target: FlightPublicationTarget
  parent_flight_id: string | null
}

const KEYS = new Set<keyof FlightMetaV1>([
  'schema',
  'goal_id',
  'objective_id',
  'squad_ids',
  'task_ids',
  'done_when',
  'artifact_refs',
  'receipt_refs',
  'confidentiality',
  'publication_target',
  'parent_flight_id',
])

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function boundedStrings(value: unknown, opts: { maxItems: number; maxLength: number; nonEmpty?: boolean }): value is string[] {
  return Array.isArray(value)
    && (!opts.nonEmpty || value.length > 0)
    && value.length <= opts.maxItems
    && value.every((item) => boundedString(item, opts.maxLength))
}

export function parseFlightMetaV1(raw: unknown): FlightMetaV1 | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const meta = raw as Record<string, unknown>
  if (JSON.stringify(meta).length > 16_384) return null
  if (Object.keys(meta).some((key) => !KEYS.has(key as keyof FlightMetaV1))) return null
  if (meta.schema !== FLIGHT_META_V1_SCHEMA) return null
  if (!boundedString(meta.goal_id, 200)) return null
  if (!boundedString(meta.objective_id, 200)) return null
  if (!boundedStrings(meta.squad_ids, { maxItems: 32, maxLength: 200, nonEmpty: true })) return null
  if (!boundedStrings(meta.task_ids, { maxItems: 200, maxLength: 200, nonEmpty: true })) return null
  if (!boundedStrings(meta.done_when, { maxItems: 100, maxLength: 1000, nonEmpty: true })) return null
  if (!boundedStrings(meta.artifact_refs, { maxItems: 200, maxLength: 2000 })) return null
  if (!boundedStrings(meta.receipt_refs, { maxItems: 200, maxLength: 2000 })) return null
  if (!['private', 'internal', 'public-projection'].includes(meta.confidentiality as string)) return null
  if (!['none', 'inkwell-draft', 'mumega.com'].includes(meta.publication_target as string)) return null
  if (meta.parent_flight_id !== null && !boundedString(meta.parent_flight_id, 200)) return null

  return {
    schema: FLIGHT_META_V1_SCHEMA,
    goal_id: meta.goal_id,
    objective_id: meta.objective_id,
    squad_ids: [...new Set(meta.squad_ids)],
    task_ids: [...new Set(meta.task_ids)],
    done_when: meta.done_when,
    artifact_refs: meta.artifact_refs,
    receipt_refs: meta.receipt_refs,
    confidentiality: meta.confidentiality as FlightConfidentiality,
    publication_target: meta.publication_target as FlightPublicationTarget,
    parent_flight_id: meta.parent_flight_id,
  }
}

export type FlightMetaReferenceResult =
  | { ok: true }
  | { ok: false; error: 'flight_squad_not_found' | 'flight_task_not_found' | 'flight_task_scope_mismatch'; ref: string }

export async function validateFlightMetaReferences(env: Env, meta: FlightMetaV1): Promise<FlightMetaReferenceResult> {
  for (const squadId of meta.squad_ids) {
    const squad = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1 LIMIT 1')
      .bind(squadId)
      .first<{ id: string }>()
    if (!squad) return { ok: false, error: 'flight_squad_not_found', ref: squadId }
  }
  for (const taskId of meta.task_ids) {
    const task = await env.DB.prepare('SELECT id, squad_id FROM tasks WHERE id = ?1 LIMIT 1')
      .bind(taskId)
      .first<{ id: string; squad_id: string }>()
    if (!task) return { ok: false, error: 'flight_task_not_found', ref: taskId }
    if (!meta.squad_ids.includes(task.squad_id)) {
      return { ok: false, error: 'flight_task_scope_mismatch', ref: taskId }
    }
  }
  return { ok: true }
}
import type { Env } from '../types'


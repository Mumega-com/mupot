import type { D1Result } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import {
  isProjectBoardProvider,
  type ProjectBoardProvider,
  type ProjectProviderBinding,
} from './port'

export type BindingMutationError =
  | 'invalid_provider'
  | 'invalid_external_id'
  | 'invalid_meta'
  | 'project_not_found'
  | 'archived_project'
  | 'receipt_failed'

export type BindingMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BindingMutationError }

export interface UpsertBindingInput {
  provider: unknown
  external_id: unknown
  connector_id?: unknown
  // SECURITY: meta is stored verbatim in project_provider_bindings.meta_json, which is
  // OBSERVER-readable via the project_context MCP tool (any project reader sees it).
  // NEVER put a secret here (webhook signing secret, integration/install token, etc.) —
  // credentials belong in the connector record (referenced by connector_id), never inline.
  meta?: unknown
}

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function triggerError(error: unknown): BindingMutationError | null {
  if (!(error instanceof Error)) return null
  if (error.message.includes('archived project')) return 'archived_project'
  if (error.message.includes('project not found')) return 'project_not_found'
  return null
}

export async function listProjectBindings(
  env: Env,
  projectId: string,
): Promise<ProjectProviderBinding[]> {
  const rows = await env.DB.prepare(
    `SELECT project_id, provider, external_id, connector_id, meta_json, synced_at, created_at, updated_at
       FROM project_provider_bindings
      WHERE project_id = ?
      ORDER BY provider ASC`,
  )
    .bind(projectId)
    .all<ProjectProviderBinding>()
  return rows.results ?? []
}

export async function getProjectBinding(
  env: Env,
  projectId: string,
  provider: ProjectBoardProvider,
): Promise<ProjectProviderBinding | null> {
  return (
    (await env.DB.prepare(
      `SELECT project_id, provider, external_id, connector_id, meta_json, synced_at, created_at, updated_at
         FROM project_provider_bindings
        WHERE project_id = ? AND provider = ?`,
    )
      .bind(projectId, provider)
      .first<ProjectProviderBinding>()) ?? null
  )
}

export async function upsertProjectBinding(
  env: Env,
  projectId: string,
  input: UpsertBindingInput,
): Promise<BindingMutationResult<ProjectProviderBinding>> {
  if (!isProjectBoardProvider(input.provider)) return { ok: false, error: 'invalid_provider' }
  if (!isNonEmptyString(input.external_id) || input.external_id.trim().length > 500) {
    return { ok: false, error: 'invalid_external_id' }
  }
  const connectorId =
    input.connector_id === undefined || input.connector_id === null || input.connector_id === ''
      ? null
      : isNonEmptyString(input.connector_id)
        ? input.connector_id.trim()
        : null
  if (input.connector_id !== undefined && input.connector_id !== null && input.connector_id !== '' && connectorId === null) {
    return { ok: false, error: 'invalid_external_id' }
  }
  let metaJson = '{}'
  if (input.meta !== undefined) {
    try {
      metaJson = JSON.stringify(input.meta === null ? {} : input.meta)
      JSON.parse(metaJson)
    } catch {
      return { ok: false, error: 'invalid_meta' }
    }
  }
  const now = new Date().toISOString()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO project_provider_bindings
         (project_id, provider, external_id, connector_id, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, provider) DO UPDATE SET
         external_id = excluded.external_id,
         connector_id = excluded.connector_id,
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`,
    )
      .bind(projectId, input.provider, input.external_id.trim(), connectorId, metaJson, now, now)
      .run()
    if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  } catch (error) {
    const mapped = triggerError(error)
    if (mapped) return { ok: false, error: mapped }
    throw error
  }
  const row = await getProjectBinding(env, projectId, input.provider)
  if (!row) return { ok: false, error: 'receipt_failed' }
  return { ok: true, value: row }
}

export async function removeProjectBinding(
  env: Env,
  projectId: string,
  provider: ProjectBoardProvider,
): Promise<BindingMutationResult<{ removed: true }>> {
  try {
    const result = await env.DB.prepare(
      `DELETE FROM project_provider_bindings WHERE project_id = ? AND provider = ?`,
    )
      .bind(projectId, provider)
      .run()
    if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  } catch (error) {
    const mapped = triggerError(error)
    if (mapped) return { ok: false, error: mapped }
    throw error
  }
  return { ok: true, value: { removed: true } }
}

export async function touchProjectBindingSync(
  env: Env,
  projectId: string,
  provider: ProjectBoardProvider,
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE project_provider_bindings
        SET synced_at = ?, updated_at = ?
      WHERE project_id = ? AND provider = ?`,
  )
    .bind(now, now, projectId, provider)
    .run()
}

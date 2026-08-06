import type { D1Result } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import { resolveConnectorByIdWithMeta } from '../../connectors/service'
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
  | 'connector_not_found'
  | 'connector_out_of_scope'

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

/**
 * The calling actor's OWN authority — never "everything linked to the
 * project." A project manager authorized through squad A must not be able to
 * bind a connector scoped to squad B merely because B also holds some
 * access_level here; that is precisely the confused-deputy shape #453
 * requires closed. Callers get this from dashboard/projects.ts's
 * `projectManageAccessContext`, never derived independently.
 *
 * `actorSquadIds` is the actor's RAW squad membership (unfiltered by
 * project_squad_access) — a slow-changing fact about the actor, unlike
 * "does squad X currently hold write/admin on project Y," which can change
 * between when a caller snapshots it and when the write actually runs.
 * `upsertProjectBinding` re-derives THAT part live, inside the write's own
 * SQL, rather than trusting a pre-filtered snapshot (adversarial review: a
 * squad's access could be revoked/downgraded concurrently with a bind using
 * a stale "still authorized" snapshot, landing a credential attached after
 * authority was gone).
 */
export interface BindingActorContext {
  workspaceAdmin: boolean
  actorSquadIds: string[]
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
  actor: BindingActorContext,
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
  // SECURITY (#453): the referenced connector must be within the ACTOR's OWN
  // authority, never merely "linked to the project." Two prior fixes were
  // BLOCKed by adversarial review:
  //   - e4be75d accepted any pot-wide connector, and any squad-scoped
  //     connector belonging to ANY squad holding ANY access_level on the
  //     project — broader than the caller's own authority.
  //   - 32796c7 bound pot-scope to workspaceAdmin and squad-scope to the
  //     caller's authorizingSquadIds, but (a) workspace admins got an EMPTY
  //     authorizingSquadIds, so they could never bind a squad connector even
  //     though admin is meant to be the authority superset, and (b) the
  //     check ran against a snapshot the ROUTE HANDLER computed before this
  //     call — if the squad's access was revoked/downgraded in the gap
  //     between that snapshot and this write actually executing, a
  //     now-unauthorized bind could still land.
  //
  // Fix: a JS pre-check below still gives a precise error (connector_not_found
  // vs connector_out_of_scope) for the common case, but the ACTUAL enforcement
  // is the WHERE-guarded write further down — it re-derives "does this squad
  // currently hold write/admin on this project" from a LIVE read inside the
  // same statement that performs the write, so there is no gap between
  // authorizing and acting for a concurrent revoke to land inside. Workspace
  // admins are the authority superset for both pot- and squad-scoped
  // connectors; agent-scoped connectors are never valid here (a single
  // agent's credential is not a project-shared one). Fail closed on any
  // lookup miss.
  if (connectorId !== null) {
    const connector = await resolveConnectorByIdWithMeta(env, connectorId)
    if (!connector) return { ok: false, error: 'connector_not_found' }
    if (connector.scopeType === 'agent') {
      return { ok: false, error: 'connector_out_of_scope' }
    }
    if (connector.scopeType === 'pot') {
      if (!actor.workspaceAdmin) return { ok: false, error: 'connector_out_of_scope' }
    }
    if (connector.scopeType === 'squad') {
      const inScope = actor.workspaceAdmin
        || (connector.scopeId !== null && actor.actorSquadIds.includes(connector.scopeId))
      if (!inScope) return { ok: false, error: 'connector_out_of_scope' }
    }
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
    // The WHERE clause on the SELECT is the real authority gate: if it
    // evaluates false, the SELECT yields zero rows, so there is nothing to
    // insert and nothing to conflict — the ON CONFLICT branch never fires
    // either. A connector_id of NULL (clearing the binding) always passes;
    // otherwise the connector must be non-revoked, in this tenant, and
    // either pot-scoped with an admin actor, or squad-scoped with an admin
    // actor OR a squad in actorSquadIds that CURRENTLY (as of this same
    // statement) holds write/admin on this project — read live, not from
    // the JS-side pre-check above, so a concurrent revoke cannot land a
    // stale-authorized bind.
    const result = await env.DB.prepare(
      `INSERT INTO project_provider_bindings
         (project_id, provider, external_id, connector_id, meta_json, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL
           OR EXISTS (
                SELECT 1 FROM connectors c
                 WHERE c.id = ?
                   AND c.tenant = ?
                   AND c.revoked_at IS NULL
                   AND (
                         (c.scope_type = 'pot' AND ? = 1)
                      OR (c.scope_type = 'squad' AND (
                            ? = 1
                            OR c.scope_id IN (
                                 SELECT psa.squad_id FROM project_squad_access psa
                                  WHERE psa.project_id = ?
                                    AND psa.access_level IN ('write', 'admin')
                                    AND psa.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
                               )
                          ))
                       )
              )
       ON CONFLICT(project_id, provider) DO UPDATE SET
         external_id = excluded.external_id,
         connector_id = excluded.connector_id,
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`,
    )
      .bind(
        projectId, input.provider, input.external_id.trim(), connectorId, metaJson, now, now,
        connectorId,
        connectorId,
        env.TENANT_SLUG ?? '',
        actor.workspaceAdmin ? 1 : 0,
        actor.workspaceAdmin ? 1 : 0,
        projectId,
        JSON.stringify(actor.actorSquadIds ?? []),
      )
      .run()
    if (!wrote(result)) {
      // Either a benign write failure (project archived/missing — mapped
      // below via triggerError) or the live authority guard rejected it —
      // e.g. the JS pre-check above passed but access was revoked in the
      // interim. Fail closed as out-of-scope rather than a generic error so
      // the caller can distinguish "not authorized" from "server error."
      return { ok: false, error: connectorId !== null ? 'connector_out_of_scope' : 'receipt_failed' }
    }
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

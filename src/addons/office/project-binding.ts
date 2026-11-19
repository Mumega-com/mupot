// mupot — mcpwp-office addon: per-PROJECT office destination binding (B3a).
// Spec: mupot wiki `office-per-customer` (project eaf4fb0e-b4f6-4f28-aae6-c06c67ae7afa) §1.1/§1.2.
//
// Leaf module (no dependency on src/tasks/*), like freeze.ts, which imports it.
//
// THE BUG CLASS: the office WordPress destination used to be one addon-wide binding, so a
// task for customer A could publish to customer B's site. The destination is now looked up
// by (task.project_id, slot) in project_office_bindings, and every connector is validated
// as a CONFUSED-DEPUTY guard twice: at bind time and again at use time (the use-time check
// re-reads live state, so a squad-access revoke or a second project sharing the connector
// after bind time still stops a publish).
//
// A connector may be bound as a project's destination only if ALL hold:
//   - it exists in this tenant and is not revoked;
//   - its scope is 'squad' and that squad holds write|admin on the project through
//     project_squad_access (agent-scoped connectors are refused: an agent identity is not a
//     customer boundary);
//   - OR its scope is 'pot' AND no OTHER project currently binds it. (The spec says "pot-
//     scoped refused for outside customer projects"; the schema has no customer/internal
//     marker on projects, so this enforces the strictest checkable form: a pot-wide
//     credential is only ever usable by exactly one project, so it cannot cross customers.)
//   - and, for either scope, no other active project binding uses the same connector.

import type { AuthContext, Env } from '../../types'
import type { OfficeResult } from './freeze'
import { isOrgAdmin } from '../../auth/capability'
import { McpwpOfficeAddon } from './manifest'

/** The capability a project's wordpress_site binding carries, taken from the addon manifest
 *  (connectorRequirements), never from a caller. */
export function manifestOfficeSlotCapability(slot: ProjectOfficeSlot): ProjectOfficeCapability | null {
  const req = McpwpOfficeAddon.connectorRequirements.find((r) => r.slot === slot)
  return req?.capability === 'write' ? 'write' : req?.capability === 'read' ? 'read' : null
}

export type ProjectOfficeSlot = 'wordpress_site' | 'inkwell_site'
export type ProjectOfficeCapability = 'read' | 'write'

export interface ProjectOfficeBinding {
  readonly projectId: string
  readonly slot: ProjectOfficeSlot
  readonly connectorId: string
  readonly capability: ProjectOfficeCapability
}

interface BindingRow {
  project_id: string
  slot: ProjectOfficeSlot
  connector_id: string
  capability: ProjectOfficeCapability
}

interface ConnectorScopeRow {
  scope_type: string
  scope_id: string | null
  revoked_at: string | null
}

/** The confused-deputy guard. Pure read; shared by bind time and use time. */
export async function assertProjectMayUseConnector(
  env: Env,
  projectId: string,
  slot: ProjectOfficeSlot,
  connectorId: string,
): Promise<OfficeResult<true>> {
  const connector = await env.DB.prepare(
    `SELECT scope_type, scope_id, revoked_at FROM connectors WHERE id = ?1 AND tenant = ?2`,
  ).bind(connectorId, env.TENANT_SLUG).first<ConnectorScopeRow>()
  if (!connector || connector.revoked_at !== null) return { ok: false, reason: 'connector_not_bound' }

  if (connector.scope_type === 'squad') {
    if (!connector.scope_id) return { ok: false, reason: 'connector_scope_refused' }
    const access = await env.DB.prepare(
      `SELECT 1 FROM project_squad_access
        WHERE project_id = ?1 AND squad_id = ?2 AND access_level IN ('write', 'admin')`,
    ).bind(projectId, connector.scope_id).first()
    if (!access) return { ok: false, reason: 'connector_scope_refused', hint: 'connector squad has no write access on this project' }
  } else if (connector.scope_type !== 'pot') {
    // agent-scoped (or any unknown scope): refused.
    return { ok: false, reason: 'connector_scope_refused' }
  }

  const shared = await env.DB.prepare(
    `SELECT 1 FROM project_office_bindings
      WHERE connector_id = ?1 AND revoked_at IS NULL AND NOT (project_id = ?2 AND slot = ?3) LIMIT 1`,
  ).bind(connectorId, projectId, slot).first()
  if (shared) return { ok: false, reason: 'connector_scope_refused', hint: 'connector is bound to another project' }
  return { ok: true, value: true }
}

/** Owner/admin binds a project's office destination (MCP: office.bind_project_site). The capability
 *  is the manifest's for the slot, never the caller's. */
export async function bindProjectOfficeSlot(
  env: Env,
  auth: AuthContext,
  input: { projectId: string; slot: ProjectOfficeSlot; connectorId: string },
): Promise<OfficeResult<ProjectOfficeBinding>> {
  if (!isOrgAdmin(auth)) return { ok: false, reason: 'not_authorized' }
  const capability = manifestOfficeSlotCapability(input.slot)
  if (!capability) return { ok: false, reason: 'invalid_site_config', hint: 'slot is not declared by the office manifest' }
  const project = await env.DB.prepare(`SELECT 1 FROM projects WHERE id = ?1`).bind(input.projectId).first()
  if (!project) return { ok: false, reason: 'project_not_bound', hint: 'project not found' }
  const guard = await assertProjectMayUseConnector(env, input.projectId, input.slot, input.connectorId)
  if (!guard.ok) return guard
  await env.DB.prepare(`
    INSERT INTO project_office_bindings (project_id, slot, connector_id, capability, bound_by, bound_at, revoked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
    ON CONFLICT(project_id, slot) DO UPDATE SET
      connector_id = excluded.connector_id, capability = excluded.capability,
      bound_by = excluded.bound_by, bound_at = excluded.bound_at, revoked_at = NULL
  `).bind(
    input.projectId, input.slot, input.connectorId, capability,
    auth.memberId ?? auth.userId, new Date().toISOString(),
  ).run()
  return { ok: true, value: { projectId: input.projectId, slot: input.slot, connectorId: input.connectorId, capability } }
}

/** Owner/admin revokes a project's office destination; publishing then refuses project_not_bound. */
export async function revokeProjectOfficeSlot(
  env: Env,
  auth: AuthContext,
  input: { projectId: string; slot: ProjectOfficeSlot },
): Promise<OfficeResult<{ projectId: string; slot: ProjectOfficeSlot }>> {
  if (!isOrgAdmin(auth)) return { ok: false, reason: 'not_authorized' }
  const res = await env.DB.prepare(
    `UPDATE project_office_bindings SET revoked_at = ?3 WHERE project_id = ?1 AND slot = ?2 AND revoked_at IS NULL`,
  ).bind(input.projectId, input.slot, new Date().toISOString()).run()
  if (!res.meta?.changes) return { ok: false, reason: 'project_not_bound' }
  return { ok: true, value: { projectId: input.projectId, slot: input.slot } }
}

/** Resolves (projectId, slot) to its connector, re-running the confused-deputy guard NOW. */
export async function resolveProjectOfficeBinding(
  env: Env,
  projectId: string,
  slot: ProjectOfficeSlot,
): Promise<OfficeResult<ProjectOfficeBinding>> {
  const row = await env.DB.prepare(
    `SELECT project_id, slot, connector_id, capability FROM project_office_bindings
      WHERE project_id = ?1 AND slot = ?2 AND revoked_at IS NULL`,
  ).bind(projectId, slot).first<BindingRow>()
  if (!row) return { ok: false, reason: 'project_not_bound' }
  const guard = await assertProjectMayUseConnector(env, projectId, slot, row.connector_id)
  if (!guard.ok) return guard
  return { ok: true, value: { projectId: row.project_id, slot: row.slot, connectorId: row.connector_id, capability: row.capability } }
}

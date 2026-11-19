// B3c: which Inkwell tenant a department gate's draft is written to.
//
// The destination is the CUSTOMER's, derived from the task behind the gate (gate id === task id for
// content-publish proposals): the task's squad-scoped 'inkwell' connector, with the tenant slug read from
// that connector's own meta.tenantSlug. There is deliberately NO fallback to a pot-scoped connector or to
// env.TENANT_SLUG — both name the operator's own tenant. Anything missing → null (fail closed).
//
// project_office_bindings already allows slot 'inkwell_site', but the office binding tool only accepts
// 'wordpress_site' today (manifest accepts: ['mcpwp']), so that path is not used here; follow-up.

import type { Env } from '../types'
import { resolveSquadConnectorWithMeta } from '../connectors/service'
import type { ConnectorType } from '../connectors/service'

const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i

export interface InkwellTarget {
  readonly token: string
  readonly tenantSlug: string
}

/** Pure: pull a valid tenantSlug out of connector meta JSON, or null. */
export function parseInkwellTenantSlug(meta: string | null): string | null {
  if (!meta) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(meta)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const slug = (parsed as { tenantSlug?: unknown }).tenantSlug // narrowed to object above; value validated below
  if (typeof slug !== 'string') return null
  const trimmed = slug.trim()
  return TENANT_SLUG_RE.test(trimmed) ? trimmed : null
}

/**
 * The connector (secret + meta) of `type` in the squad of the task behind this gate. Strictly squad-scoped:
 * no task row / no squad / no squad connector → null. Never a pot- or agent-scoped connector (operator's).
 */
export async function resolveSquadConnectorForGate(
  env: Env,
  gateId: string,
  type: ConnectorType,
): Promise<{ secret: string; meta: string | null } | null> {
  const task = await env.DB.prepare(`SELECT squad_id FROM tasks WHERE id = ?1`)
    .bind(gateId)
    .first<{ squad_id: string | null }>()
  if (!task || !task.squad_id) return null
  return resolveSquadConnectorWithMeta(env, task.squad_id, type)
}

export async function resolveInkwellTargetForGate(env: Env, gateId: string): Promise<InkwellTarget | null> {
  const conn = await resolveSquadConnectorForGate(env, gateId, 'inkwell')
  if (!conn) return null
  const tenantSlug = parseInkwellTenantSlug(conn.meta)
  if (!tenantSlug) return null
  return { token: conn.secret, tenantSlug }
}

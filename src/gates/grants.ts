// mupot — gate_grants service (shared by HTTP /api/gates/grants and MCP tools).
//
// Only org owner/admin may grant/revoke. Rows live in gate_grants (migration 0008).
// INSERT OR IGNORE keeps grant idempotent; revoke is a hard DELETE (verdict receipts
// remain the audit trail).

import type { Env } from '../types'

export type GatePrincipalType = 'member' | 'agent'

export interface GateGrantInput {
  readonly capability: string
  readonly principalType: GatePrincipalType
  readonly principalId: string
  readonly grantedBy: string
}

export interface GateGrantRecord {
  readonly capability: string
  readonly principal_type: GatePrincipalType
  readonly principal_id: string
  readonly granted_by: string
  readonly created_at: string
}

export type GateGrantValidationError =
  | 'invalid_capability'
  | 'invalid_principal_type'
  | 'invalid_principal_id'

/** Gate capabilities are named `gate:<owner>` (e.g. gate:kasra-core).
 *  HTTP/MCP grant paths accept gate:* only by design — surface caps
 *  (content:write, outreach:send-gated, …) also live in gate_grants but are
 *  minted via preset/dashboard, not grant_gate_capability. */
export const GATE_CAPABILITY_RE = /^gate:[a-zA-Z0-9][a-zA-Z0-9:_-]{0,120}$/

export function parseGateGrantArgs(input: {
  capability?: unknown
  principal_type?: unknown
  principal_id?: unknown
}): { ok: true; capability: string; principalType: GatePrincipalType; principalId: string }
  | { ok: false; error: GateGrantValidationError } {
  if (typeof input.capability !== 'string' || !GATE_CAPABILITY_RE.test(input.capability.trim())) {
    return { ok: false, error: 'invalid_capability' }
  }
  if (input.principal_type !== 'member' && input.principal_type !== 'agent') {
    return { ok: false, error: 'invalid_principal_type' }
  }
  if (typeof input.principal_id !== 'string' || !input.principal_id.trim()) {
    return { ok: false, error: 'invalid_principal_id' }
  }
  return {
    ok: true,
    capability: input.capability.trim(),
    principalType: input.principal_type,
    principalId: input.principal_id.trim(),
  }
}

export async function grantGateCapability(
  env: Env,
  input: GateGrantInput,
): Promise<GateGrantRecord> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT OR IGNORE INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.capability, input.principalType, input.principalId, input.grantedBy, now)
    .run()

  return {
    capability: input.capability,
    principal_type: input.principalType,
    principal_id: input.principalId,
    granted_by: input.grantedBy,
    created_at: now,
  }
}


export interface GateGrantFilter {
  capability?: string
  principalType?: GatePrincipalType
  principalId?: string
}

/**
 * D3 (2026-08-13, athena gate cluster map on 247858f1): read-side twin of
 * grant/revoke — grants are audit data; an unreadable audit is a wall. Returns
 * gate_grants rows (capability, principal_type, principal_id, granted_by,
 * created_at), optionally filtered, newest first, capped at 500. Callers gate
 * org:admin in the tool/route layer.
 */
export async function listGateCapabilities(
  env: Env,
  filter: GateGrantFilter = {},
): Promise<GateGrantRecord[]> {
  const clauses: string[] = []
  const binds: unknown[] = []
  if (filter.capability !== undefined) {
    clauses.push('capability = ?')
    binds.push(filter.capability)
  }
  if (filter.principalType !== undefined) {
    clauses.push('principal_type = ?')
    binds.push(filter.principalType)
  }
  if (filter.principalId !== undefined) {
    clauses.push('principal_id = ?')
    binds.push(filter.principalId)
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = await env.DB.prepare(
    `SELECT capability, principal_type, principal_id, granted_by, created_at
       FROM gate_grants${where}
      ORDER BY created_at DESC
      LIMIT 500`,
  )
    .bind(...binds)
    .all<GateGrantRecord>()
  return rows.results ?? []
}
export async function revokeGateCapability(
  env: Env,
  input: {
    readonly capability: string
    readonly principalType: GatePrincipalType
    readonly principalId: string
  },
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM gate_grants WHERE capability = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(input.capability, input.principalType, input.principalId)
    .run()
}


/**
 * Resolve a gate_owner CAPABILITY NAME (e.g. 'gate:athena') to the single AGENT
 * principal that holds it, from the gate_grants table (migration 0008:
 * capability, principal_type, principal_id — no tenant column, mirroring every
 * other gate_grants query in this codebase). Zero or more than one agent holder
 * has no unambiguous wake target, so the caller treats it as "skip silently" —
 * the same posture task_verdict takes when a capability isn't resolvable to a
 * sole actor.
 */
export async function resolveSoleGateOwnerAgent(env: Env, gateOwner: string): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT principal_id FROM gate_grants WHERE capability = ?1 AND principal_type = 'agent'`,
  )
    .bind(gateOwner)
    .all<{ principal_id: string }>()
  const results = rows.results ?? []
  return results.length === 1 ? results[0].principal_id : null
}

// ── Flight-008 Slice 2 (mupot#1061, Safe Approvals Triage) ───────────────────
//
// A named, currently-active gate lane owner — the read-side fact a triage UI
// needs before it is safe to offer an Approve/Reject control at all. This
// generalises resolveSoleGateOwnerAgent (above) in two ways the dashboard
// needs and the auto-wake path does not:
//   1. Member principals too — humans hold gate_grants rows exactly like
//      agents do (e.g. the /approvals member path in tasks/index.ts), so a
//      "who must approve" projection that only resolves agents would render
//      every human-owned gate as unowned.
//   2. Liveness — a grant to a PAUSED agent or a SUSPENDED member is not a
//      safe target: the capability nominally has a holder, but no one who can
//      actually act on it. That holder is surfaced (for the blocker-reason
//      text) but resolvable stays false.
//
// Same posture as resolveSoleGateOwnerAgent on cardinality: zero or more than
// one holder has no unambiguous accountable owner, so both collapse to
// "unresolved" rather than guessing. Callers must never render a verdict
// control when resolvable is false.

export interface GateOwnerHolder {
  readonly principalType: GatePrincipalType
  readonly principalId: string
  readonly displayName: string
  readonly active: boolean
}

export type GateOwnerUnresolvedReason = 'absent' | 'no_grant' | 'multiple_grants' | 'inactive'

export type GateOwnerResolution =
  | { readonly resolvable: true; readonly capability: string; readonly holder: GateOwnerHolder }
  | {
      readonly resolvable: false
      readonly capability: string | null
      readonly reason: GateOwnerUnresolvedReason
      readonly holder: GateOwnerHolder | null
    }

interface GateOwnerHolderRow {
  principal_type: GatePrincipalType
  principal_id: string
  display_name: string | null
  principal_status: string | null
}

export async function resolveGateOwner(env: Env, gateOwner: string | null): Promise<GateOwnerResolution> {
  if (!gateOwner) return { resolvable: false, capability: null, reason: 'absent', holder: null }

  const rows = await env.DB.prepare(
    `SELECT g.principal_type, g.principal_id,
            CASE WHEN g.principal_type = 'agent' THEN a.name ELSE m.display_name END AS display_name,
            CASE WHEN g.principal_type = 'agent' THEN a.status ELSE m.status END AS principal_status
       FROM gate_grants g
       LEFT JOIN agents  a ON g.principal_type = 'agent'  AND a.id = g.principal_id
       LEFT JOIN members m ON g.principal_type = 'member' AND m.id = g.principal_id
      WHERE g.capability = ?1`,
  )
    .bind(gateOwner)
    .all<GateOwnerHolderRow>()

  const results = rows.results ?? []
  if (results.length === 0) return { resolvable: false, capability: gateOwner, reason: 'no_grant', holder: null }
  if (results.length > 1) return { resolvable: false, capability: gateOwner, reason: 'multiple_grants', holder: null }

  const row = results[0]
  const holder: GateOwnerHolder = {
    principalType: row.principal_type,
    principalId: row.principal_id,
    displayName: row.display_name ?? row.principal_id,
    active: row.principal_status === 'active',
  }
  if (!holder.active) return { resolvable: false, capability: gateOwner, reason: 'inactive', holder }
  return { resolvable: true, capability: gateOwner, holder }
}

/** Resolve several gate_owner capabilities in parallel, de-duplicated — the
 * batch-friendly counterpart to resolveGateOwner for list surfaces (e.g. the
 * /approvals queue) where many rows commonly share the same capability. */
export async function resolveGateOwners(
  env: Env,
  gateOwners: ReadonlyArray<string | null>,
): Promise<Map<string, GateOwnerResolution>> {
  const distinct = Array.from(new Set(gateOwners.filter((v): v is string => Boolean(v))))
  const map = new Map<string, GateOwnerResolution>()
  await Promise.all(distinct.map(async (capability) => {
    map.set(capability, await resolveGateOwner(env, capability))
  }))
  return map
}

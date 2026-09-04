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

// ── mupot#1080 — the write path's own liveness check ──────────────────────────
//
// callerHoldsGateCapability (src/tasks/index.ts) previously ran a bare
// `SELECT 1 FROM gate_grants WHERE capability=... AND principal_type=... AND
// principal_id=...` existence check — it never asked whether the principal
// BEHIND the grant row was still active. Consequence: suspending a member or
// pausing an agent did not revoke their gate-verdict authority as long as the
// gate_grants row itself survived (grants are revoked by a separate, explicit
// admin action — src/gates/grants.ts revokeGateCapability — not by member/agent
// status changes).
//
// hasActiveGateGrant is that missing join, and it is now the ONE place either
// side of the read/write seam evaluates "does this grant currently authorize
// its holder" — the write path (callerHoldsGateCapability) and any future
// read-side accounting both call this rather than re-deriving their own
// existence query, which is exactly how the read side (a resolveGateOwner-
// shaped resolver) and the write side drifted apart in the first place
// (mupot#1080/#1081 post-mortem: "read/write predicate drift is the root
// cause, not either implementation").
//
// agents.status CHECK is ('active','paused'); members.status CHECK is
// ('active','suspended') — two different vocabularies, so this cannot be one
// shared column name across a UNION; principalType selects the join target.
export async function hasActiveGateGrant(
  env: Env,
  capability: string,
  principalType: GatePrincipalType,
  principalId: string,
): Promise<boolean> {
  const row =
    principalType === 'agent'
      ? await env.DB.prepare(
          `SELECT 1 FROM gate_grants g
             JOIN agents a ON a.id = g.principal_id
            WHERE g.capability = ?1 AND g.principal_type = 'agent' AND g.principal_id = ?2
              AND a.status = 'active'
            LIMIT 1`,
        )
          .bind(capability, principalId)
          .first<{ 1: number }>()
      : await env.DB.prepare(
          `SELECT 1 FROM gate_grants g
             JOIN members m ON m.id = g.principal_id
            WHERE g.capability = ?1 AND g.principal_type = 'member' AND g.principal_id = ?2
              AND m.status = 'active'
            LIMIT 1`,
        )
          .bind(capability, principalId)
          .first<{ 1: number }>()
  return row !== null
}

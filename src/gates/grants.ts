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

/** Gate capabilities are named `gate:<owner>` (e.g. gate:kasra-core). */
const GATE_CAPABILITY_RE = /^gate:[a-zA-Z0-9][a-zA-Z0-9:_-]{0,120}$/

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

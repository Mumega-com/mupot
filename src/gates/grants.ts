// mupot — gate_grants service (shared by HTTP /api/gates/grants and MCP tools).
//
// Only org owner/admin may grant/revoke. Rows live in gate_grants (migration 0008).
// INSERT OR IGNORE keeps grant idempotent; revoke is a hard DELETE (verdict receipts
// remain the audit trail).

import type { Env, Task } from '../types'

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


export interface GatePrincipalRef {
  readonly type: GatePrincipalType
  readonly id: string
}

export type GateOwnerResolution =
  | {
      readonly status: 'resolved'
      readonly capability: string
      readonly principal: GatePrincipalRef
      readonly active_holders: readonly GatePrincipalRef[]
      readonly inactive_holders: readonly GatePrincipalRef[]
      readonly grant_count: number
    }
  | {
      readonly status: 'ambiguous'
      readonly capability: string
      readonly active_holders: readonly GatePrincipalRef[]
      readonly inactive_holders: readonly GatePrincipalRef[]
      readonly grant_count: number
    }
  | {
      readonly status: 'no_live_holder'
      readonly capability: string
      readonly active_holders: readonly GatePrincipalRef[]
      readonly inactive_holders: readonly GatePrincipalRef[]
      readonly grant_count: number
    }

interface GateOwnerPrincipalRow {
  principal_type: GatePrincipalType
  principal_id: string
  agent_status: string | null
  member_status: string | null
}

/**
 * Resolve a gate_owner capability to its live principal(s).
 *
 * Gate ownership liveness is principal authority, not presence telemetry. The
 * existing write-side predicate `hasActiveGateGrant` uses agents.status and
 * members.status, so this read path deliberately uses those same rows and
 * status values. `peers`, `module_registry`, and `fleet_agents` may describe
 * runtime or attach presence and may contradict one another; none is
 * authoritative for gate ownership, and no third liveness predicate belongs
 * here.
 *
 * The function name is retained because this is the existing wake seam, but a
 * nullable agent id is no longer an honest result: member principals are valid,
 * multiple live holders are a visible ambiguity, and zero live holders names
 * the capability whose wake cannot proceed.
 */
export async function resolveSoleGateOwnerAgent(env: Env, gateOwner: string): Promise<GateOwnerResolution> {
  const rows = await env.DB.prepare(
    `SELECT g.principal_type, g.principal_id,
            a.status AS agent_status,
            m.status AS member_status
       FROM gate_grants g
       LEFT JOIN agents a
         ON g.principal_type = 'agent' AND a.id = g.principal_id
       LEFT JOIN members m
         ON g.principal_type = 'member' AND m.id = g.principal_id
      WHERE g.capability = ?1
      ORDER BY g.principal_type ASC, g.principal_id ASC`,
  )
    .bind(gateOwner)
    .all<GateOwnerPrincipalRow>()

  const activeHolders: GatePrincipalRef[] = []
  const inactiveHolders: GatePrincipalRef[] = []
  for (const row of rows.results ?? []) {
    const principal: GatePrincipalRef = { type: row.principal_type, id: row.principal_id }
    const status = row.principal_type === 'agent' ? row.agent_status : row.member_status
    if (status === 'active') activeHolders.push(principal)
    else inactiveHolders.push(principal)
  }

  const common = {
    capability: gateOwner,
    active_holders: activeHolders,
    inactive_holders: inactiveHolders,
    grant_count: (rows.results ?? []).length,
  }
  if (activeHolders.length === 1) {
    return { ...common, status: 'resolved', principal: activeHolders[0] }
  }
  if (activeHolders.length > 1) return { ...common, status: 'ambiguous' }
  return { ...common, status: 'no_live_holder' }
}

const MAX_GATE_WAKE_NOTICE_CHARS = 2000

/**
 * Keep the latest wake outcome on the task row so task, board, and list reads
 * show why a review was not delivered. This is operational metadata only: it
 * never changes task status or verdict authority.
 */
export async function persistGateWakeNotice(env: Env, taskId: string, notice: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET gate_wake_notice = ?1 WHERE id = ?2`,
  )
    .bind(notice.slice(0, MAX_GATE_WAKE_NOTICE_CHARS), taskId)
    .run()
}

/**
 * Hydrate the optional wake notice only for operator-facing task surfaces.
 * Execution projections intentionally do not select this post-0148 column:
 * several compatibility fixtures and legacy consumers build an older task
 * shape. A missing column is therefore an explicit legacy-schema fallback,
 * while every other read error remains visible to the caller.
 */
export async function loadGateWakeNotices(env: Env, tasks: readonly Task[]): Promise<Task[]> {
  if (tasks.length === 0) return [...tasks]
  const ids = tasks.map((task) => task.id)
  const placeholders = ids.map(() => '?').join(', ')
  try {
    const rows = await env.DB.prepare(
      `SELECT id, gate_wake_notice FROM tasks WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ id: string; gate_wake_notice: string | null }>()
    const notices = new Map((rows.results ?? []).map((row) => [row.id, row.gate_wake_notice]))
    return tasks.map((task) => ({
      ...task,
      gate_wake_notice: notices.get(task.id) ?? null,
    }))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/no such column:\s*gate_wake_notice/i.test(detail)) return [...tasks]
    throw error
  }
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
// agents.status CHECK is ('active','paused','inactive') — CORRECTED
// (mupot#1319 gate WARN-1: this previously said ('active','paused'),
// stale since migrations/0049_agent_status_inactive.sql widened the enum to
// add 'inactive' for a dead/retired identity, distinct from 'paused' — a
// temporary rest. The CODE was always correct regardless: `a.status =
// 'active'` fails closed on ANY non-active value, 'paused' and 'inactive'
// alike; only this comment's enumeration was wrong). members.status CHECK is
// ('active','suspended') — two different vocabularies, so this cannot be one
// shared column name across a UNION; principalType selects the join target.
//
// OPERATOR-VISIBLE BEHAVIOUR CHANGE (this IS #1080's intended fix, not a
// side effect, but nothing warns at the toggle site that revokes it):
// PAUSING an agent — a trivially reversible dashboard toggle, and 0049
// documents 'paused' as temporary rest, not retirement — now SILENTLY
// revokes that agent's gate-verdict authority for as long as it stays
// paused, even though its gate_grants row is untouched. Before this fix a
// paused agent's stale grant still worked; that was #1080's whole finding.
// An operator pausing an agent for an unrelated reason (cost, a bug, a
// vacation) may not expect that click to ALSO strip its verdict authority —
// it does, immediately and reversibly (resume by un-pausing).
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

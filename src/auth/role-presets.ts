// mupot — role presets for scoped-API-key minting.
//
// A preset maps a named role intent to:
//   - role: the Capability rank minted on the capabilities table
//   - scopeType / scopeId (resolved at mint time when dynamic, e.g. squad:<id>)
//   - allowlist: the tool / surface checks that HONOUR this scope (documenting
//     the contract the gate is supposed to enforce).
//   - denylist: capabilities explicitly NOT granted (blast-radius documentation
//     for the admin minting the key).
//
// ENFORCEMENT STATUS (read this before shipping a key):
//
//   The current capability system is RANK-ONLY on the 5-level ladder
//   (owner/admin/lead/member/observer). The `capabilities` table stores (scope,
//   rank) pairs — NOT a list of surface names like "outreach:send-gated". A
//   token minted from these presets IS correctly scoped (e.g. squad-scoped
//   member cannot touch org-level paths) and IS correctly ranked, BUT the
//   per-surface deny list below (e.g. "no mcpwp:write") is DOCUMENTATION ONLY
//   today — there is no route-level gate that reads the allowlist/denylist.
//   A sales-rep token is rank=member + scope=squad:sales; any route that checks
//   `hasCapability(grants, 'org', null, 'admin')` will correctly deny it.
//   Routes that do NOT call `requireCapability` at all (non-gated surfaces) are
//   accessible to any authenticated member regardless of preset.
//
//   Follow-up required (note this PR): add `requireCapability` gates on
//   outreach:send, mcpwp:write, budget:write, and provision paths so the
//   ALLOW/DENY lists below become real enforcement, not policy comments.
//
// Adding a preset: add a new entry below; pick the tightest rank + scope.
// Removing a preset: mark deprecated; do not delete (existing tokens reference
// their preset by id in the token label for audit tracing).

import type { Capability, CapabilityScopeType } from '../types'

// ── preset shape ───────────────────────────────────────────────────────────────

export interface RolePreset {
  /** Machine-readable id (stable). */
  id: string
  /** Human-readable display name. */
  label: string
  /** Short description shown in the guide panel. */
  description: string
  /** Capability rank minted on the target scope. */
  role: Capability
  /** Scope type for the capability grant. */
  scopeType: CapabilityScopeType
  /**
   * Scope hint for the UI: how to pick the scope_id.
   * 'org'   — always null (no picker needed).
   * 'squad' — admin picks a squad from the org's squad list.
   * 'department' — admin picks a department.
   */
  scopeHint: 'org' | 'squad' | 'department'
  /** Surfaces explicitly allowed — shown in the guide panel (documented only). */
  allows: string[]
  /** Surfaces explicitly denied — shown in the guide panel (documented only). */
  denies: string[]
}

// ── presets ────────────────────────────────────────────────────────────────────

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'sales-rep',
    label: 'Sales Rep',
    description:
      'Front-line sales: read + draft outreach for one squad. Can send gated outreach (human-approved). No admin, no cross-squad, no budget write.',
    role: 'member',
    scopeType: 'squad',
    scopeHint: 'squad',
    allows: [
      'leads:read',
      'leads:write',
      'outreach:draft',
      'outreach:send-gated',
      'content:read',
      'pipeline:read',
    ],
    denies: [
      'admin',
      'mint-tokens',
      'provision',
      'cross-squad',
      'cross-tenant',
      'mcpwp:write',
      'budget:write',
      'outreach:send-ungated',
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    description:
      'Org-wide administrator. Can manage members, tokens, departments, squads, agents. Cannot mint owner-level tokens.',
    role: 'admin',
    scopeType: 'org',
    scopeHint: 'org',
    allows: [
      'members:read',
      'members:write',
      'tokens:mint',
      'departments:write',
      'squads:write',
      'agents:write',
      'settings:write',
      'content:write',
      'outreach:send-gated',
    ],
    denies: [
      'owner',
      'mint-owner-tokens',
      'cross-tenant',
    ],
  },
  {
    id: 'observer',
    label: 'Observer',
    description:
      'Read-only access to a squad. Can read tasks, pipeline, and content. Cannot write or send anything.',
    role: 'observer',
    scopeType: 'squad',
    scopeHint: 'squad',
    allows: [
      'tasks:read',
      'pipeline:read',
      'content:read',
      'agents:read',
    ],
    denies: [
      'write',
      'mint-tokens',
      'provision',
      'outreach:send',
      'settings:write',
    ],
  },
] as const

// ── lookup helpers ─────────────────────────────────────────────────────────────

export function findPreset(id: string): RolePreset | null {
  return ROLE_PRESETS.find((p) => p.id === id) ?? null
}

export function isValidPresetId(id: unknown): id is string {
  return typeof id === 'string' && ROLE_PRESETS.some((p) => p.id === id)
}

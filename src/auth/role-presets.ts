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
// ENFORCEMENT STATUS (updated #106):
//
//   Rank ladder (observer/member/lead/admin/owner) is enforced server-side via
//   requireCapability and requireOrgCapability middlewares.
//
//   Per-surface caps (the allows/denies lists below) are now ENFORCED (#106):
//   - At mint time, mintScopedKey writes one gate_grants row per entry in
//     preset.allows (INSERT OR IGNORE — idempotent on re-mint).
//   - hasSurfaceCap/requireSurfaceCap read those rows at route-level gates.
//   - Owner/admin tokens bypass hasSurfaceCap (rank is sufficient for them).
//
//   Surfaces enforced as of PR #106:
//     outreach:send-gated  → POST /api/tasks/:id/verdict (gate:loops, approve)
//     content:write        → POST /brain/loops/:id/control (all actions)
//     budget:write         → POST /brain/loops/:id/control (budget_override only)
//
//   Gap (no route exists yet):
//     mcpwp:write          → no mcpwp write route in this codebase; requireSurfaceCap
//                            ready to wire when the route lands.
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
      'Front-line sales: read + draft outreach for one team. Can send gated outreach (human-approved). No admin, no cross-team, no budget write.',
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
      'Organization-wide administrator. Can manage people, tokens, departments, teams, and AI agents. Cannot provision owner-level tokens.',
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
      'Read-only access to a team. Can read tasks, pipeline, and content. Cannot write or send anything.',
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
  {
    id: 'brain',
    label: 'Brain (prioritizer)',
    description:
      'Autonomous prioritizer (e.g. a sovereign Hermes brain). Reads the task board org-wide and rests when nothing changed; at most emits a gated priority signal. Cannot write, mint, send outreach, change settings, or cross tenant. Least-privilege by construction — a runaway brain with this key can only read and rest. Dispatch (signal:send-gated) is intentionally NOT granted here yet: until the signal surface is wired + enforced, the brain fails CLOSED on dispatch (read + rest only). Add signal:send-gated when that surface lands.',
    role: 'observer',
    scopeType: 'org',
    scopeHint: 'org',
    allows: [
      'tasks:read',
      'pipeline:read',
      'agents:read',
    ],
    denies: [
      'write',
      'mint-tokens',
      'provision',
      'outreach:send',
      'content:write',
      'budget:write',
      'settings:write',
      'cross-squad',
      'cross-tenant',
      'mcpwp:write',
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

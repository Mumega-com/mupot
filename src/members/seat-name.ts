// mupot#1794 W4 — the ONE place a seat agent's display name is derived. Pure: no I/O, no env, no clock.
//
// HARD RULE: a derived (or client-claimed) name is a LABEL, never authority. Seat identity is keyed
// on (tenant, member, harness, key_hash) only (src/members/seat-key.ts); the slug is derived from
// the key hash, never from this name; and a name never adopts, matches or selects an existing agent.
// Nothing may read this value back to make an authorization or lookup decision.
//
// This function is deliberately replaceable: a later wave can swap the implementation (e.g.
// runtime-host-tenant/project-role names from MCP roots) without touching seat resolution, so long as
// it stays a pure SeatSignals -> label mapping.

import { sanitizeLabel } from './harness'

export interface SeatSignals {
  /** Harness kind label (e.g. cursor, claude-code, codex, ci). Stored on harnesses.kind. */
  harnessKind: string
  /** Harness display label (OAuth client name or the token's label). Stored on harnesses.client_name. */
  harnessLabel: string
  /** The owning member's own display name (already org-visible), or a short hash fallback. */
  memberLabel: string
  /** Tenant slug (env-derived). Unused by the current format; reserved for richer names. */
  tenant: string
  /** Normalised seat-key components (labels). */
  project: string
  /** Last folder segment, else the project (never a full path). */
  workspaceLabel: string
  thread: string
  /** Optional client-declared MCP roots / workspace folders. Unused today; reserved. Never authority. */
  clientRoots?: readonly string[]
}

const NAME_MAX = 120

/** Charset-limited, length-capped, so a client label such as "River" / "Kasra" cannot read as that
 *  identity beyond what the member-name prefix already makes unambiguous. */
function cleanClientLabel(raw: string, max: number): string {
  return raw.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function deriveSeatName(s: SeatSignals): string {
  const clientLabel = cleanClientLabel(s.harnessLabel, 24) || s.harnessKind
  return sanitizeLabel(
    [s.memberLabel, clientLabel, s.project, s.workspaceLabel !== s.project ? s.workspaceLabel : ''].filter(Boolean).join(' · '),
    NAME_MAX,
  )
}

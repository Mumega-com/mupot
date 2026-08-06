// The provenance trust boundary, defined once.
//
// migrations/0077 states the boundary as `external_source IS NULL` versus `IS NOT NULL`
// (and `source_pot` likewise). Every runtime check used to spell that with JavaScript
// truthiness, which disagrees with SQL about exactly one value: the empty string is
// NON-NULL in the database and FALSY in JavaScript. An adversarial gate reproduced the
// consequence — a task stored with `external_source=''` kept its assignee and executed
// through to a model turn, because SQL called the row external and the runtime called it
// first-party.
//
// This module exists so that boundary has ONE definition rather than a correct-looking
// copy at each call site. The copies were individually right and collectively fragile:
// the next one written from memory is the one that reintroduces truthiness.
//
// It deliberately lives outside src/agents/execute.ts so the REST and MCP guards can use
// it without importing the execution path.

/** The shape any provenance decision needs. Deliberately structural, not `Task`. */
export interface ProvenanceBearing {
  readonly source_pot?: string | null
  readonly external_source?: string | null
}

/**
 * True when a row did not originate locally.
 *
 * Explicit `!= null`, matching the migration exactly: anything PRESENT is external, and
 * only literal absence is trusted-local. That includes values the create-time validation
 * would reject but which could reach a reader another way — a legacy row, a direct D1
 * write, a restore. Fail closed: ambiguous provenance is untrusted provenance.
 */
export function isExternallySourced(task: ProvenanceBearing): boolean {
  return task.source_pot != null || task.external_source != null
}

/**
 * The marker to label untrusted content with, preferring the pot over the integration.
 * Returns null only when the row is genuinely local.
 */
export function externalMarker(task: ProvenanceBearing): string | null {
  if (task.source_pot != null) return task.source_pot
  if (task.external_source != null) return task.external_source
  return null
}

/**
 * Whitespace that counts as "blank" provenance, kept in one place because it must match
 * the SQL side of the same invariant.
 *
 * migrations/0078's first version used SQLite's one-argument `TRIM`, which strips only
 * ORDINARY SPACES — so `char(9)` (tab) and `char(10)` (newline) passed the trigger and
 * were stored as provenance markers. The set below is the same one the migration passes
 * explicitly to two-argument `TRIM`. If either changes, both must.
 */
export const BLANK_PROVENANCE_CHARS = ' \t\n\v\f\r'

/** True when a supplied marker is present but carries no attributable content. */
export function isBlankProvenance(value: string): boolean {
  for (const ch of value) {
    if (!BLANK_PROVENANCE_CHARS.includes(ch)) return false
  }
  return true
}

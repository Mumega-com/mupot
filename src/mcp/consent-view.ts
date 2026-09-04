import type { Capability, CapabilityGrant } from '../types'
import { capabilityRank } from '../auth/capability'

/**
 * Presentation logic for the OAuth consent screen.
 *
 * Split out from oauth-authorize.ts deliberately: this is the layer that decides
 * what a person understands before a token is minted, and it is worth testing
 * without standing up an OAuth flow to do it.
 *
 * The problem being solved. The consent screen rendered every option as one grey
 * box carrying a run-on line of raw scope identifiers:
 *
 *   capabilities this session would carry: squad:3674d955-067f-4821-86a0-c2fa03e30ff9
 *   → lead, squad:squad-core → lead, org:mumega → admin, ...
 *
 * Two defects in one line. Consent given against an opaque identifier is not
 * informed consent, and organisation admin — the highest authority the system
 * grants — appeared as the fifth item of a sentence, styled identically to an
 * option carrying nothing at all.
 *
 * What this module does NOT do: it never filters, summarises away, or otherwise
 * hides a grant. The original code's comment is right that an authorisation
 * surface must show every field literally. Literal and legible are not in
 * tension — every grant still appears, grouped by tier, highest first, with its
 * scope named. Nothing is dropped; only the ordering and the wording change.
 */

/**
 * Ranking is NOT redefined here. `auth/capability.ts` already owns the ladder
 * (observer=1 … owner=5, higher is more powerful) and it is the same ladder the
 * authorisation checks use. Defining a second rank in the presentation layer
 * would mean a screen could order grants by one scale while the server enforced
 * another, and the two would drift silently. Import the canonical one.
 */

/** Capabilities at or above 'admin' can grant, revoke and provision. */
export function isElevated(capability: Capability): boolean {
  return capabilityRank(capability) >= capabilityRank('admin')
}

/**
 * True when this session would carry admin (or owner) over the whole
 * organisation — the single most consequential thing a consent screen can hand
 * out, and the fact most worth a badge.
 */
export function carriesOrgAdmin(grants: CapabilityGrant[]): boolean {
  return grants.some((g) => g.scope_type === 'org' && isElevated(g.capability))
}

/** The most powerful capability in the set, or null when there are none. */
export function highestCapability(grants: CapabilityGrant[]): Capability | null {
  let best: Capability | null = null
  for (const g of grants) {
    if (best === null || capabilityRank(g.capability) > capabilityRank(best)) best = g.capability
  }
  return best
}

export interface ScopeNames {
  /** squad id → display name */
  squads: Map<string, string>
  /** department id → display name */
  departments: Map<string, string>
  /** the organisation's display name, for org-scoped grants */
  org: string
}

/**
 * Resolves one grant's scope to something a person can read.
 *
 * Falls back to the raw identifier when a name is unknown rather than hiding the
 * grant. An unnamed scope is still a real grant and must stay visible — showing
 * `squad:ab6d4495…` is bad, but showing nothing would be worse.
 */
export function scopeLabel(grant: CapabilityGrant, names: ScopeNames): string {
  // Org grants carry no meaningful scope id to a reader — there is one
  // organisation — so they always render as its name.
  if (grant.scope_type === 'org') return names.org
  const table = grant.scope_type === 'department' ? names.departments : names.squads
  const id = grant.scope_id
  if (!id) return grant.scope_type
  return table.get(id) ?? id
}

export interface GrantGroup {
  capability: Capability
  /** Human-readable scope names, in the order the grants were given. */
  scopes: string[]
  /** True when this row should read as a warning rather than a fact. */
  elevated: boolean
  /** True when the group includes an organisation-wide scope. */
  orgWide: boolean
}

/**
 * Groups a session's grants by capability tier, most powerful first, with every
 * scope named. One row per tier keeps a long grant list scannable while still
 * naming every scope, so nothing is lost relative to the raw line it replaces.
 */
export function summarizeGrants(grants: CapabilityGrant[], names: ScopeNames): GrantGroup[] {
  const byCapability = new Map<Capability, GrantGroup>()

  for (const g of grants) {
    let group = byCapability.get(g.capability)
    if (!group) {
      group = { capability: g.capability, scopes: [], elevated: isElevated(g.capability), orgWide: false }
      byCapability.set(g.capability, group)
    }
    group.scopes.push(scopeLabel(g, names))
    if (g.scope_type === 'org') group.orgWide = true
  }

  // Most powerful first: the thing most worth noticing is read first, not last.
  return [...byCapability.values()].sort(
    (a, b) => capabilityRank(b.capability) - capabilityRank(a.capability),
  )
}

/** Every scope id referenced by a set of grants, so only those need naming. */
export function referencedScopeIds(grants: CapabilityGrant[]): { squads: string[]; departments: string[] } {
  const squads = new Set<string>()
  const departments = new Set<string>()
  for (const g of grants) {
    if (!g.scope_id) continue
    if (g.scope_type === 'squad') squads.add(g.scope_id)
    else if (g.scope_type === 'department') departments.add(g.scope_id)
  }
  return { squads: [...squads], departments: [...departments] }
}

/**
 * The haystack the client-side filter matches against.
 *
 * Lower-cased and joined with spaces so a person can type a slug, a display
 * name, a squad, or a capability word and find the seat they mean. Built
 * server-side and shipped as a data attribute so the filter never has to parse
 * rendered markup — reading the DOM's text would also match the surrounding
 * chrome and would silently change meaning if the layout changed.
 */
export function searchHaystack(input: {
  name: string
  slug: string
  squad_name: string
  grants: CapabilityGrant[]
  names: ScopeNames
}): string {
  const parts = [input.name, input.slug, input.squad_name]
  for (const g of input.grants) {
    parts.push(g.capability)
    parts.push(scopeLabel(g, input.names))
  }
  return parts.join(' ').toLowerCase()
}

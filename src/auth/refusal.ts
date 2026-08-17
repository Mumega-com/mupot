// mupot — legible authorization refusals for the org-admin gate.
//
// WHY THIS EXISTS
// A 403 that states only its REQUIREMENT ("Minting an agent token requires owner
// or admin.") tells the reader nothing about their own STATE. From that string
// alone you cannot distinguish:
//   - you are a plain member                       (the ordinary answer)
//   - your session resolved to an unexpected member row
//   - your grant EXISTS, but on the plane this page does not read
//   - something is broken
// The last one is not hypothetical: it is the defect shipped alongside this
// module. isOrgAdmin read only the coarse legacy `users.role` column while the
// real grant lived in `capabilities` (scope 'org' → 'owner'), so the org owner
// was refused by their own pot and no surface said why. Hours went into asking
// for a grant that had already been made, because nothing named what was held.
//
// POSTURE
// Copied from boot_context's `channel_limits` block — the most self-explaining
// surface in this codebase. Three lines: what you ARE, what is REQUIRED, what
// would CHANGE IT. Consistent with mupot#1130 (granted vs effective capability
// plus a machine-readable reason on `orient`).
//
// PRIVACY INVARIANT (do not weaken)
// Every field here is derived from the CALLER'S OWN AuthContext, and the message
// is returned only to that already-authenticated caller, about themselves. Never
// name another member, never enumerate the org, never emit a scope id or a raw
// grant row. The reader learns their own standing and nothing else.
//
// SCOPE INVARIANT
// This module is presentation only. It never decides anything: `isOrgAdmin` in
// ./capability.ts is the sole authority, the status code stays 403, and the
// refused set is unchanged. Legibility of a refusal, not its outcome.

import type { AuthContext, Capability, CapabilityGrant } from '../types'
import { capabilityRank } from './capability'

/** A refusal offers somewhere to GO. Every href here must resolve to a route the
 *  REFUSED principal can actually open — asserted in tests against the live
 *  dashboard route table, not against a hand-kept list. */
export interface RefusalLink {
  readonly href: string
  readonly label: string
}

/** The caller's own standing at ORG scope, as this gate sees it. */
export interface OrgStanding {
  /** The caller's own identifier — their email, or their user id when emailless. */
  readonly principal: string
  /** The coarse legacy org role (users.role). */
  readonly role: AuthContext['role']
  /** Highest ORG-scope capability the caller holds, or null when they hold none. */
  readonly orgCapability: Capability | null
  /** True when the caller holds grants, but not one of them is at org scope —
   *  the "your grant is on a different plane" case, which is the one that looks
   *  like a bug to the reader and therefore must be said out loud. */
  readonly hasScopedGrantsOnly: boolean
}

const LADDER: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']

function highestOrgCapability(grants: readonly CapabilityGrant[] | undefined): Capability | null {
  if (!grants) return null
  let best: Capability | null = null
  for (const g of grants) {
    if (g.scope_type !== 'org') continue
    if (!LADDER.includes(g.capability)) continue
    if (best === null || capabilityRank(g.capability) > capabilityRank(best)) best = g.capability
  }
  return best
}

/**
 * describeOrgStanding — what this principal holds, from their own AuthContext.
 *
 * Reads `capabilities` (the AMBIENT, post-ceiling view) and never
 * `latentCapabilities`. On a directory-channel session the B1 ceiling zeroes
 * ambient authority; reporting the latent grants there would tell the reader
 * they hold something the gate deliberately does not honour.
 */
export function describeOrgStanding(auth: AuthContext | null | undefined): OrgStanding {
  if (!auth) {
    return { principal: 'an unidentified session', role: 'member', orgCapability: null, hasScopedGrantsOnly: false }
  }
  const email = auth.email?.trim()
  const orgCapability = highestOrgCapability(auth.capabilities)
  return {
    principal: email && email.length > 0 ? email : auth.userId,
    role: auth.role,
    orgCapability,
    hasScopedGrantsOnly: orgCapability === null && (auth.capabilities?.length ?? 0) > 0,
  }
}

/** The three lines of a refusal: who you are, what is required, what to do. */
export interface RefusalLines {
  /** Names the signed-in principal and the standing they actually hold. */
  readonly identity: string
  /** What the refused action requires. */
  readonly requirement: string
  /** The concrete next step that would grant access. */
  readonly nextStep: string
}

function standingPhrase(s: OrgStanding): string {
  if (s.orgCapability !== null) return `org capability "${s.orgCapability}"`
  if (s.hasScopedGrantsOnly) return 'squad-scoped grants only, none at org scope'
  return 'no capability grant on this workspace'
}

/**
 * orgAdminRefusalLines — the shared wording for every isOrgAdmin refusal.
 *
 * `action` is the thing that was refused, phrased as a subject: "Minting an
 * agent token", "Deployment", "Creating an agent".
 */
export function orgAdminRefusalLines(action: string, auth: AuthContext | null | undefined): RefusalLines {
  const s = describeOrgStanding(auth)
  return {
    identity: `You are signed in as ${s.principal} — org role "${s.role}", ${standingPhrase(s)}.`,
    requirement: `${action} requires owner or admin at ORG scope.`,
    nextStep: s.hasScopedGrantsOnly
      ? 'To get access, ask an org owner or admin to grant you the "admin" capability at ORG scope. A squad or department grant will not help — this gate reads org scope only, and grants never widen upward.'
      : 'To get access, ask an org owner or admin to grant you the "admin" capability at ORG scope.',
  }
}

/** One-line form, for logs and JSON `detail`. */
export function orgAdminRefusalText(action: string, auth: AuthContext | null | undefined): string {
  const l = orgAdminRefusalLines(action, auth)
  return `${l.identity} ${l.requirement} ${l.nextStep}`
}

/**
 * orgAdminForbiddenPayload — the JSON body for an org-admin refusal.
 *
 * `error` keeps its value and `need` keeps whatever the call site already
 * declared (routes differ: 'admin' on the dashboard, 'owner_or_admin' on the gate
 * -grants API). Everything else is additive, so a client that only reads `error`
 * or `need` is unaffected.
 */
export function orgAdminForbiddenPayload(
  action: string,
  auth: AuthContext | null | undefined,
  links: readonly RefusalLink[] = [],
  need = 'admin',
): {
  error: 'forbidden'
  need: string
  signed_in_as: string
  standing: { role: AuthContext['role']; org_capability: Capability | null; scoped_grants_only: boolean }
  detail: string
  next_step: string
  links: readonly RefusalLink[]
} {
  const s = describeOrgStanding(auth)
  const l = orgAdminRefusalLines(action, auth)
  return {
    error: 'forbidden',
    need,
    signed_in_as: s.principal,
    standing: { role: s.role, org_capability: s.orgCapability, scoped_grants_only: s.hasScopedGrantsOnly },
    detail: `${l.identity} ${l.requirement}`,
    next_step: l.nextStep,
    links,
  }
}

/**
 * ORG_ADMIN_REFUSAL_LINKS — where a refused member is sent. A 403 must not be a
 * dead end.
 *
 * Defined once, here, so the HTML page and the JSON body can never drift.
 *
 * EVERY href is a dashboard GET route a REFUSED principal can actually open.
 * That is not a claim: tests/org-admin-capability-gate.test.ts asserts it twice —
 * once against `dashboardBuiltInGetRoutes` (the live Hono route table, so a
 * rename breaks the test rather than the page) and once by driving a real request
 * as the refused member and requiring a non-403 back.
 *
 * Deliberately NOT listed, though they read as member-ish: /ops, /deployment and
 * /addons are themselves isOrgAdmin-gated, so linking there would bounce the
 * reader off the same wall they just hit. /agents is the "agent page" a refused
 * member CAN open — its GET handler carries no isOrgAdmin gate (it passes
 * isOrgAdmin only as a `canManage` render flag) and loadAllAgents scopes the
 * roster to what the caller may read.
 */
export const ORG_ADMIN_REFUSAL_LINKS: readonly RefusalLink[] = Object.freeze([
  Object.freeze({ href: '/', label: '← Back to overview' }),
  Object.freeze({ href: '/agents', label: 'Agents' }),
])

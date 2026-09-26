// Identity-first human → member resolution.
// Athena 2026-09-02: explicit human_login_identities binding
// (tenant, provider, provider_subject) MUST win over members.email on EVERY
// path. Email is bootstrap-only when no live identity exists.
//
// One resolver. Five call sites. Copying the precedence into each site is
// how site four went unfixed while site one got attention.

import type { Env } from '../types'
import { resolveLoginIdentity } from '../auth/login-identity'
import { decideIdentitylessAttach, type CompetingControlReason } from './exclusive-control'

export const OWNER_LOGIN_EMAILS_KEY = 'owner_login_emails'

export interface ResolveHumanMemberInput {
  tenant: string
  provider?: string | null
  providerSubject?: string | null
  email?: string | null
  /**
   * Resolve ONLY via a live human_login_identities join key/email match
   * (steps 1-2) — never fall through to the members.email bootstrap (step 3)
   * or the owner-alias lookup (step 4). Set by a caller that wants to know
   * "is this human ALREADY identified" without also triggering the
   * identity-less-row bootstrap decision, so it can apply its OWN follow-up
   * (see src/auth/sso.ts's autoEnrollSsoMember, which calls
   * decideIdentitylessAttach itself on a miss here — mupot#1551).
   */
  identityOnly?: boolean
}

export interface ResolvedHumanMember {
  id: string
  status: string
}

/**
 * mupot#1551 round 2 (P0): the tri-state a real ATTACH caller (one that would
 * otherwise INSERT a new member on a miss — e.g. findOrCreateHumanMember)
 * must consume instead of the collapsed `ResolvedHumanMember | null` the
 * plain resolvers below return. Collapsing `denied`/`ambiguous` onto the same
 * `null` a genuine `not_found` produces is exactly what let
 * findOrCreateHumanMember insert a DUPLICATE member for a row that was
 * already someone else's (a live directory-OAuth bearer, a Telegram bind, a
 * case-variant collision) — the same class of bug the SSO fallback had
 * before this file's first mupot#1551 pass, one caller over.
 */
export type ResolveHumanMemberAttachResult =
  | { kind: 'resolved'; member: ResolvedHumanMember }
  | { kind: 'denied'; reason: CompetingControlReason }
  | { kind: 'ambiguous' }
  | { kind: 'not_found' }

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function uniqueOrgOwnerId(env: Env): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS id
       FROM members m
       JOIN capabilities c ON c.member_id = m.id
      WHERE m.tenant = ?1
        AND m.status = 'active'
        AND c.scope_type = 'org'
        AND c.scope_id IS NULL
        AND c.capability = 'owner'
      LIMIT 2`,
  ).bind(env.TENANT_SLUG).all<{ id: string }>()
  const found = rows.results ?? []
  if (found.length !== 1) return null
  return found[0].id
}

async function ownerAliasMemberId(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT value FROM org_settings WHERE key = ?1 LIMIT 1',
  ).bind(OWNER_LOGIN_EMAILS_KEY).first<{ value: string }>()
  if (!row?.value) return null
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return null
    const aliases = parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeEmail)
    if (!aliases.includes(email)) return null
  } catch {
    return null
  }
  return uniqueOrgOwnerId(env)
}

async function memberById(
  env: Env,
  tenant: string,
  memberId: string,
  activeOnly: boolean,
): Promise<ResolvedHumanMember | null> {
  return env.DB.prepare(
    `SELECT id, status FROM members
      WHERE id = ?1 AND tenant = ?2${activeOnly ? " AND status = 'active'" : ''}
      LIMIT 1`,
  ).bind(memberId, tenant).first<ResolvedHumanMember>()
}

/**
 * Resolve a human to one active member.
 * 1. Live (tenant, provider, provider_subject) identity.
 * 2. Live identity whose verified_email matches — ONLY when provider/subject
 *    are absent. A supplied join key that missed must NOT fall through to
 *    email; that is account takeover (fresh subject + victim verified_email).
 *    When provider is present without a subject, the match is also scoped
 *    to that provider (0143: authorization is the join key, not a display
 *    email across providers).
 * 3. members.email. A supplied-but-missed join key may bootstrap ONLY a
 *    member row under EXCLUSIVE CONTROL of no one — mupot#1551, Athena's
 *    ruling: no live identity, no live unbound bearer, no Telegram bind, and
 *    no case-insensitive email collision (decideIdentitylessAttach owns this
 *    check; see src/members/exclusive-control.ts). Email-only (no join key)
 *    still resolves the primary members.email even if that member already
 *    has a live identity whose verified_email differs (write-once email
 *    drift) — that branch never attaches anything, it only reads.
 * 4. owner_login_emails → unique org owner. Same join-key gate as step 2:
 *    never after a supplied-but-missed subject.
 * Missing identity table (migration not applied) falls through to email bootstrap.
 * Any other D1 failure is rethrown — silent email-first is the inversion Athena banned.
 */
export function isMissingHumanLoginIdentitiesTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Match D1/SQLite's current "no such table" wording only. If the engine
  // rewords it, this returns false and the caller THROWS — fail SAFE (an
  // error, not a wrong human). Do not widen the regex to "be helpful".
  return /no such table:\s*human_login_identities/i.test(msg)
}

async function resolveHumanMemberRecordRich(
  env: Env,
  input: ResolveHumanMemberInput,
  activeOnly: boolean,
): Promise<ResolveHumanMemberAttachResult> {
  const tenant = input.tenant
  const joinKeyPresent = !!(input.provider && input.providerSubject)
  try {
    if (input.provider && input.providerSubject) {
      const ident = await resolveLoginIdentity(env, tenant, input.provider, input.providerSubject)
      if (ident) {
        const member = await memberById(env, tenant, ident.member_id, activeOnly)
        return member ? { kind: 'resolved', member } : { kind: 'not_found' }
      }
    }

    const email = input.email ? normalizeEmail(input.email) : ''
    // Step 2 is gated on a missing join key. The ungated version let a
    // never-seen provider_subject inherit a victim member via verified_email.
    if (email && !joinKeyPresent) {
      const identByEmail = input.provider
        ? await env.DB.prepare(
            `SELECT h.member_id AS id, m.status AS status
               FROM human_login_identities h
               JOIN members m ON m.id = h.member_id AND m.tenant = h.tenant
              WHERE h.tenant = ?1 AND lower(h.verified_email) = ?2 AND h.revoked_at IS NULL
                AND h.provider = ?3
                ${activeOnly ? "AND m.status = 'active'" : ''}
              LIMIT 2`,
          ).bind(tenant, email, input.provider).all<ResolvedHumanMember>()
        : await env.DB.prepare(
            `SELECT h.member_id AS id, m.status AS status
               FROM human_login_identities h
               JOIN members m ON m.id = h.member_id AND m.tenant = h.tenant
              WHERE h.tenant = ?1 AND lower(h.verified_email) = ?2 AND h.revoked_at IS NULL
                ${activeOnly ? "AND m.status = 'active'" : ''}
              LIMIT 2`,
          ).bind(tenant, email).all<ResolvedHumanMember>()
      const rows = identByEmail.results ?? []
      if (rows.length === 1) return { kind: 'resolved', member: rows[0] }
      if (rows.length > 1) return { kind: 'ambiguous' }
    }
  } catch (err) {
    if (!isMissingHumanLoginIdentitiesTable(err)) throw err
  }

  if (input.identityOnly) return { kind: 'not_found' }

  const email = input.email ? normalizeEmail(input.email) : ''
  if (!email) return { kind: 'not_found' }

  // Step 3, join-key-present branch (mupot#1551, Athena's ruling Option B):
  // a supplied-but-missed join key may bootstrap ONLY a member row that is
  // still under NO ONE's exclusive control — not merely one with no live
  // identity. decideIdentitylessAttach also fails closed on a live unbound
  // bearer (the legacy public-accept squat) or a bound Telegram chat, and on
  // a case-insensitive email collision (never an arbitrary LIMIT-1 pick).
  // This is the actual attach path — registerWebSession calls
  // linkLoginIdentity right after this resolves — so it gets the strict
  // predicate. Round 2 (P0): the decision's OWN kind is now returned intact,
  // not collapsed to `null` — a real attach caller (findOrCreateHumanMember)
  // must be able to refuse a denial/ambiguity instead of reading it as
  // "no such member" and inserting a duplicate.
  if (joinKeyPresent) {
    const decision = await decideIdentitylessAttach(env, {
      tenant,
      normalizedEmail: email,
      provider: input.provider ?? null,
      subject: input.providerSubject ?? null,
    })
    if (decision.kind === 'eligible') {
      if (!activeOnly || decision.status === 'active') {
        return { kind: 'resolved', member: { id: decision.memberId, status: decision.status } }
      }
      // Eligible but excluded by this caller's own activeOnly filter (a
      // suspended row) — same terminal shape as step 2's activeOnly filter:
      // not a member candidate for this call, but also not a fresh signup
      // target. Step 4 is join-key-gated below regardless, so this always
      // ends the same way whether reported as not_found here or falling
      // through — reported directly for a clearer signal to attach callers.
      return { kind: 'not_found' }
    }
    if (decision.kind === 'denied_competing_control') return { kind: 'denied', reason: decision.reason }
    if (decision.kind === 'ambiguous') return { kind: 'ambiguous' }
    return { kind: 'not_found' }
  }

  // Step 3, email-only branch (no join key at all): a pure resolve-by-email
  // read, never followed by a linkLoginIdentity write from this branch's
  // result (dashboard/projects.ts's own-member lookup; SSO's initial pass,
  // which separately calls decideIdentitylessAttach itself on a miss — see
  // src/auth/sso.ts). Deliberately left lenient: this is the write-once
  // verified_email-drift invariant (mupot#1266 P0-2) — a member whose live
  // identity's verified_email has drifted from members.email must still
  // resolve via their own primary address.
  const byEmail = await env.DB.prepare(
    `SELECT id, status FROM members
      WHERE lower(email) = ?1 AND tenant = ?2 ${activeOnly ? "AND status = 'active'" : ''}
      LIMIT 1`,
  ).bind(email, tenant).first<ResolvedHumanMember>()
  if (byEmail) return { kind: 'resolved', member: byEmail }

  // Step 4: same join-key gate as step 2. A missed subject must not
  // inherit the org owner via an operator alias.
  const ownerId = await ownerAliasMemberId(env, email)
  return ownerId ? { kind: 'resolved', member: { id: ownerId, status: 'active' } } : { kind: 'not_found' }
}

export function resolveHumanMember(
  env: Env,
  input: ResolveHumanMemberInput,
): Promise<ResolvedHumanMember | null> {
  return resolveHumanMemberRecordRich(env, input, false).then((r) =>
    r.kind === 'resolved' ? r.member : null,
  )
}

export async function resolveHumanMemberId(
  env: Env,
  input: ResolveHumanMemberInput,
): Promise<string | null> {
  const rich = await resolveHumanMemberRecordRich(env, input, true)
  return rich.kind === 'resolved' ? rich.member.id : null
}

/**
 * resolveHumanMemberForAttach — the tri-state-aware entry point for any
 * caller that would otherwise INSERT a new member on a plain `null` (e.g.
 * findOrCreateHumanMember). `denied`/`ambiguous` must be refused, never
 * silently treated as `not_found` — see ResolveHumanMemberAttachResult's own
 * doc comment. `activeOnly` defaults to false, matching `resolveHumanMember`
 * (an attach caller's job is to decide whether THIS candidate is safe to
 * bind to, not to pre-filter by status the way a "who is allowed to act"
 * check would).
 */
export function resolveHumanMemberForAttach(
  env: Env,
  input: ResolveHumanMemberInput,
  activeOnly = false,
): Promise<ResolveHumanMemberAttachResult> {
  return resolveHumanMemberRecordRich(env, input, activeOnly)
}

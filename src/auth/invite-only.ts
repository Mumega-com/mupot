// mupot — invite-only sign-in (Hadi, 2026-11-11: "now invite only, if it means anyone from internet").
//
// ONE decision function, `decideSignIn`, used by EVERY door that can give a person a session, a member row or an OAuth grant:
// Google web (/auth/callback), email one-time link, mumega handoff, and the MCP OAuth Google callback. A rule written at each
// door drifted before (the OAuth door lacked the legacy-owner and first-owner rungs), so the rungs live here once.
//
// A person is admitted only if one of:
//  1. OPEN_SIGNUP_ENABLED === 'true' (explicit opt-out; unset or any other value is closed).
//  2. A live login identity for (tenant, provider, subject) whose member is ACTIVE (not suspended, archived or superseded).
//  3. An ACTIVE member row in this tenant with the verified email (an accepted invite creates exactly this row: acceptInvite()
//     in src/members/index.ts is the single-use redemption; provisioning writes the owner's row the same way).
//  4. A legacy `users` row with owner/admin standing for that email (no members bridge exists for those, #1324).
//  5. Google web only: the pot is truly empty and this call wins the atomic first-owner claim (src/auth/first-owner.ts).
// Anything else is refused BEFORE any write: no users row, no members row, no home squad, no session, no consent nonce, no grant.
// Suspended/archived/superseded people are refused with their own message ('inactive'), not the invite message.
//
// The claim in rung 5 is a WRITE (one atomic batch), made only when rungs 1-4 failed. It is done here, not in a later read, so
// two strangers cannot both be admitted on an empty pot and one then left with a stranger session.
//
// No migration. Fails closed: a D1 error throws, it never admits.

import type { Env } from '../types'
import { escapeHtml } from '../lib/html-escape'
import { isLiveMemberId, memberStandingForEmail } from '../members/exclusive-control'
import { resolveHumanMemberForAttach } from '../members/resolve-human-member'
import { claimFirstOwner } from './first-owner'

/** Open sign-up is an explicit opt-in. Exactly the string "true"; unset or anything else is closed. */
export function isOpenSignup(env: Pick<Env, 'OPEN_SIGNUP_ENABLED'>): boolean {
  return env.OPEN_SIGNUP_ENABLED === 'true'
}

export type SignInDoor = 'google_web' | 'email' | 'handoff' | 'oauth_mcp'

export interface SignInInput {
  door: SignInDoor
  /** Verified email from the IdP (may be null for an emailless Google profile). */
  email: string | null
  provider: string
  subject: string | null
  /** The users.id the Google web door would create. Required only for door 'google_web' (rung 5). */
  newUserId?: string
}

export type SignInRefusalReason = 'invite_only' | 'inactive' | 'email_required'

export type SignInDecision =
  | { allowed: true; via: 'open' | 'identity' | 'member' | 'legacy_admin' | 'first_owner' }
  | { allowed: false; reason: SignInRefusalReason }

export async function decideSignIn(env: Env, input: SignInInput): Promise<SignInDecision> {
  if (isOpenSignup(env)) return { allowed: true, via: 'open' }
  const tenant = env.TENANT_SLUG
  const email = input.email ? input.email.trim().toLowerCase() : ''
  let inactive = false

  if (input.subject) {
    const byIdentity = await resolveHumanMemberForAttach(
      env,
      { tenant, provider: input.provider, providerSubject: input.subject, identityOnly: true },
      false,
    )
    if (byIdentity.kind === 'resolved') {
      // #2392: an inactive subject-bound identity must refuse immediately. Do not consult
      // email standing — a different active member sharing the verified email must not
      // override the subject-bound refusal (downstream still prefers the inactive identity).
      if (await isLiveMemberId(env, tenant, byIdentity.member.id)) return { allowed: true, via: 'identity' }
      return { allowed: false, reason: 'inactive' }
    }
  }

  if (email) {
    const standing = await memberStandingForEmail(env, tenant, email)
    if (standing === 'active') return { allowed: true, via: 'member' }
    if (standing === 'inactive') inactive = true

    const legacyAdmin = await env.DB.prepare(
      `SELECT 1 AS present FROM users WHERE lower(email) = ?1 AND role IN ('owner', 'admin') LIMIT 1`,
    )
      .bind(email)
      .first<{ present: number }>()
    if (legacyAdmin && !inactive) return { allowed: true, via: 'legacy_admin' }
  }

  if (input.door === 'google_web' && input.newUserId && !inactive) {
    // #2392: refuse first-owner without a verified email. claimFirstOwner can write an
    // emailless owner users row, but registerWebSession skips identity registration without
    // email and the legacy-owner rung needs one — so the next sign-in locks them out and
    // the pot is no longer empty. Do not invent a subject-only identity path; require email.
    if (!email) return { allowed: false, reason: 'email_required' }
    if (await claimFirstOwner(env, input.newUserId, email)) return { allowed: true, via: 'first_owner' }
  }
  return { allowed: false, reason: inactive ? 'inactive' : 'invite_only' }
}

/** Plain-text refusal for the MCP OAuth callback (nothing was written). Every reason ends with a next step. */
export function refusalText(reason: SignInRefusalReason): string {
  if (reason === 'inactive') {
    return 'This account is not active in this pot (suspended or removed), so it cannot connect. Contact an org admin.'
  }
  if (reason === 'email_required') {
    return 'A verified email is required to sign in to this pot. Sign in again with a Google account that shares a verified email (grant the email scope), then try again.'
  }
  return 'This pot is invite-only. Ask an org admin for an invite, open your invite link, then connect again. '
    + 'If you set this pot up and cannot sign in, contact whoever operates it; an invite will not help you.'
}

/** Browser page for web sign-in refusals. Never says whether the email is known, except the 'inactive' case, which only the
 *  holder of the verified email can reach. */
export function inviteOnlyBody(brand: string, reason: SignInRefusalReason = 'invite_only'): string {
  const b = escapeHtml(brand)
  const heading =
    reason === 'inactive' ? 'This account is not active'
    : reason === 'email_required' ? 'A verified email is required'
    : 'This pot is invite-only'
  const text = escapeHtml(refusalText(reason).replace(/ connect again/, ' sign in again').replace('cannot connect', 'cannot sign in'))
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(heading)} · ${b}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <p>${text}</p>
    </main>
  </body>
</html>`
}

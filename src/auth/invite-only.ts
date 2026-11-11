// mupot — invite-only sign-in (Hadi, 2026-11-11: "now invite only, if it means anyone from internet").
//
// THE RULE. A person arriving from the open internet (Google web sign-in, the MCP OAuth authorize
// flow, email one-time link, mumega handoff) gets a session / member row / OAuth grant ONLY IF the pot
// already knows them:
//   1. a live human_login_identities row for (tenant, provider, subject), or
//   2. a members row in this tenant whose email matches (an accepted invite creates exactly this row:
//      acceptInvite() in src/members/index.ts is the single-use redemption and mints member + grant), or
//   3. a legacy `users` row with owner/admin standing (no members bridge exists for those, #1324), or
//   4. the pot has no users at all AND the caller is the pot's own Google first-owner ceremony
//      (`allowFirstOwner`), so provisioning a fresh pot keeps working.
// Anyone else is refused BEFORE any write: no users row, no members row, no home squad, no session,
// no OAuth consent nonce / grant.
//
// OPT-OUT. OPEN_SIGNUP_ENABLED === 'true' restores the old open behaviour. Unset / anything else = closed.
// No migration: the invite mechanism is the existing invites table + acceptInvite().
//
// Read-only: this module never writes. It fails closed on a D1 error (the caller sees a throw, not a pass).

import type { Env } from '../types'
import { escapeHtml } from '../lib/html-escape'
import { resolveHumanMemberForAttach } from '../members/resolve-human-member'

/** Open sign-up is an explicit opt-in. Exactly the string "true"; unset or anything else is closed. */
export function isOpenSignup(env: Pick<Env, 'OPEN_SIGNUP_ENABLED'>): boolean {
  return env.OPEN_SIGNUP_ENABLED === 'true'
}

export interface SignInStandingInput {
  /** Verified email from the IdP (may be null for an emailless Google profile). */
  email: string | null
  provider: string
  subject: string | null
  /** Only the pot's own Google callback may let the very first user in (the first-owner ceremony). */
  allowFirstOwner?: boolean
}

/** True when this verified identity already has a relationship with the pot (or the pot is open). */
export async function hasSignInStanding(env: Env, input: SignInStandingInput): Promise<boolean> {
  if (isOpenSignup(env)) return true
  const tenant = env.TENANT_SLUG
  const email = input.email ? input.email.trim().toLowerCase() : ''

  // The shared resolver, not a raw email read (mupot#1578/#1583): identity-first, then the members row. Any
  // answer except not_found means a members row already exists for this person. `denied` / `ambiguous` (the row is
  // under another credential's control, or the email collides) still count as KNOWN here: refusing them would lock
  // out an existing member, and the sign-in paths apply their own attach refusal to those cases.
  const known = await resolveHumanMemberForAttach(env, {
    tenant,
    provider: input.provider,
    providerSubject: input.subject,
    email,
  })
  if (known.kind !== 'not_found') return true

  if (email) {
    const legacyAdmin = await env.DB.prepare(
      `SELECT 1 AS present FROM users WHERE lower(email) = ?1 AND role IN ('owner', 'admin') LIMIT 1`,
    )
      .bind(email)
      .first<{ present: number }>()
    if (legacyAdmin) return true
  }

  if (input.allowFirstOwner) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
    if ((count?.n ?? 0) === 0) return true
  }
  return false
}

/** Plain-text refusal for the MCP OAuth callback (nothing was written). */
export const INVITE_ONLY_TEXT =
  'This pot is invite-only. Ask an org admin for an invite, open your invite link, then connect again.'

/** Browser page for web sign-in refusals. No account-existence signal: it never says whether the email is known. */
export function inviteOnlyBody(brand: string): string {
  const b = escapeHtml(brand)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Invite only · ${b}</title>
  </head>
  <body>
    <main>
      <h1>This pot is invite-only</h1>
      <p>${b} does not open accounts to the public. Ask an org admin for an invite, open the invite link they send you, then sign in again.</p>
    </main>
  </body>
</html>`
}

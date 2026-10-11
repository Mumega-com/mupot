// mupot — who is the human behind a verified Access JWT.
//
// Provider 'cloudflare-access', subject = the JWT `sub`, resolved ONLY through an existing, explicit,
// live human_login_identities row (resolveLoginIdentity). There is NO email fallback and NO first-login
// auto-link: this module never writes an identity row. An Access identity nobody linked resolves to
// nothing and the page shows the `sub` so the workspace owner can link it deliberately (once, out of
// band, the same ceremony other providers use; docs/architecture/access-approve-page.md).
//
// The resolved member must be an ACTIVE, unarchived HUMAN: a member row welded to an agent
// (agent_member_bindings) is refused whatever it is named. The legacy org role comes from the resolved
// MEMBER's own email through the shared users-by-email chokepoint (findUserByEmail), never the JWT email.
//
// GET only reads. The deciding POST mints an approver web session ONLY after the caller has passed
// every authority check (routes.ts), because the elevation grant binds to that session: the Access login
// just completed WAS the step-up, exactly as a dashboard grant binds to its own session.
import type { AuthContext, Env } from '../types'
import type { AccessClaims } from './jwt'
import { resolveLoginIdentity } from '../auth/login-identity'
import { createWebSession, markRecentReauth, randomWebSessionId, hashWebSessionId } from '../auth/web-sessions'
import { resolveCapabilities } from '../auth/capability'
import { findUserByEmail, AmbiguousUserEmailError } from '../auth/index'

export const ACCESS_PROVIDER = 'cloudflare-access'

export type ApproverFailure = 'not_linked' | 'member_ineligible'
export interface ApproverMember {
  memberId: string
  /** Same shape the dashboard cookie loader builds: legacy role plane + (members only) capability rows. */
  auth: AuthContext
  /** The explicit identity row this login resolved through. */
  identityId: string
}
export type ResolveApproverResult = { ok: true; approver: ApproverMember } | { ok: false; reason: ApproverFailure }

/** Active, unarchived, tenant-matching, and NOT an agent's welded member row. */
export async function memberIsActiveHuman(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM members m
      WHERE m.id = ?1 AND m.tenant = ?2 AND m.status = 'active' AND m.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = ?2 AND b.member_id = m.id)`,
  ).bind(memberId, env.TENANT_SLUG).first<{ ok: number }>()
  return row !== null
}

async function buildAuth(env: Env, memberId: string, webSession?: { idHash: string }): Promise<AuthContext> {
  // The resolved member's OWN email (not the JWT's) names the legacy role plane, via the shared chokepoint.
  const m = await env.DB.prepare('SELECT email FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1')
    .bind(memberId, env.TENANT_SLUG).first<{ email: string | null }>()
  const email = (m?.email ?? '').trim().toLowerCase()
  let user: { id: string; role: string } | null = null
  try {
    user = await findUserByEmail(env, email || null)
  } catch (err) {
    if (!(err instanceof AmbiguousUserEmailError)) throw err
    user = null // ambiguous users rows: no legacy elevation, plain member authority only (fail closed)
  }
  const role: AuthContext['role'] = user?.role === 'owner' || user?.role === 'admin' ? user.role : 'member'
  const auth: AuthContext = {
    userId: user?.id ?? memberId, email, role, tenant: env.TENANT_SLUG, memberId, channel: 'dashboard',
    ...(webSession ? { webSessionMemberId: memberId, webSessionIdHash: webSession.idHash } : {}),
  }
  // Capabilities attach to plain members only, exactly as loadAuthFromCookie does, so an owner is never downgraded.
  if (role === 'member') auth.capabilities = await resolveCapabilities(env, memberId)
  return auth
}

/** Read-only: which human is this? Existing explicit identity row only. Writes nothing. */
export async function resolveApprover(env: Env, claims: AccessClaims): Promise<ResolveApproverResult> {
  const ident = await resolveLoginIdentity(env, env.TENANT_SLUG, ACCESS_PROVIDER, claims.sub)
  if (!ident) return { ok: false, reason: 'not_linked' }
  if (!(await memberIsActiveHuman(env, ident.member_id))) return { ok: false, reason: 'member_ineligible' }
  return { ok: true, approver: { memberId: ident.member_id, auth: await buildAuth(env, ident.member_id), identityId: ident.id } }
}

/** Call ONLY after every authority check passed: mints the freshly re-authenticated web session this login stands for. */
export async function mintApproverSession(
  env: Env, approver: ApproverMember, nowMs: number = Date.now(),
): Promise<{ approver: ApproverMember; webSessionHash: string }> {
  const raw = randomWebSessionId()
  await createWebSession(env, raw, { tenant: env.TENANT_SLUG, memberId: approver.memberId, loginIdentityId: approver.identityId }, nowMs)
  const idHash = await hashWebSessionId(raw)
  await markRecentReauth(env, idHash, nowMs)
  return {
    approver: { ...approver, auth: await buildAuth(env, approver.memberId, { idHash }) },
    webSessionHash: idHash,
  }
}

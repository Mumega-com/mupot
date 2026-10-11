// mupot — who is the human behind a verified Access JWT.
//
// Provider 'cloudflare-access', subject = the JWT `sub`, through the EXISTING human-identity path
// (resolveLoginIdentity / resolveHumanMemberId / linkLoginIdentity with requireExclusiveControl), never a
// bare email match. The resolved member must be an ACTIVE, unarchived HUMAN: a member row welded to an
// agent (agent_member_bindings) is refused whatever its email says. A first login whose email attach is
// refused (competing control, ambiguity) resolves to nothing; the owner links the Access identity once,
// explicitly (docs/architecture/access-approve-page.md).
//
// GET only needs a member (read-only resolve). The approving POST also mints a web session for this
// login, marked freshly re-authenticated: the Access login WAS the step-up, and an elevation grant binds
// to that session exactly as a dashboard grant binds to its own.
import type { AuthContext, Env } from '../types'
import type { AccessClaims } from './jwt'
import { resolveLoginIdentity, linkLoginIdentity } from '../auth/login-identity'
import { resolveHumanMemberId } from '../members/resolve-human-member'
import { createWebSession, markRecentReauth, randomWebSessionId, hashWebSessionId } from '../auth/web-sessions'
import { resolveCapabilities } from '../auth/capability'

export const ACCESS_PROVIDER = 'cloudflare-access'

export type ApproverFailure = 'not_linked' | 'member_ineligible' | 'link_refused'
export interface ApproverMember {
  memberId: string
  /** Same shape the dashboard cookie loader builds: legacy role plane + (members only) capability rows. */
  auth: AuthContext
}
export type ResolveApproverResult = { ok: true; approver: ApproverMember; identityId: string | null } | { ok: false; reason: ApproverFailure }

/** Active, unarchived, tenant-matching, and NOT an agent's welded member row. */
export async function memberIsActiveHuman(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM members m
      WHERE m.id = ?1 AND m.tenant = ?2 AND m.status = 'active' AND m.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = ?2 AND b.member_id = m.id)`,
  ).bind(memberId, env.TENANT_SLUG).first<{ ok: number }>()
  return row !== null
}

async function buildAuth(env: Env, memberId: string, email: string, webSession?: { idHash: string }): Promise<AuthContext> {
  // Legacy org role by verified email (owner/admin keep the role plane; capabilities attach to plain
  // members only, exactly as loadAuthFromCookie does so an owner is never downgraded).
  const user = await env.DB.prepare('SELECT id, role FROM users WHERE email = ?1 LIMIT 1')
    .bind(email).first<{ id: string; role: string }>()
  const role: AuthContext['role'] = user?.role === 'owner' || user?.role === 'admin' ? user.role : 'member'
  const auth: AuthContext = {
    userId: user?.id ?? memberId, email, role, tenant: env.TENANT_SLUG, memberId, channel: 'dashboard',
    ...(webSession ? { webSessionMemberId: memberId, webSessionIdHash: webSession.idHash } : {}),
  }
  if (role === 'member') auth.capabilities = await resolveCapabilities(env, memberId)
  return auth
}

/** Read-only: which human is this? No identity row, no session written. */
export async function resolveApproverReadOnly(env: Env, claims: AccessClaims): Promise<ResolveApproverResult> {
  const tenant = env.TENANT_SLUG
  const email = claims.email.trim().toLowerCase()
  const ident = await resolveLoginIdentity(env, tenant, ACCESS_PROVIDER, claims.sub)
  const memberId = ident
    ? ident.member_id
    : await resolveHumanMemberId(env, { tenant, provider: ACCESS_PROVIDER, providerSubject: claims.sub, email })
  if (!memberId) return { ok: false, reason: 'not_linked' }
  if (!(await memberIsActiveHuman(env, memberId))) return { ok: false, reason: 'member_ineligible' }
  return { ok: true, approver: { memberId, auth: await buildAuth(env, memberId, email) }, identityId: ident?.id ?? null }
}

/** POST: resolve, link the identity if this is its first use, mint a fresh web session for this login. */
export async function startApproverSession(
  env: Env, claims: AccessClaims, nowMs: number = Date.now(),
): Promise<{ ok: true; approver: ApproverMember; webSessionHash: string } | { ok: false; reason: ApproverFailure }> {
  const resolved = await resolveApproverReadOnly(env, claims)
  if (!resolved.ok) return resolved
  const tenant = env.TENANT_SLUG
  const email = claims.email.trim().toLowerCase()
  let identityId = resolved.identityId
  if (!identityId) {
    const linked = await linkLoginIdentity(env, {
      tenant, provider: ACCESS_PROVIDER, providerSubject: claims.sub, verifiedEmail: email,
      memberId: resolved.approver.memberId, requireExclusiveControl: true,
    })
    if (!linked.ok) return { ok: false, reason: 'link_refused' }
    identityId = linked.identity.id
  }
  const raw = randomWebSessionId()
  await createWebSession(env, raw, { tenant, memberId: resolved.approver.memberId, loginIdentityId: identityId }, nowMs)
  const idHash = await hashWebSessionId(raw)
  await markRecentReauth(env, idHash, nowMs)
  return {
    ok: true,
    approver: { memberId: resolved.approver.memberId, auth: await buildAuth(env, resolved.approver.memberId, email, { idHash }) },
    webSessionHash: idHash,
  }
}

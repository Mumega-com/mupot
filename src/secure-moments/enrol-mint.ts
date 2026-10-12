// mupot — "Add passkey": mint a single-use, 10-minute enrolment link for the member behind a REAL dashboard
// session. Enrolment adds no authority; it records one more proof method for a member mupot already trusts.
// Only an identity mupot already trusts can add a passkey: a cookie web session whose member is an active human,
// freshly re-authenticated (a stolen session cookie alone cannot plant its own passkey: the passkey would then
// skip the step-up the session itself would have needed).
import type { AuthContext, Env } from '../types'
import { memberIsActiveHuman } from '../access/identity'
import { hasRecentReauth, loadWebSessionByHash } from '../auth/web-sessions'
import { enrolUrl, secureMomentsStatus } from './config'
import { mintEnrolmentToken } from './store'

export type EnrolmentSessionRefusal = { ok: false; status: 403 | 404 | 409; error: 'not_enabled' | 'not_a_web_session' | 'member_ineligible' | 'reauth_required' | 'session_identity_unavailable' }
export type MintEnrolmentResult = { ok: true; url: string; expiresAt: string } | EnrolmentSessionRefusal

/**
 * The ONE rule for "who may add a second proof method for a member": a real dashboard web session, whose member is an
 * active human, freshly re-authenticated, with a live login identity. Shared by the passkey enrolment link and the
 * Telegram device enrolment link (secure-moments W4) so the two can never drift into different bars.
 */
export async function checkEnrolmentSession(
  env: Env, auth: AuthContext, nowMs: number = Date.now(),
): Promise<{ ok: true; memberId: string; identityId: string } | EnrolmentSessionRefusal> {
  if (secureMomentsStatus(env).state !== 'on') return { ok: false, status: 404, error: 'not_enabled' }
  // A bearer token / agent / OAuth caller has no web session: only a signed-in human in a browser can enrol.
  if (!auth.webSessionIdHash || !auth.webSessionMemberId || !auth.memberId || auth.webSessionMemberId !== auth.memberId) {
    return { ok: false, status: 403, error: 'not_a_web_session' }
  }
  if (!(await memberIsActiveHuman(env, auth.memberId))) return { ok: false, status: 403, error: 'member_ineligible' }
  const session = await loadWebSessionByHash(env, env.TENANT_SLUG, auth.webSessionIdHash)
  if (!session || session.revoked_at !== null || session.member_id !== auth.memberId) {
    return { ok: false, status: 403, error: 'not_a_web_session' }
  }
  if (!hasRecentReauth(session, nowMs)) return { ok: false, status: 403, error: 'reauth_required' }
  // The new proof inherits this session's login identity (an elevation decided with it binds a session to that identity).
  const identity = await env.DB.prepare(
    `SELECT id FROM human_login_identities WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(session.login_identity_id, env.TENANT_SLUG, auth.memberId).first<{ id: string }>()
  if (!identity) return { ok: false, status: 409, error: 'session_identity_unavailable' }
  return { ok: true, memberId: auth.memberId, identityId: identity.id }
}

export async function mintEnrolmentLink(env: Env, auth: AuthContext, nowMs: number = Date.now()): Promise<MintEnrolmentResult> {
  const checked = await checkEnrolmentSession(env, auth, nowMs)
  if (!checked.ok) return checked
  const minted = await mintEnrolmentToken(env, checked.memberId, checked.identityId, nowMs)
  const url = enrolUrl(env, minted.token)
  return url ? { ok: true, url, expiresAt: minted.expiresAt } : { ok: false, status: 404, error: 'not_enabled' }
}

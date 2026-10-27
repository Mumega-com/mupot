// mupot — the route-facing half of human presence: ONE call a widening route makes after its own authorisation checks and
// before its write. No UI and no dashboard imports (the auth, members and account apps use it too); the dashboard form pages
// wrap it in src/dashboard/presence.ts. See src/approvals/human-presence.ts for the rule and the grant lifecycle.
import type { Context } from 'hono'
import type { AuthContext, Env } from '../types'
import { redeemPresence, requestPresence, type PresenceSpec } from './human-presence'

/** A legacy cookie lacking a D1 session binding is still a browser credential, never a bearer exemption. */
export function browserSessionCaller(c: Context, auth: AuthContext): boolean {
  return !!auth.webSessionIdHash || /(?:^|;\s*)mupot_session=/.test(c.req.header('cookie') ?? '')
}

export type PresenceRefusal = 'human_presence_required' | 'human_presence_unavailable' | 'passkey_enrolment_required' | 'too_many_pending' | 'presence_grant_invalid'

export const PRESENCE_MESSAGES: Record<PresenceRefusal, string> = {
  human_presence_required: 'This decision gives an agent or a chat more reach, so it needs your passkey. A signed-in browser is not enough. Open the passkey page, approve it there, then come back and apply it.',
  human_presence_unavailable: 'This decision gives an agent or a chat more reach, so it needs your passkey, and passkeys are not available on this workspace. Ask the workspace owner to enable secure moments. Nothing was changed.',
  passkey_enrolment_required: 'This decision gives an agent or a chat more reach, so it needs your passkey, and you have none yet. Add one under My Account, then try again. Nothing was changed.',
  too_many_pending: 'Too many passkey requests are waiting. Finish or let them expire, then try again. Nothing was changed.',
  presence_grant_invalid: 'That passkey approval does not match this decision, was already used, or expired. Nothing was changed.',
}

export type PresenceOutcome =
  | { proceed: true }
  | { proceed: false; error: PresenceRefusal; status: 403 | 429; approveUrl?: string; grantId?: string }

/**
 * `presented` is the `?presence_grant=` the caller sent. A grant redeemable for exactly this decision (member, kind, subject,
 * parameter digest) is consumed here and the route may proceed; anything else files a pending grant (or says why it cannot)
 * and the route must NOT write. `memberId` is the authenticated member, never a request field.
 */
export async function presenceCheck(env: Env, memberId: string | null | undefined, spec: PresenceSpec, presented: string | undefined): Promise<PresenceOutcome> {
  // No member behind the caller (a role-only session, a missing bridge) has no passkey to prove anything with: fail closed.
  if (!memberId) return { proceed: false, error: 'passkey_enrolment_required', status: 403 }
  if (presented !== undefined) {
    if (await redeemPresence(env, memberId, spec, presented)) return { proceed: true }
    return { proceed: false, error: 'presence_grant_invalid', status: 403 }
  }
  const r = await requestPresence(env, memberId, spec)
  if (!r.ok) return { proceed: false, error: r.error, status: r.error === 'too_many_pending' ? 429 : 403 }
  return { proceed: false, error: 'human_presence_required', status: 403, approveUrl: r.approveUrl, grantId: r.grantId }
}

export function presenceRefusalBody(o: Extract<PresenceOutcome, { proceed: false }>): Record<string, string> {
  return { error: o.error, message: PRESENCE_MESSAGES[o.error], ...(o.approveUrl ? { approve_url: o.approveUrl } : {}), ...(o.grantId ? { presence_grant: o.grantId } : {}) }
}

/** JSON routes: null = proceed, else the 403/429 Response. */
export async function presenceGateJson(c: Context, memberId: string | null | undefined, spec: PresenceSpec): Promise<Response | null> {
  const o = await presenceCheck(c.env as Env, memberId, spec, c.req.query('presence_grant')) // as: every app that calls this is Bindings: Env
  if (o.proceed) return null
  c.header('Cache-Control', 'no-store')
  if (o.grantId) c.header('X-Presence-Grant', o.grantId)
  return c.json(presenceRefusalBody(o), o.status)
}

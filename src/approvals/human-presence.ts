// mupot — human presence for decisions that WIDEN authority.
//
// RULE: a human decision that widens what an agent, a chat or a member-on-an-agent's-behalf may do must carry a proof of
// human presence that a program driving the human's browser cannot produce. A dashboard web session, a fresh sign-in and
// a Cloudflare Access login are all things such a program holds, so none of them is that proof.
//
// The proof accepted here is (a): a WebAuthn assertion with user verification REQUIRED, verified on the dedicated secure
// host by the very verifier the secure moments use, whose challenge is bound to THIS decision (grant id + a digest of the
// decision's parameters), single use, short TTL. The assertion marks a presence grant `satisfied`; the route that performs
// the decision consumes the grant in ONE guarded UPDATE that re-states the member, kind, subject and parameter digest.
// Proof (b) (a decision arriving from the member's bound private Telegram chat) already exists as its own channel
// (src/im, src/approval-bot, the harness-attested human_origin on task_verdict) and is left exactly as it is.
//
// Reducing authority normally needs no presence. Removing a passkey is an exception: it could reopen first enrolment,
// so it requires a different live passkey and must preserve at least one live passkey.
//
// POLICY FLOOR: `approval.human-presence-required` has the same value at every policy level.
// TODO(#2216): when src/policy/registry.ts lands, register APPROVAL_HUMAN_PRESENCE_FLOOR there as a FLOOR and make
// humanPresenceRequired() read it. Until then this code constant is the floor and no flag, level or env var relaxes it.

import type { Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import { timingSafeEqual } from '../lib/crypto'
import { momentsPresenceUrl, secureMomentsStatus } from '../secure-moments/config'
import { listMemberPasskeys, randomToken, tokenHash } from '../secure-moments/store'

export const APPROVAL_HUMAN_PRESENCE_FLOOR = 'approval.human-presence-required'

/** Same answer at every level (the floor): presence is required for every widening decision. */
export function humanPresenceRequired(_level?: string): true {
  return true
}

/**
 * Every authority-widening human decision that goes through a presence grant. The inventory in the PR and the coverage
 * test (tests/human-presence-paths.test.ts) are keyed by this list: a kind added here without a test fails the ratchet.
 */
export const PRESENCE_DECISION_KINDS = [
  'claim_confirm', // POST /claim/:code
  'claim_own', // POST /agents/:id/claim
  'seat_attach', // POST /connections/attach
  'seat_release', // POST /connections/seats/:id/release (observed|held -> trusted)
  'seat_return_from_held', // POST /connections/seats/:id/return when the seat is held (held -> observed)
  'designation_allow', // POST /agents/:id/designation action=allow
  'agent_owner_set', // POST /agents/:id/owner action=set|me
  'agent_access_set', // POST /agents/:id/access action=set|move
  'squad_agent_join', // POST /squads/:id/agents/join
  'operator_delegate', // POST /operators/delegate
  'agent_token_mint', // POST /admin/agent-token/mint (the show-once token page)
  'scoped_key_mint', // POST /admin/keys/mint (the show-once key page)
  'seat_key_mint', // POST /enroll/mint (the show-once seat key page)
  'member_token_mint', // POST /api/members/:id/tokens, from a web-session cookie (the token is shown once on the return page)
  'member_capability_grant', // POST /api/members/:id/capabilities action=grant, from a web-session cookie
  'task_verdict_approve', // POST /api/tasks/:id/verdict verdict=approved, from a web-session cookie
  'elevation_approve', // POST /auth/elevation/requests/:id/decide decision=approve
  'access_seed_approve', // POST /approve/seed/:id decision=approve, on the Cloudflare Access page
  'access_elevation_approve', // POST /approve/elevation/:id decision=approve, on the Cloudflare Access page
  'oauth_consent', // OAuth member/agent grant consent
  'telegram_bind', // bind a private Telegram channel to a member
  'telegram_device_enrol', // enrol a trusted Telegram device
  'telegram_device_window', // lengthen a trusted-device window
  'passkey_revoke', // remove a passkey using another live passkey
  'login_identity_revoke', // remove an identity and its passkeys
  'gate_grant', // grant verdict authority
  'agent_membership_grant', // add or widen an agent membership
  'channel_binding', // add or widen a channel binding
  'seat_event_grant', // grant fleet event delivery
  'im_settings_set', // widen IM routing settings
  'passkey_enrol', // POST /account/passkey/enrol when the member already holds a passkey
] as const
export type PresenceDecisionKind = (typeof PRESENCE_DECISION_KINDS)[number]

export const PRESENCE_PENDING_TTL_MS = 10 * 60 * 1000
/** Once the passkey has spoken, the decision must be performed within this window. */
export const PRESENCE_REDEEM_TTL_MS = 5 * 60 * 1000
export const PRESENCE_MAX_PENDING_PER_MEMBER = 20

export type PresenceValue = string | number | boolean | null | readonly string[]

/** The decision, exactly as the route will perform it. `params` are the fields that are reposted and digested. */
export interface PresenceSpec {
  kind: PresenceDecisionKind
  subjectId: string
  params: Record<string, PresenceValue>
  /** One server-built sentence naming what is being approved (shown on the secure host, escaped there). */
  summary: string
  /** Same-origin dashboard path that performs the decision (the apply page posts to it). */
  actionPath: string
  encoding: 'form' | 'json'
  /** Where to go after the decision is performed. */
  returnPath: string
}

/** sha256 of the canonical decision: the digest every challenge, grant and redemption is bound to. */
export async function presenceDigest(memberId: string, spec: Pick<PresenceSpec, 'kind' | 'subjectId' | 'params'>): Promise<string> {
  return sha256Hex(canonicalJson({ v: 1, member: memberId, kind: spec.kind, subject: spec.subjectId, params: spec.params }))
}

export interface PresenceGrantRow {
  id: string
  tenant: string
  member_id: string
  kind: PresenceDecisionKind
  subject_id: string
  params_sha256: string
  summary: string
  action_path: string
  fields_json: string
  encoding: 'form' | 'json'
  return_path: string
  link_token_sha256: string
  status: 'pending' | 'satisfied' | 'consumed' | 'expired'
  created_at: string
  expires_at: string
  satisfied_at: string | null
  satisfied_passkey_id: string | null
  consumed_at: string | null
}

const COLS = `id, tenant, member_id, kind, subject_id, params_sha256, summary, action_path, fields_json, encoding, return_path,
  link_token_sha256, status, created_at, expires_at, satisfied_at, satisfied_passkey_id, consumed_at`

export type PresenceRequest =
  | { ok: true; grantId: string; approveUrl: string }
  | { ok: false; error: 'human_presence_unavailable' | 'passkey_enrolment_required' | 'too_many_pending' }

/** Show every bound field on the passkey page, including optional/default choices. Resolve entity names server-side. */
export async function presenceSummary(env: Env, spec: PresenceSpec): Promise<string> {
  const details: string[] = []
  for (const [key, value] of Object.entries(spec.params)) {
    let shown = Array.isArray(value) ? value.join(', ') || '(none)' : String(value)
    if (typeof value === 'string' && value) {
      if (key === 'agent_id' || key === 'agent' || key.endsWith('_agent_id')) {
        const row = await env.DB.prepare('SELECT name FROM agents WHERE id = ?1').bind(value).first<{ name: string }>()
        if (row) shown = `${row.name} (${value})`
        else if (value === '__harness__') shown = 'This connected app (harness)'
        else if (value === '__bootstrap__') shown = 'Create your first agent'
      } else if (key === 'squad_id' || key.endsWith('_squad_id') || (key === 'scope_id' && spec.params.scope_type === 'squad')) {
        const row = await env.DB.prepare('SELECT name FROM squads WHERE id = ?1').bind(value).first<{ name: string }>()
        if (row) shown = `${row.name} (${value})`
      } else if (key === 'member_id' || key === 'owner_member_id') {
        const row = await env.DB.prepare('SELECT display_name FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL)')
          .bind(value, env.TENANT_SLUG).first<{ display_name: string }>()
        if (row) shown = `${row.display_name} (${value})`
      }
    }
    const label = key.replace(/_/g, ' ').replace(/\bid\b/g, 'identifier')
    details.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${shown || '(empty)'}`)
  }
  return `${spec.summary}${details.length ? ` — ${details.join('; ')}` : ''}`
}

/**
 * File a pending grant for exactly this decision and return the secure-host link. Fails CLOSED: with secure moments off or
 * misconfigured there is no way to prove presence, so the widening decision is refused rather than allowed. A member with no
 * passkey is told to enrol one (enrolment is itself gated once a first passkey exists; see passkey_enrol).
 */
export async function requestPresence(env: Env, memberId: string, spec: PresenceSpec, nowMs: number = Date.now()): Promise<PresenceRequest> {
  if (secureMomentsStatus(env).state !== 'on') return { ok: false, error: 'human_presence_unavailable' }
  if ((await listMemberPasskeys(env, memberId)).length === 0) return { ok: false, error: 'passkey_enrolment_required' }
  const token = randomToken()
  const id = crypto.randomUUID()
  const nowIso = new Date(nowMs).toISOString()
  const digest = await presenceDigest(memberId, spec)
  const r = await env.DB.prepare(
    `INSERT INTO presence_grants
       (id, tenant, member_id, kind, subject_id, params_sha256, summary, action_path, fields_json, encoding, return_path, link_token_sha256, status, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?14
      WHERE (SELECT COUNT(*) FROM presence_grants WHERE tenant = ?2 AND member_id = ?3 AND status = 'pending' AND expires_at > ?13) < ?15`,
  ).bind(id, env.TENANT_SLUG, memberId, spec.kind, spec.subjectId, digest, await presenceSummary(env, spec), spec.actionPath, canonicalJson(spec.params),
    spec.encoding, spec.returnPath, await tokenHash(token), nowIso, new Date(nowMs + PRESENCE_PENDING_TTL_MS).toISOString(), PRESENCE_MAX_PENDING_PER_MEMBER).run()
  if (r.meta.changes !== 1) return { ok: false, error: 'too_many_pending' }
  const url = momentsPresenceUrl(env, id, token)
  return url ? { ok: true, grantId: id, approveUrl: url } : { ok: false, error: 'human_presence_unavailable' }
}

export async function loadPresenceGrant(env: Env, id: string): Promise<PresenceGrantRow | null> {
  const row = await env.DB.prepare(`SELECT ${COLS} FROM presence_grants WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<PresenceGrantRow>()
  return row ?? null
}

export async function presenceLinkMatches(row: PresenceGrantRow, token: string): Promise<boolean> {
  return timingSafeEqual(row.link_token_sha256, await tokenHash(token))
}

export const presenceGrantIsPending = (row: PresenceGrantRow, nowMs: number): boolean => row.status === 'pending' && Date.parse(row.expires_at) > nowMs

/**
 * The passkey has spoken for this grant: ONE guarded UPDATE (pending, unexpired, link hash unchanged, the passkey is the
 * named member's own, unrevoked and bound to a live login identity). True iff THIS call won it.
 */
export async function satisfyPresenceGrant(
  env: Env, input: { id: string; token: string; memberId: string; passkeyId: string }, nowMs: number,
): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `UPDATE presence_grants
        SET status = 'satisfied', satisfied_at = ?3, satisfied_passkey_id = ?5, expires_at = ?7
      WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND expires_at > ?3 AND member_id = ?4 AND link_token_sha256 = ?6
        AND EXISTS (SELECT 1 FROM member_passkeys p
                      JOIN human_login_identities i
                        ON i.id = p.login_identity_id AND i.tenant = p.tenant AND i.member_id = p.member_id AND i.revoked_at IS NULL
                     WHERE p.id = ?5 AND p.tenant = ?2 AND p.member_id = ?4 AND p.revoked_at IS NULL
                       AND (presence_grants.kind != 'passkey_revoke' OR p.id != presence_grants.subject_id)
                       AND (presence_grants.kind != 'login_identity_revoke' OR p.login_identity_id != presence_grants.subject_id))`,
  ).bind(input.id, env.TENANT_SLUG, nowIso, input.memberId, input.passkeyId, await tokenHash(input.token),
    new Date(nowMs + PRESENCE_REDEEM_TTL_MS).toISOString()).run()
  return r.meta.changes === 1
}

/**
 * Redeem a satisfied grant for EXACTLY this decision, once. The member, kind, subject and the digest of the parameters the
 * route is about to apply are all part of the WHERE: a grant satisfied for another decision (or another member, or after the
 * passkey or its login identity was revoked) consumes nothing. True iff THIS call consumed it.
 */
export async function redeemPresence(env: Env, memberId: string, spec: Pick<PresenceSpec, 'kind' | 'subjectId' | 'params'>, grantId: unknown, nowMs: number = Date.now()): Promise<boolean> {
  if (typeof grantId !== 'string' || grantId.length === 0 || grantId.length > 64) return false
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `UPDATE presence_grants SET status = 'consumed', consumed_at = ?3
      WHERE id = ?1 AND tenant = ?2 AND status = 'satisfied' AND expires_at > ?3
        AND member_id = ?4 AND kind = ?5 AND subject_id = ?6 AND params_sha256 = ?7
        AND EXISTS (SELECT 1 FROM member_passkeys p
                      JOIN human_login_identities i
                        ON i.id = p.login_identity_id AND i.tenant = p.tenant AND i.member_id = p.member_id AND i.revoked_at IS NULL
                     WHERE p.id = presence_grants.satisfied_passkey_id AND p.tenant = ?2 AND p.member_id = ?4 AND p.revoked_at IS NULL
                       AND (presence_grants.kind != 'passkey_revoke' OR p.id != presence_grants.subject_id)
                       AND (presence_grants.kind != 'login_identity_revoke' OR p.login_identity_id != presence_grants.subject_id))`,
  ).bind(grantId, env.TENANT_SLUG, nowIso, memberId, spec.kind, spec.subjectId, await presenceDigest(memberId, spec)).run()
  return r.meta.changes === 1
}

/** The dashboard link a human returns to after the passkey page (path-routed pots keep their /t/<tenant> prefix). */
export function dashboardUrl(env: Env, path: string): string | null {
  try {
    const u = new URL(env.PUBLIC_ORIGIN ?? '')
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${path}`
  } catch {
    return null
  }
}

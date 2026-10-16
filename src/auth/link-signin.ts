// mupot#1022 — "Linked sign-ins": a SIGNED-IN member proves control of another Google account and links it to THIS member.
//
// Why: login resolves by human_login_identities (provider, subject) first. An unlinked Google subject whose email differs
// from the member's used to create a brand-new zero-capability member, and nothing in the OAuth flow ever wrote a link.
// This module is the one write path for "I own this other sign-in".
//
// Rules, each one a guard with a test that mutates it:
//   - The link is bound to the live web session that started it (the route layer checks the state's session hash against
//     the callback's session) and needs a fresh re-auth (checkWebSession fresh:true) — enforced by the routes.
//   - The subject comes from the verified OAuth callback. NEVER from an email match, NEVER on an unauthenticated login.
//   - A subject already live on ANOTHER member is never silently re-pointed: it is refused (`already_linked`) unless the
//     caller passes `confirmMove` after being shown the duplicate. A move needs: target rank ceiling
//     (exceedsTargetRankCeiling — you cannot take an identity from a member who outranks you), the #1963 competing-bearer
//     check on the member losing the identity, and the old member must not back an agent. The move is ONE guarded UPDATE
//     plus an anchored session cutoff in one D1 batch: a refusal changes nothing, and the cutoff only lands if the move did.
//   - UNIQUE(tenant, provider, subject) covers revoked rows too, so a "move" re-points the existing row rather than
//     inserting a second one; the old member keeps its row and its capabilities and is left for an admin to archive.
//   - Unlink: self only, never the last live identity (guard is inside the UPDATE), cuts off the sessions/passkeys it issued.
//   - Every link, move and unlink writes a mutation_audit_entries row.

import type { AuthContext, Env } from '../types'
import { exceedsTargetRankCeiling, resolveCapabilities } from './capability'
import { linkLoginIdentity, resolveLoginIdentity, type LoginIdentityRecord } from './login-identity'
import { maskEmail } from './telegram-login-link'
import { nowSqlUtc } from './token-lifecycle'
import { revokeWebSessionsForLoginIdentity } from './web-sessions'
import { revokeMemberPasskeys } from '../secure-moments/store'
import { revokeMemberTgDevices } from '../secure-moments/telegram-miniapp-store'
import { auditMutation } from '../flight-spine/audit'
import {
  liveCompetingBearerSql,
  PROVISIONING_EXEMPT_DIRECTORY_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_LABEL,
  UNVERIFIED_LOGIN_PROVIDERS,
} from '../members/exclusive-control'

export interface LinkedSignIn {
  id: string
  provider: string
  maskedEmail: string | null
  linkedAt: string
}

/** The member's LIVE login identities, for the account page: provider and masked email only. */
export async function listLinkedSignIns(env: Env, memberId: string): Promise<LinkedSignIn[]> {
  const rows = await env.DB.prepare(
    `SELECT id, provider, verified_email, created_at FROM human_login_identities
      WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL ORDER BY created_at ASC`,
  ).bind(env.TENANT_SLUG, memberId).all<{ id: string; provider: string; verified_email: string | null; created_at: string }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    provider: r.provider,
    maskedEmail: r.verified_email ? maskEmail(r.verified_email) : null,
    linkedAt: r.created_at,
  }))
}

/** What the confirm page may show about the member that currently owns the subject. */
export interface DuplicateMemberInfo {
  identityId: string
  memberId: string
  createdAt: string
  permissions: number
}

export type LinkSignInRefusal =
  | 'already_linked' // live on another member and not movable (outranks you / competing bearer / agent-backed / inactive)
  | 'identity_revoked' // this subject was unlinked before; never silently revived here
  | 'unverified'
  | 'not_a_human_session'
  | 'changed' // what the member confirmed is no longer what is in the database

export type LinkSignInPlan =
  | { kind: 'link' }
  | { kind: 'already_yours' }
  | { kind: 'reactivate'; identityId: string }
  | { kind: 'move'; duplicate: DuplicateMemberInfo }
  | { kind: 'refuse'; error: LinkSignInRefusal }

export interface LinkSignInInput {
  provider: string
  subject: string
  verifiedEmail: string | null
}

interface MemberFacts {
  created_at: string
  status: string
  archived_at: string | null
}

async function memberFacts(env: Env, memberId: string): Promise<MemberFacts | null> {
  return env.DB.prepare(
    `SELECT created_at, status, archived_at FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(memberId, env.TENANT_SLUG).first<MemberFacts>()
}

async function anyIdentityRow(env: Env, provider: string, subject: string): Promise<LoginIdentityRecord | null> {
  return env.DB.prepare(
    `SELECT id, tenant, provider, provider_subject, verified_email, member_id, linked_by_member_id, created_at, revoked_at
       FROM human_login_identities WHERE tenant = ?1 AND provider = ?2 AND provider_subject = ?3 LIMIT 1`,
  ).bind(env.TENANT_SLUG, provider, subject).first<LoginIdentityRecord>()
}

async function backsAgent(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId).first<{ present: number }>()
  return row !== null
}

async function hasLiveCompetingBearer(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present ${liveCompetingBearerSql({
      tenant: '?1', member: '?2', exemptLabel: '?3', exemptChannel: '?4', directoryChannel: '?5', now: '?6',
    })} LIMIT 1`,
  ).bind(
    env.TENANT_SLUG, memberId, PROVISIONING_EXEMPT_TOKEN_LABEL, PROVISIONING_EXEMPT_TOKEN_CHANNEL,
    PROVISIONING_EXEMPT_DIRECTORY_CHANNEL, nowSqlUtc(),
  ).first<{ present: number }>()
  return row !== null
}

/**
 * Read-only decision for linking `input` to the member behind `auth`. Writes nothing, so the callback can show the
 * duplicate to the member before anything moves.
 */
export async function planLinkSignIn(env: Env, auth: AuthContext, input: LinkSignInInput): Promise<LinkSignInPlan> {
  const me = auth.memberId
  if (!me) return { kind: 'refuse', error: 'not_a_human_session' }
  if (!input.verifiedEmail || (UNVERIFIED_LOGIN_PROVIDERS as readonly string[]).includes(input.provider)) {
    return { kind: 'refuse', error: 'unverified' }
  }
  const existing = await anyIdentityRow(env, input.provider, input.subject)
  if (!existing) return { kind: 'link' }
  if (existing.member_id === me) {
    return existing.revoked_at === null
      ? { kind: 'already_yours' }
      : { kind: 'reactivate', identityId: existing.id }
  }
  if (existing.revoked_at !== null) return { kind: 'refuse', error: 'identity_revoked' }

  // Live on another member. Movable only when every guard clears; otherwise it is simply already linked.
  const other = existing.member_id
  const facts = await memberFacts(env, other)
  if (!facts || facts.status !== 'active' || facts.archived_at !== null) return { kind: 'refuse', error: 'already_linked' }
  if (await exceedsTargetRankCeiling(env, auth, other)) return { kind: 'refuse', error: 'already_linked' }
  if (await backsAgent(env, other)) return { kind: 'refuse', error: 'already_linked' }
  if (await hasLiveCompetingBearer(env, other)) return { kind: 'refuse', error: 'already_linked' }
  const permissions = (await resolveCapabilities(env, other)).length
  return { kind: 'move', duplicate: { identityId: existing.id, memberId: other, createdAt: facts.created_at, permissions } }
}

export type LinkSignInResult =
  | { ok: true; outcome: 'linked' | 'moved' | 'reactivated' | 'already_yours'; identityId: string }
  | { ok: false; error: LinkSignInRefusal | 'competing_control' | 'service_error' }

async function auditLink(
  env: Env, auth: AuthContext, operation: 'link' | 'move' | 'unlink' | 'reactivate', identityId: string,
  evidence: { provider: string; maskedEmail: string | null; fromMemberId?: string | null },
): Promise<void> {
  try {
    await auditMutation(env, auth, {
      origin: 'admin_ui',
      handler: 'auth.linked_signins',
      operation,
      targetKind: 'login_identity',
      targetId: identityId,
      requestId: crypto.randomUUID(),
      evidence: {
        provider: evidence.provider,
        masked_email: evidence.maskedEmail,
        from_member_id: evidence.fromMemberId ?? null,
      },
    })
  } catch (err) {
    // The identity write already landed and is idempotent; a failed audit must be loud, not a rollback of a login door.
    console.error('linked-signins audit write failed', { operation, identity_id: identityId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Link (or, with `confirmMove`, move) the verified subject to the member behind `auth`. The caller (the route layer) has
 * already established the fresh, session-bound proof of control; this re-decides from the database so nothing the
 * request or a stored plan says is trusted.
 *
 * `expectedDuplicate` is what the member was shown on the confirm page: the move only lands if it is still exactly that.
 */
export async function linkSignIn(
  env: Env,
  auth: AuthContext,
  input: LinkSignInInput,
  opts: { confirmMove?: boolean; expectedDuplicate?: { identityId: string; memberId: string } } = {},
): Promise<LinkSignInResult> {
  const me = auth.memberId
  const plan = await planLinkSignIn(env, auth, input)
  if (!me) return { ok: false, error: 'not_a_human_session' }
  const maskedEmail = input.verifiedEmail ? maskEmail(input.verifiedEmail) : null

  switch (plan.kind) {
    case 'refuse':
      return { ok: false, error: plan.error }
    case 'already_yours': {
      const id = (await resolveLoginIdentity(env, env.TENANT_SLUG, input.provider, input.subject))?.id ?? ''
      return { ok: true, outcome: 'already_yours', identityId: id }
    }
    case 'link': {
      try {
        const r = await linkLoginIdentity(env, {
          tenant: env.TENANT_SLUG, provider: input.provider, providerSubject: input.subject,
          verifiedEmail: input.verifiedEmail, memberId: me, linkedByMemberId: me,
        })
        if (!r.ok) {
          return { ok: false, error: r.error === 'identity_revoked' ? 'identity_revoked' : r.error === 'competing_control' ? 'competing_control' : 'already_linked' }
        }
        await auditLink(env, auth, 'link', r.identity.id, { provider: input.provider, maskedEmail })
        return { ok: true, outcome: 'linked', identityId: r.identity.id }
      } catch (err) {
        // A concurrent link of the same subject loses on UNIQUE(tenant, provider, subject): that is "already linked".
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: /UNIQUE constraint failed/i.test(msg) ? 'already_linked' : 'service_error' }
      }
    }
    case 'reactivate': {
      // Same member, proved again through a fresh session-bound OAuth round trip: the only revoked row we ever revive.
      const res = await env.DB.prepare(
        `UPDATE human_login_identities SET revoked_at = NULL, verified_email = ?1, linked_by_member_id = ?2
          WHERE id = ?3 AND tenant = ?4 AND member_id = ?2 AND revoked_at IS NOT NULL`,
      ).bind(input.verifiedEmail, me, plan.identityId, env.TENANT_SLUG).run()
      if (Number(res.meta?.changes ?? 0) === 0) return { ok: false, error: 'changed' }
      await auditLink(env, auth, 'reactivate', plan.identityId, { provider: input.provider, maskedEmail })
      return { ok: true, outcome: 'reactivated', identityId: plan.identityId }
    }
    case 'move': {
      // Never re-point silently: the member must have been shown this exact duplicate and confirmed.
      if (!opts.confirmMove) return { ok: false, error: 'already_linked' }
      const exp = opts.expectedDuplicate
      if (!exp || exp.identityId !== plan.duplicate.identityId || exp.memberId !== plan.duplicate.memberId) {
        return { ok: false, error: 'changed' }
      }
      const { identityId, memberId: oldMemberId } = plan.duplicate
      const nowIso = new Date().toISOString()
      const nowSql = nowSqlUtc()
      const move = env.DB.prepare(
        `UPDATE human_login_identities
            SET member_id = ?1, linked_by_member_id = ?1, verified_email = ?2
          WHERE id = ?3 AND tenant = ?4 AND member_id = ?5 AND revoked_at IS NULL
            AND provider = ?6 AND provider_subject = ?7
            AND EXISTS (
              SELECT 1 FROM members cur
               WHERE cur.id = ?1 AND cur.tenant = ?4 AND cur.status = 'active' AND cur.archived_at IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM members old
               WHERE old.id = ?5 AND old.tenant = ?4 AND old.status = 'active' AND old.archived_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM agent_member_bindings b WHERE b.tenant = ?4 AND b.member_id = ?5
            )
            AND NOT EXISTS (
              SELECT 1 ${liveCompetingBearerSql({
                tenant: '?4', member: '?5', exemptLabel: '?8', exemptChannel: '?9', directoryChannel: '?10', now: '?11',
              })}
            )`,
      ).bind(
        me, input.verifiedEmail, identityId, env.TENANT_SLUG, oldMemberId, input.provider, input.subject,
        PROVISIONING_EXEMPT_TOKEN_LABEL, PROVISIONING_EXEMPT_TOKEN_CHANNEL, PROVISIONING_EXEMPT_DIRECTORY_CHANNEL, nowSql,
      )
      // Anchored on the move: it only revokes the old member's sessions for this identity if the row now belongs to `me`.
      const cutoff = env.DB.prepare(
        `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = 'identity_moved'
          WHERE tenant = ?2 AND member_id = ?3 AND login_identity_id = ?4 AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM human_login_identities h
               WHERE h.id = ?4 AND h.tenant = ?2 AND h.member_id = ?5 AND h.linked_by_member_id = ?5 AND h.revoked_at IS NULL
            )`,
      ).bind(nowIso, env.TENANT_SLUG, oldMemberId, identityId, me)
      let results: Awaited<ReturnType<typeof env.DB.batch>>
      try {
        results = await env.DB.batch([move, cutoff])
      } catch (err) {
        console.error('linked-signins move batch failed', { identity_id: identityId, error: err instanceof Error ? err.message : String(err) })
        return { ok: false, error: 'service_error' }
      }
      if (Number(results[0]?.meta?.changes ?? 0) === 0) return { ok: false, error: 'already_linked' }
      // Passkeys / phones enrolled under the old owner stay with the old member and are cut off (idempotent; a retry finishes it).
      await revokeMemberPasskeys(env, oldMemberId, 'login_identity_moved', { loginIdentityId: identityId })
      await revokeMemberTgDevices(env, oldMemberId, 'login_identity_moved', { loginIdentityId: identityId })
      await auditLink(env, auth, 'move', identityId, { provider: input.provider, maskedEmail, fromMemberId: oldMemberId })
      return { ok: true, outcome: 'moved', identityId }
    }
  }
}

export type UnlinkSignInResult =
  | { ok: true }
  | { ok: false; error: 'last_identity' | 'not_found' }

/**
 * Unlink one of the member's OWN live identities. The "never the last one" guard lives inside the UPDATE, so two
 * concurrent unlinks cannot both pass a read-then-write check and leave the member with no way in.
 */
export async function unlinkSignIn(env: Env, auth: AuthContext, identityId: string): Promise<UnlinkSignInResult> {
  const me = auth.memberId
  if (!me) return { ok: false, error: 'not_found' }
  const target = await env.DB.prepare(
    `SELECT provider, verified_email FROM human_login_identities
      WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL LIMIT 1`,
  ).bind(identityId, env.TENANT_SLUG, me).first<{ provider: string; verified_email: string | null }>()
  if (!target) return { ok: false, error: 'not_found' }
  const nowIso = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE human_login_identities SET revoked_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM human_login_identities o
           WHERE o.tenant = ?3 AND o.member_id = ?4 AND o.revoked_at IS NULL AND o.id != ?2
        )`,
  ).bind(nowIso, identityId, env.TENANT_SLUG, me).run()
  if (Number(res.meta?.changes ?? 0) === 0) return { ok: false, error: 'last_identity' }
  await revokeWebSessionsForLoginIdentity(env, env.TENANT_SLUG, me, identityId, 'identity_unlinked')
  await revokeMemberPasskeys(env, me, 'login_identity_unlinked', { loginIdentityId: identityId })
  await revokeMemberTgDevices(env, me, 'login_identity_unlinked', { loginIdentityId: identityId })
  await auditLink(env, auth, 'unlink', identityId, {
    provider: target.provider, maskedEmail: target.verified_email ? maskEmail(target.verified_email) : null,
  })
  return { ok: true }
}

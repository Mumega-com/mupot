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
//     inserting a second one; the old member keeps its row and its capabilities and is left for an admin to archive; it is marked superseded (#1997,
//     never email-attachable again) and its directory-channel connector tokens are revoked in the same batch.
//   - Unlink: self only, never the last live identity (guard is inside the UPDATE), cuts off the sessions/passkeys it issued.
//   - Every link, move and unlink writes a mutation_audit_entries row.

import type { AuthContext, Env } from '../types'
import { actorRankOnScopeFor, CAPABILITY_LIVE_PREDICATE, exceedsTargetRankCeiling, nowCapabilitySql, resolveCapabilities } from './capability'
import { identityHasLivePasskeys, identityRemovalNeedsRecovery, identityRemovalWriteGuard, identityRemovalPresenceSatisfied, linkLoginIdentity, resolveLoginIdentity, type LoginIdentityRecord } from './login-identity'
import { maskEmail } from './telegram-login-link'
import { nowSqlUtc } from './token-lifecycle'
import { revokeWebSessionsForLoginIdentity } from './web-sessions'
import { revokeMemberTgDevices } from '../secure-moments/telegram-miniapp-store'
import { auditMutation, prepareMutationAudit } from '../flight-spine/audit'
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
  /** Old member's email, masked (a***@domain), or null. */
  maskedEmail: string | null
  /** The Google account being moved, masked. */
  identityMaskedEmail: string | null
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
  email: string | null
  created_at: string
  status: string
  archived_at: string | null
}

async function memberFacts(env: Env, memberId: string): Promise<MemberFacts | null> {
  return env.DB.prepare(
    `SELECT email, created_at, status, archived_at FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
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
  return {
    kind: 'move',
    duplicate: {
      identityId: existing.id,
      memberId: other,
      createdAt: facts.created_at,
      permissions,
      maskedEmail: facts.email ? maskEmail(facts.email) : null,
      identityMaskedEmail: existing.verified_email ? maskEmail(existing.verified_email) : null,
    },
  }
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
      const requestId = crypto.randomUUID()
      // Re-read at write time and enforced INSIDE the statement too: a promotion of the old member between the plan and the
      // batch must not slip a higher-ranked member's identity away. (capabilities table only; the plan covers every plane.)
      const actorRank = await actorRankOnScopeFor(env, auth, 'org', null)
      // The move's guards, written once: the claim INSERT and the UPDATE evaluate the SAME predicate inside one transaction.
      const guard = `id = ?3 AND tenant = ?4 AND member_id = ?5 AND revoked_at IS NULL
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
              SELECT 1 FROM capabilities c
               WHERE c.member_id = ?5
                 AND ${CAPABILITY_LIVE_PREDICATE('c', '?13')}
                 AND CASE c.capability WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3 WHEN 'member' THEN 2 ELSE 1 END > ?12
            )
            AND NOT EXISTS (
              SELECT 1 ${liveCompetingBearerSql({
                tenant: '?4', member: '?5', exemptLabel: '?8', exemptChannel: '?9', directoryChannel: '?10', now: '?11',
              })}
            )`
      // Moving this identity would make its old member's dependent passkeys
      // ineffective. This confirmation flow has no old-member passkey grant,
      // so recovery must be initiated by an organization owner instead.
      const passkeySafeGuard = `AND NOT EXISTS (
        SELECT 1 FROM member_passkeys p JOIN human_login_identities pi
          ON pi.id = p.login_identity_id AND pi.tenant = p.tenant AND pi.member_id = p.member_id AND pi.revoked_at IS NULL
         WHERE p.tenant = ?4 AND p.member_id = ?5 AND p.login_identity_id = ?3 AND p.revoked_at IS NULL
      )`
      const baseBinds = [
        me, input.verifiedEmail, identityId, env.TENANT_SLUG, oldMemberId, input.provider, input.subject,
        PROVISIONING_EXEMPT_TOKEN_LABEL, PROVISIONING_EXEMPT_TOKEN_CHANNEL, PROVISIONING_EXEMPT_DIRECTORY_CHANNEL, nowSql, actorRank, nowCapabilitySql(),
      ]
      const claim = env.DB.prepare(
        `INSERT INTO login_identity_move_claims (stamp, tenant, identity_id, from_member_id, to_member_id, claimed_at)
         SELECT ?14, ?4, ?3, ?5, ?1, ?15 FROM human_login_identities WHERE ${guard} ${passkeySafeGuard}`,
      ).bind(...baseBinds, requestId, nowIso)
      const move = env.DB.prepare(
        `UPDATE human_login_identities SET member_id = ?1, linked_by_member_id = ?1, verified_email = ?2 WHERE ${guard} ${passkeySafeGuard}`,
      ).bind(...baseBinds)
      // Everything after the move lands only if THIS request's claim landed (stamp = requestId, the #1979 consumed_at pattern)
      // AND the identity now belongs to the actor; the cutoffs anchor on the audit row.
      let audit
      try {
        audit = await prepareMutationAudit(env, auth, {
          origin: 'admin_ui',
          handler: 'auth.linked_signins',
          operation: 'move',
          targetKind: 'login_identity',
          targetId: identityId,
          requestId,
          evidence: { provider: input.provider, masked_email: maskedEmail, from_member_id: oldMemberId },
        }, {
          sql: `EXISTS (
                  SELECT 1 FROM login_identity_move_claims m
                    JOIN human_login_identities h ON h.id = m.identity_id AND h.tenant = m.tenant
                   WHERE m.stamp = ?25 AND m.tenant = ?26 AND h.member_id = ?27 AND h.revoked_at IS NULL)`,
          binds: [requestId, env.TENANT_SLUG, me],
        })
      } catch (err) {
        console.error('linked-signins move audit prepare failed', { identity_id: identityId, error: err instanceof Error ? err.message : String(err) })
        return { ok: false, error: 'service_error' }
      }
      const anchored = `EXISTS (SELECT 1 FROM mutation_audit_entries a
                         WHERE a.tenant = ?1 AND a.request_id = ?2 AND a.handler = 'auth.linked_signins' AND a.operation = 'move')`
      const cutoff = env.DB.prepare(
        `UPDATE web_sessions SET revoked_at = ?3, revoke_reason = 'identity_moved'
          WHERE tenant = ?1 AND member_id = ?4 AND login_identity_id = ?5 AND revoked_at IS NULL AND ${anchored}`,
      ).bind(env.TENANT_SLUG, requestId, nowIso, oldMemberId, identityId)
      // A moved identity makes its old member's passkeys unusable through the
      // live-identity predicate. Keep the rows as durable enrolment history:
      // passkey removal itself requires another live passkey confirmation.
      const phones = env.DB.prepare(
        `UPDATE tg_miniapp_devices SET revoked_at = ?3, revoked_reason = 'login_identity_moved'
          WHERE tenant = ?1 AND member_id = ?4 AND login_identity_id = ?5 AND revoked_at IS NULL AND ${anchored}`,
      ).bind(env.TENANT_SLUG, requestId, nowIso, oldMemberId, identityId)
      // mupot#1997: the old member is now identityless. Mark it superseded (only if it holds no other live identity) so no
      // email attach re-binds a login to it, and sign out its directory-channel connectors. Same audit anchor as the cutoffs.
      // ONE condition for all three effects: the old member holds no other live identity (it is being superseded).
      const beingSuperseded = `NOT EXISTS (
              SELECT 1 FROM human_login_identities h
               WHERE h.tenant = ?1 AND h.member_id = ?4 AND h.revoked_at IS NULL
            )`
      const supersede = env.DB.prepare(
        `UPDATE members SET superseded_by_member_id = ?5
          WHERE id = ?4 AND tenant = ?1 AND superseded_by_member_id IS NULL AND ${anchored}
            AND ${beingSuperseded}`,
      ).bind(env.TENANT_SLUG, requestId, nowIso, oldMemberId, me)
      const connectors = env.DB.prepare(
        `UPDATE member_tokens SET revoked_at = ?3
          WHERE tenant = ?1 AND member_id = ?4 AND channel = ?5 AND revoked_at IS NULL AND ${anchored}
            AND ${beingSuperseded}`,
      ).bind(env.TENANT_SLUG, requestId, nowIso, oldMemberId, PROVISIONING_EXEMPT_DIRECTORY_CHANNEL)
      // A bound Telegram chat is a credential too: a superseded member must not keep deciding through it.
      const telegram = env.DB.prepare(
        `UPDATE members SET telegram_chat_id = NULL
          WHERE id = ?4 AND tenant = ?1 AND telegram_chat_id IS NOT NULL AND ${anchored}
            AND ${beingSuperseded}`,
      ).bind(env.TENANT_SLUG, requestId, nowIso, oldMemberId)
      let results: Awaited<ReturnType<typeof env.DB.batch>>
      try {
        results = await env.DB.batch([claim, move, audit, cutoff, phones, supersede, connectors, telegram])
      } catch (err) {
        console.error('linked-signins move batch failed', { identity_id: identityId, error: err instanceof Error ? err.message : String(err) })
        return { ok: false, error: 'service_error' }
      }
      if (Number(results[1]?.meta?.changes ?? 0) === 0) return { ok: false, error: 'already_linked' }
      return { ok: true, outcome: 'moved', identityId }
    }
  }
}

export type UnlinkSignInResult =
  | { ok: true }
  | { ok: false; error: 'last_identity' | 'not_found' | 'presence_required' | 'passkey_recovery_required' }

/**
 * Unlink one of the member's OWN live identities. The "never the last one" guard lives inside the UPDATE, so two
 * concurrent unlinks cannot both pass a read-then-write check and leave the member with no way in.
 */
export async function unlinkSignIn(env: Env, auth: AuthContext, identityId: string, presenceGrantId?: string): Promise<UnlinkSignInResult> {
  const me = auth.memberId
  if (!me) return { ok: false, error: 'not_found' }
  const target = await env.DB.prepare(
    `SELECT provider, verified_email FROM human_login_identities
      WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL LIMIT 1`,
  ).bind(identityId, env.TENANT_SLUG, me).first<{ provider: string; verified_email: string | null }>()
  if (!target) return { ok: false, error: 'not_found' }
  if (await identityRemovalNeedsRecovery(env, env.TENANT_SLUG, me, identityId)) return { ok: false, error: 'passkey_recovery_required' }
  if (await identityHasLivePasskeys(env, env.TENANT_SLUG, me, identityId)
    && !(await identityRemovalPresenceSatisfied(env, env.TENANT_SLUG, me, identityId, presenceGrantId))) {
    return { ok: false, error: 'presence_required' }
  }
  const nowIso = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE human_login_identities SET revoked_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL
        AND ${identityRemovalWriteGuard('?3', '?4', '?2', '?5', '?1')}
        AND EXISTS (
          SELECT 1 FROM human_login_identities o
           WHERE o.tenant = ?3 AND o.member_id = ?4 AND o.revoked_at IS NULL AND o.id != ?2
        )`,
  ).bind(nowIso, identityId, env.TENANT_SLUG, me, presenceGrantId ?? null).run()
  if (Number(res.meta?.changes ?? 0) === 0) return { ok: false, error: 'last_identity' }
  await revokeWebSessionsForLoginIdentity(env, env.TENANT_SLUG, me, identityId, 'identity_unlinked')
  await revokeMemberTgDevices(env, me, 'login_identity_unlinked', { loginIdentityId: identityId })
  await auditLink(env, auth, 'unlink', identityId, {
    provider: target.provider, maskedEmail: target.verified_email ? maskEmail(target.verified_email) : null,
  })
  return { ok: true }
}

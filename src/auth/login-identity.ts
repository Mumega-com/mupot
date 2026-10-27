// mupot — human_login_identities (SENSITIVE). Tenant-local binding from an
// external verified login identity to ONE canonical human member.
//
// Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
// elevation-design.md, "Human login identity". Delivery Sequence step 1
// (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
//
// Authorization binds to (tenant, provider, provider_subject) — never to a
// display email. linkLoginIdentity is idempotent for the SAME member (a
// repeat login re-resolves the same row) and REFUSES to silently reassign an
// identity already bound to a DIFFERENT member — that would let one login
// event quietly move standing authority from one member to another, which is
// exactly the "two email strings happen to match" failure the design calls
// out by name.
//
// This module never creates a `members` row itself. Member provisioning is a
// separate, existing concern (invites / SSO auto-enrollment / the members
// service); this module only records and resolves the (tenant, provider,
// subject) → member_id join once a member already exists to bind to.

import type { Env } from '../types'
import { revokeMemberTgDevices } from '../secure-moments/telegram-miniapp-store'
import { revokeWebSessionsForLoginIdentity } from './web-sessions'
import { nowSqlUtc } from './token-lifecycle'
import {
  liveCompetingBearerSql,
  notSupersededSql,
  PROVISIONING_EXEMPT_DIRECTORY_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_LABEL,
} from '../members/exclusive-control'

export interface LoginIdentityRecord {
  id: string
  tenant: string
  provider: string
  provider_subject: string
  verified_email: string | null
  member_id: string
  linked_by_member_id: string | null
  created_at: string
  revoked_at: string | null
}

/** Atomic write predicate shared by every path making an identity ineffective. */
export function identityRemovalWriteGuard(tenant: string, member: string, identity: string, grant: string, now: string): string {
  return `(NOT EXISTS (SELECT 1 FROM member_passkeys doomed
    WHERE doomed.tenant = ${tenant} AND doomed.member_id = ${member} AND doomed.login_identity_id = ${identity} AND doomed.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM presence_grants g
      JOIN member_passkeys p ON p.id = g.satisfied_passkey_id AND p.tenant = g.tenant AND p.member_id = g.member_id AND p.revoked_at IS NULL
      JOIN human_login_identities live ON live.id = p.login_identity_id AND live.tenant = p.tenant AND live.member_id = p.member_id AND live.revoked_at IS NULL
      WHERE g.id = ${grant} AND g.tenant = ${tenant} AND g.member_id = ${member} AND g.kind = 'login_identity_revoke'
        AND g.subject_id = ${identity} AND g.status = 'consumed' AND g.expires_at > ${now} AND p.login_identity_id != ${identity}))`
}

export async function identityRemovalNeedsRecovery(env: Env, tenant: string, member: string, identity: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS blocked FROM member_passkeys p
    JOIN human_login_identities own ON own.id = p.login_identity_id AND own.tenant = p.tenant AND own.member_id = p.member_id AND own.revoked_at IS NULL
    WHERE p.tenant = ?1 AND p.member_id = ?2 AND p.login_identity_id = ?3 AND p.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM member_passkeys other JOIN human_login_identities live
        ON live.id = other.login_identity_id AND live.tenant = other.tenant AND live.member_id = other.member_id AND live.revoked_at IS NULL
        WHERE other.tenant = ?1 AND other.member_id = ?2 AND other.revoked_at IS NULL AND other.login_identity_id != ?3) LIMIT 1`)
    .bind(tenant, member, identity).first()
  return row !== null
}

/** A consumed grant can remove an identity only when another live passkey confirmed it. */
export async function identityRemovalPresenceSatisfied(
  env: Env, tenant: string, memberId: string, identityId: string, presenceGrantId: string | undefined, nowMs: number = Date.now(),
): Promise<boolean> {
  if (!presenceGrantId || presenceGrantId.length > 64) return false
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM presence_grants g
      JOIN member_passkeys confirmer ON confirmer.id = g.satisfied_passkey_id AND confirmer.tenant = g.tenant
       AND confirmer.member_id = g.member_id AND confirmer.revoked_at IS NULL
      JOIN human_login_identities live ON live.id = confirmer.login_identity_id AND live.tenant = confirmer.tenant
       AND live.member_id = confirmer.member_id AND live.revoked_at IS NULL
      WHERE g.id = ?1 AND g.tenant = ?2 AND g.member_id = ?3 AND g.kind = 'login_identity_revoke'
       AND g.subject_id = ?4 AND g.status = 'consumed' AND g.expires_at > ?5
       AND confirmer.login_identity_id != ?4 LIMIT 1`,
  ).bind(presenceGrantId, tenant, memberId, identityId, new Date(nowMs).toISOString()).first<{ present: number }>()
  return row !== null
}

export async function identityHasLivePasskeys(env: Env, tenant: string, memberId: string, identityId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM member_passkeys p JOIN human_login_identities i
       ON i.id = p.login_identity_id AND i.tenant = p.tenant AND i.member_id = p.member_id AND i.revoked_at IS NULL
      WHERE p.tenant = ?1 AND p.member_id = ?2 AND p.login_identity_id = ?3 AND p.revoked_at IS NULL LIMIT 1`,
  ).bind(tenant, memberId, identityId).first<{ present: number }>()
  return row !== null
}

export type LinkLoginIdentityResult =
  | { ok: true; identity: LoginIdentityRecord; created: boolean }
  | { ok: false; error: 'identity_bound_to_other_member'; identity: LoginIdentityRecord }
  | { ok: false; error: 'identity_revoked'; identity: LoginIdentityRecord }
  // mupot#1551 (Athena's ruling, Option B, point 4): requireExclusiveControl's
  // conditional INSERT matched zero rows — a competing controller (bearer,
  // Telegram bind, or another live identity) appeared for this member between
  // the caller's decideIdentitylessAttach() read and this write. The link
  // fails; it never lands on the losing side of that race.
  | { ok: false; error: 'competing_control' }

/**
 * resolveLoginIdentity — look up a LIVE (not revoked) login identity by its
 * tenant-scoped join key. Returns null on no match or a revoked row (fail
 * closed: a revoked identity resolves to nothing, same as if it never linked).
 */
export async function resolveLoginIdentity(
  env: Env,
  tenant: string,
  provider: string,
  providerSubject: string,
): Promise<LoginIdentityRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, tenant, provider, provider_subject, verified_email, member_id,
            linked_by_member_id, created_at, revoked_at
       FROM human_login_identities
      WHERE tenant = ?1 AND provider = ?2 AND provider_subject = ?3
        AND revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(tenant, provider, providerSubject)
    .first<LoginIdentityRecord>()
  return row ?? null
}

export interface LinkLoginIdentityInput {
  tenant: string
  provider: string
  providerSubject: string
  verifiedEmail: string | null
  memberId: string
  linkedByMemberId?: string | null
  // mupot#1551 (Athena's ruling, Option B, point 4): set by an
  // identity-LESS-row bootstrap attach (resolve-human-member.ts step 3, via
  // registerWebSession) — never by an ordinary re-resolve of an
  // already-identified member. When true, the INSERT itself re-verifies
  // exclusive control (no live identity / unbound bearer / Telegram bind for
  // this member) inside the SAME statement that creates the row, so a
  // competing credential landing between the caller's decideIdentitylessAttach
  // read and this write makes the link FAIL atomically instead of racing it.
  requireExclusiveControl?: boolean
}

/**
 * linkLoginIdentity — bind (tenant, provider, subject) to a member.
 *
 * - No existing row for this join key → INSERT, created: true.
 * - Existing LIVE row for the SAME member → idempotent re-resolve,
 *   created: false. A repeat login is not an error.
 * - Existing LIVE row for a DIFFERENT member → refused
 *   (identity_bound_to_other_member). Never silently reassigned; an operator
 *   must explicitly revoke the old binding first if a re-link is intended.
 * - Existing REVOKED row for this join key → refused (identity_revoked); a
 *   revoked identity does not silently come back to life on next login. Fail
 *   closed and surface it, rather than quietly re-linking.
 * - `requireExclusiveControl`, no existing row for this join key → the INSERT
 *   runs as `INSERT ... SELECT ... WHERE NOT EXISTS(competing controller)`;
 *   zero rows written → { ok: false, error: 'competing_control' }.
 */
export async function linkLoginIdentity(
  env: Env,
  input: LinkLoginIdentityInput,
): Promise<LinkLoginIdentityResult> {
  const { tenant, provider, providerSubject } = input
  const existing = await env.DB.prepare(
    `SELECT id, tenant, provider, provider_subject, verified_email, member_id,
            linked_by_member_id, created_at, revoked_at
       FROM human_login_identities
      WHERE tenant = ?1 AND provider = ?2 AND provider_subject = ?3
      LIMIT 1`,
  )
    .bind(tenant, provider, providerSubject)
    .first<LoginIdentityRecord>()

  if (existing) {
    if (existing.revoked_at !== null) {
      return { ok: false, error: 'identity_revoked', identity: existing }
    }
    if (existing.member_id !== input.memberId) {
      return { ok: false, error: 'identity_bound_to_other_member', identity: existing }
    }
    return { ok: true, identity: existing, created: false }
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  if (input.requireExclusiveControl) {
    const nowSql = nowSqlUtc()
    const result = await env.DB.prepare(
      `INSERT INTO human_login_identities
         (id, tenant, provider, provider_subject, verified_email, member_id, linked_by_member_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE NOT EXISTS (
          SELECT 1 FROM human_login_identities h2
           WHERE h2.tenant = ?2 AND h2.member_id = ?6 AND h2.revoked_at IS NULL
        )
        AND NOT EXISTS (
          -- Both exemptions below are CONTAINMENT, not proof of origin — an
          -- org admin can mint a caller-chosen label/channel via
          -- POST /members/:id/tokens (src/members/service.ts mintMemberToken)
          -- and spoof either onto a row they already control. Not a
          -- privilege escalation (they already hold mint power over the row),
          -- but do not add a second guarantee on top of either exemption
          -- without re-reading src/members/exclusive-control.ts's header,
          -- which documents why no stronger anchor (e.g.
          -- pot_provision_receipts) is reachable from the tenant's own D1,
          -- and why the directory-channel exemption exists at all (mupot#1551
          -- round 2 P0: mintDirectoryToken's own unbound connector token).
          SELECT 1 ${liveCompetingBearerSql({
            tenant: '?2', member: '?6', exemptLabel: '?9', exemptChannel: '?10', directoryChannel: '?11', now: '?12',
          })}
        )
        AND NOT EXISTS (
          SELECT 1 FROM members m
           WHERE m.id = ?6 AND m.tenant = ?2 AND m.telegram_chat_id IS NOT NULL
        )
        AND EXISTS (
          -- mupot#1551 (Athena BLOCK, both gates): row liveness was checked
          -- in JS before this write, never inside it — a member archived or
          -- suspended strictly between the caller's decideIdentitylessAttach
          -- read and this INSERT must not get linked. Migration 0173's
          -- archive_row also flips status to 'suspended' (belt), but this
          -- checks archived_at directly too (suspenders) rather than trusting
          -- that coupling to hold forever. EXISTS, not a scalar compare on a
          -- LEFT JOIN column — status is NOT NULL by schema so the equality
          -- check cannot silently flip on NULL, and archived_at's own NULL
          -- is the correct "not archived" value, checked with IS NULL, never
          -- a negated equality.
          SELECT 1 FROM members m2
           WHERE m2.id = ?6 AND m2.tenant = ?2
             AND m2.status = 'active' AND m2.archived_at IS NULL
             AND ${notSupersededSql('m2')}
        )`,
    )
      .bind(
        id,
        tenant,
        provider,
        providerSubject,
        input.verifiedEmail,
        input.memberId,
        input.linkedByMemberId ?? null,
        now,
        PROVISIONING_EXEMPT_TOKEN_LABEL,
        PROVISIONING_EXEMPT_TOKEN_CHANNEL,
        PROVISIONING_EXEMPT_DIRECTORY_CHANNEL,
        nowSql,
      )
      .run()

    const changes = Number(result.meta?.changes ?? 0)
    if (changes === 0) {
      return { ok: false, error: 'competing_control' }
    }

    return {
      ok: true,
      created: true,
      identity: {
        id,
        tenant,
        provider,
        provider_subject: providerSubject,
        verified_email: input.verifiedEmail,
        member_id: input.memberId,
        linked_by_member_id: input.linkedByMemberId ?? null,
        created_at: now,
        revoked_at: null,
      },
    }
  }

  // mupot#1997: even the non-exclusive link never attaches a login to a superseded member.
  const plain = await env.DB.prepare(
    `INSERT INTO human_login_identities
       (id, tenant, provider, provider_subject, verified_email, member_id, linked_by_member_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
      WHERE NOT EXISTS (SELECT 1 FROM members sm WHERE sm.id = ?6 AND sm.tenant = ?2 AND NOT (${notSupersededSql('sm')}))`,
  )
    .bind(
      id,
      tenant,
      provider,
      providerSubject,
      input.verifiedEmail,
      input.memberId,
      input.linkedByMemberId ?? null,
      now,
    )
    .run()
  if (Number(plain.meta?.changes ?? 0) === 0) return { ok: false, error: 'competing_control' }

  return {
    ok: true,
    created: true,
    identity: {
      id,
      tenant,
      provider,
      provider_subject: providerSubject,
      verified_email: input.verifiedEmail,
      member_id: input.memberId,
      linked_by_member_id: input.linkedByMemberId ?? null,
      created_at: now,
      revoked_at: null,
    },
  }
}

/** listLoginIdentities — every identity (live or revoked) for a member. */
export async function listLoginIdentities(
  env: Env,
  tenant: string,
  memberId: string,
): Promise<LoginIdentityRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id, tenant, provider, provider_subject, verified_email, member_id,
            linked_by_member_id, created_at, revoked_at
       FROM human_login_identities
      WHERE tenant = ?1 AND member_id = ?2
      ORDER BY created_at DESC`,
  )
    .bind(tenant, memberId)
    .all<LoginIdentityRecord>()
  return rows.results ?? []
}

/**
 * revokeLoginIdentity — set revoked_at on exactly one identity, scoped to
 * tenant + owning member, and cut off everything that identity issued. The
 * identity write is idempotent (already revoked => { revoked: false }), and the
 * dependent cutoff runs whenever the identity IS revoked, not only on the call
 * that revoked it: web sessions bound to it first. Passkeys remain durable
 * history and their live-identity check makes one enrolled under this identity
 * unusable. A revoked
 * identity will not resolve and will not silently re-link (identity_revoked).
 */
export async function revokeLoginIdentity(
  env: Env,
  tenant: string,
  memberId: string,
  identityId: string,
  presenceGrantId?: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean; identity: LoginIdentityRecord | null; sessionsRevoked: number; passkeyRecoveryRequired: boolean; presenceRequired: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  // An identity makes every passkey enrolled under it ineffective. Do not let
  // this indirect path remove the member's final live passkey; recovery is an
  // organization-owner operation. The same predicate is repeated in UPDATE so
  // a concurrent identity/passkey change cannot race the preflight.
  const wouldRemoveLastLivePasskey = await env.DB.prepare(
    `SELECT 1 AS blocked
       FROM member_passkeys doomed
      WHERE doomed.tenant = ?1 AND doomed.member_id = ?2 AND doomed.login_identity_id = ?3 AND doomed.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM member_passkeys survivor
            JOIN human_login_identities live ON live.id = survivor.login_identity_id
             AND live.tenant = survivor.tenant AND live.member_id = survivor.member_id AND live.revoked_at IS NULL
           WHERE survivor.tenant = ?1 AND survivor.member_id = ?2 AND survivor.revoked_at IS NULL
             AND survivor.login_identity_id != ?3
        ) LIMIT 1`,
  ).bind(tenant, memberId, identityId).first<{ blocked: number }>()
  if (wouldRemoveLastLivePasskey) return { revoked: false, identity: null, sessionsRevoked: 0, passkeyRecoveryRequired: true, presenceRequired: false }
  const hasDependent = await identityHasLivePasskeys(env, tenant, memberId, identityId)
  if (hasDependent && !(await identityRemovalPresenceSatisfied(env, tenant, memberId, identityId, presenceGrantId, nowMs))) {
    return { revoked: false, identity: null, sessionsRevoked: 0, passkeyRecoveryRequired: false, presenceRequired: true }
  }
  const result = await env.DB.prepare(
    `UPDATE human_login_identities SET revoked_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL
        AND ${identityRemovalWriteGuard('?3', '?4', '?2', '?5', '?1')}
        AND NOT EXISTS (
          SELECT 1 FROM member_passkeys doomed
           WHERE doomed.tenant = ?3 AND doomed.member_id = ?4 AND doomed.login_identity_id = ?2 AND doomed.revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM member_passkeys survivor
                 JOIN human_login_identities live ON live.id = survivor.login_identity_id
                  AND live.tenant = survivor.tenant AND live.member_id = survivor.member_id AND live.revoked_at IS NULL
                WHERE survivor.tenant = ?3 AND survivor.member_id = ?4 AND survivor.revoked_at IS NULL
                  AND survivor.login_identity_id != ?2
             )
        )`,
  )
    .bind(nowIso, identityId, tenant, memberId, presenceGrantId ?? null)
    .run()
  const changes = Number(result.meta?.changes ?? 0)
  const identity = await env.DB.prepare(
    `SELECT id, tenant, provider, provider_subject, verified_email, member_id,
            linked_by_member_id, created_at, revoked_at
       FROM human_login_identities
      WHERE id = ?1 AND tenant = ?2 AND member_id = ?3
      LIMIT 1`,
  )
    .bind(identityId, tenant, memberId)
    .first<LoginIdentityRecord>()
  let sessionsRevoked = 0
  if (identity && identity.revoked_at) {
    // Sessions are the live browser door. A passkey bound to this identity is
    // already refused by the decision path's live-identity check; do not delete
    // it here because passkey removal requires another live passkey's grant.
    sessionsRevoked = (await revokeWebSessionsForLoginIdentity(env, tenant, memberId, identityId, 'identity_revoked', nowMs)).revokedCount
    await revokeMemberTgDevices(env, memberId, 'login_identity_revoked', { loginIdentityId: identityId }, nowMs)
  }
  return { revoked: changes > 0, identity: identity ?? null, sessionsRevoked, passkeyRecoveryRequired: false, presenceRequired: false }
}

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

export type LinkLoginIdentityResult =
  | { ok: true; identity: LoginIdentityRecord; created: boolean }
  | { ok: false; error: 'identity_bound_to_other_member'; identity: LoginIdentityRecord }
  | { ok: false; error: 'identity_revoked'; identity: LoginIdentityRecord }

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
  await env.DB.prepare(
    `INSERT INTO human_login_identities
       (id, tenant, provider, provider_subject, verified_email, member_id, linked_by_member_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
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
 * tenant + owning member. Idempotent: already-revoked is a no-op
 * ({ revoked: false }), never an error. A revoked identity will not resolve
 * and will not silently re-link (identity_revoked).
 */
export async function revokeLoginIdentity(
  env: Env,
  tenant: string,
  memberId: string,
  identityId: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean; identity: LoginIdentityRecord | null }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE human_login_identities SET revoked_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL`,
  )
    .bind(nowIso, identityId, tenant, memberId)
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
  return { revoked: changes > 0, identity: identity ?? null }
}

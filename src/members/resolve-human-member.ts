// Identity-first human → member resolution.
// Athena 2026-09-02: explicit human_login_identities binding
// (tenant, provider, provider_subject) MUST win over members.email on EVERY
// path. Email is bootstrap-only when no live identity exists.
//
// One resolver. Five call sites. Copying the precedence into each site is
// how site four went unfixed while site one got attention.

import type { Env } from '../types'
import { resolveLoginIdentity } from '../auth/login-identity'

export const OWNER_LOGIN_EMAILS_KEY = 'owner_login_emails'

export interface ResolveHumanMemberInput {
  tenant: string
  provider?: string | null
  providerSubject?: string | null
  email?: string | null
}

export interface ResolvedHumanMember {
  id: string
  status: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function uniqueOrgOwnerId(env: Env): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS id
       FROM members m
       JOIN capabilities c ON c.member_id = m.id
      WHERE m.tenant = ?1
        AND m.status = 'active'
        AND c.scope_type = 'org'
        AND c.scope_id IS NULL
        AND c.capability = 'owner'
      LIMIT 2`,
  ).bind(env.TENANT_SLUG).all<{ id: string }>()
  const found = rows.results ?? []
  if (found.length !== 1) return null
  return found[0].id
}

async function ownerAliasMemberId(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT value FROM org_settings WHERE key = ?1 LIMIT 1',
  ).bind(OWNER_LOGIN_EMAILS_KEY).first<{ value: string }>()
  if (!row?.value) return null
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return null
    const aliases = parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeEmail)
    if (!aliases.includes(email)) return null
  } catch {
    return null
  }
  return uniqueOrgOwnerId(env)
}

async function memberById(
  env: Env,
  tenant: string,
  memberId: string,
  activeOnly: boolean,
): Promise<ResolvedHumanMember | null> {
  return env.DB.prepare(
    `SELECT id, status FROM members
      WHERE id = ?1 AND tenant = ?2${activeOnly ? " AND status = 'active'" : ''}
      LIMIT 1`,
  ).bind(memberId, tenant).first<ResolvedHumanMember>()
}

/**
 * Resolve a human to one active member.
 * 1. Live (tenant, provider, provider_subject) identity.
 * 2. Live identity whose verified_email matches — ONLY when provider/subject
 *    are absent. A supplied join key that missed must NOT fall through to
 *    email; that is account takeover (fresh subject + victim verified_email).
 *    When provider is present without a subject, the match is also scoped
 *    to that provider (0143: authorization is the join key, not a display
 *    email across providers).
 * 3. members.email. A supplied-but-missed join key may bootstrap ONLY a
 *    member with no live identity (steal protection). Email-only still
 *    resolves the primary members.email even if that member already has a
 *    live identity whose verified_email differs (write-once email drift).
 * 4. owner_login_emails → unique org owner. Same join-key gate as step 2:
 *    never after a supplied-but-missed subject.
 * Missing identity table (migration not applied) falls through to email bootstrap.
 * Any other D1 failure is rethrown — silent email-first is the inversion Athena banned.
 */
export function isMissingHumanLoginIdentitiesTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Match D1/SQLite's current "no such table" wording only. If the engine
  // rewords it, this returns false and the caller THROWS — fail SAFE (an
  // error, not a wrong human). Do not widen the regex to "be helpful".
  return /no such table:\s*human_login_identities/i.test(msg)
}

async function resolveHumanMemberRecord(
  env: Env,
  input: ResolveHumanMemberInput,
  activeOnly: boolean,
): Promise<ResolvedHumanMember | null> {
  const tenant = input.tenant
  const joinKeyPresent = !!(input.provider && input.providerSubject)
  try {
    if (input.provider && input.providerSubject) {
      const ident = await resolveLoginIdentity(env, tenant, input.provider, input.providerSubject)
      if (ident) return memberById(env, tenant, ident.member_id, activeOnly)
    }

    const email = input.email ? normalizeEmail(input.email) : ''
    // Step 2 is gated on a missing join key. The ungated version let a
    // never-seen provider_subject inherit a victim member via verified_email.
    if (email && !joinKeyPresent) {
      const identByEmail = input.provider
        ? await env.DB.prepare(
            `SELECT h.member_id AS id, m.status AS status
               FROM human_login_identities h
               JOIN members m ON m.id = h.member_id AND m.tenant = h.tenant
              WHERE h.tenant = ?1 AND lower(h.verified_email) = ?2 AND h.revoked_at IS NULL
                AND h.provider = ?3
                ${activeOnly ? "AND m.status = 'active'" : ''}
              LIMIT 2`,
          ).bind(tenant, email, input.provider).all<ResolvedHumanMember>()
        : await env.DB.prepare(
            `SELECT h.member_id AS id, m.status AS status
               FROM human_login_identities h
               JOIN members m ON m.id = h.member_id AND m.tenant = h.tenant
              WHERE h.tenant = ?1 AND lower(h.verified_email) = ?2 AND h.revoked_at IS NULL
                ${activeOnly ? "AND m.status = 'active'" : ''}
              LIMIT 2`,
          ).bind(tenant, email).all<ResolvedHumanMember>()
      const rows = identByEmail.results ?? []
      if (rows.length === 1) return rows[0]
      if (rows.length > 1) return null
    }
  } catch (err) {
    if (!isMissingHumanLoginIdentitiesTable(err)) throw err
  }

  const email = input.email ? normalizeEmail(input.email) : ''
  if (!email) return null

  // Bind (email, tenant) stays the mock-matched shape. Steal protection
  // (NOT EXISTS live identity) applies only when a join key was supplied
  // and missed — that is the fresh-subject takeover. Email-only must still
  // resolve the member's own primary address when verified_email drifted.
  try {
    const byEmail = joinKeyPresent
      ? await env.DB.prepare(
          `SELECT id, status FROM members
            WHERE lower(email) = ?1 AND tenant = ?2 ${activeOnly ? "AND status = 'active'" : ''}
              AND NOT EXISTS (
                SELECT 1 FROM human_login_identities h
                 WHERE h.tenant = members.tenant
                   AND h.member_id = members.id
                   AND h.revoked_at IS NULL
              )
            LIMIT 1`,
        ).bind(email, tenant).first<ResolvedHumanMember>()
      : await env.DB.prepare(
          `SELECT id, status FROM members
            WHERE lower(email) = ?1 AND tenant = ?2 ${activeOnly ? "AND status = 'active'" : ''}
            LIMIT 1`,
        ).bind(email, tenant).first<ResolvedHumanMember>()
    if (byEmail) return byEmail
  } catch (err) {
    if (!isMissingHumanLoginIdentitiesTable(err)) throw err
    const byEmail = await env.DB.prepare(
      `SELECT id, status FROM members
        WHERE lower(email) = ?1 AND tenant = ?2 ${activeOnly ? "AND status = 'active'" : ''}
        LIMIT 1`,
    ).bind(email, tenant).first<ResolvedHumanMember>()
    if (byEmail) return byEmail
  }

  // Step 4: same join-key gate as step 2. A missed subject must not
  // inherit the org owner via an operator alias.
  if (joinKeyPresent) return null
  const ownerId = await ownerAliasMemberId(env, email)
  return ownerId ? { id: ownerId, status: 'active' } : null
}

export function resolveHumanMember(
  env: Env,
  input: ResolveHumanMemberInput,
): Promise<ResolvedHumanMember | null> {
  return resolveHumanMemberRecord(env, input, false)
}

export async function resolveHumanMemberId(
  env: Env,
  input: ResolveHumanMemberInput,
): Promise<string | null> {
  const member = await resolveHumanMemberRecord(env, input, true)
  return member?.id ?? null
}

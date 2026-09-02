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

/**
 * Resolve a human to one active member.
 * 1. Live (tenant, provider, provider_subject) identity.
 * 2. Live identity whose verified_email matches — ONLY when provider/subject
 *    are absent. A supplied join key that missed must NOT fall through to
 *    email; that is account takeover (fresh subject + victim verified_email).
 * 3. members.email bootstrap — ONLY if that member has no live identity.
 *    Bootstrap onto a member who already has a live identity is the same
 *    takeover one hop down.
 * 4. owner_login_emails → unique org owner.
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

export async function resolveHumanMemberId(
  env: Env,
  input: ResolveHumanMemberInput,
): Promise<string | null> {
  const tenant = input.tenant
  try {
    if (input.provider && input.providerSubject) {
      const ident = await resolveLoginIdentity(env, tenant, input.provider, input.providerSubject)
      if (ident) return ident.member_id
    }

    const email = input.email ? normalizeEmail(input.email) : ''
    // Step 2 is gated on a missing join key. The docstring always said this;
    // the ungated version let a never-seen provider_subject inherit a victim
    // member via verified_email, then registerWebSession persisted it.
    if (email && !(input.provider && input.providerSubject)) {
      const identByEmail = await env.DB.prepare(
        `SELECT member_id FROM human_login_identities
          WHERE tenant = ?1 AND lower(verified_email) = ?2 AND revoked_at IS NULL
          LIMIT 2`,
      ).bind(tenant, email).all<{ member_id: string }>()
      const rows = identByEmail.results ?? []
      if (rows.length === 1) return rows[0].member_id
      if (rows.length > 1) return null
    }
  } catch (err) {
    if (!isMissingHumanLoginIdentitiesTable(err)) throw err
  }

  const email = input.email ? normalizeEmail(input.email) : ''
  if (!email) return null

  // One members query: bind (email, tenant) stays the same shape existing
  // session mocks match. Bootstrap is refused in SQL when a live identity
  // already exists — a second lookup would steal the mock's next first()
  // and 404 a loop or fail-close a member who never had an identity.
  try {
    const byEmail = await env.DB.prepare(
      `SELECT id FROM members
        WHERE lower(email) = ?1 AND tenant = ?2 AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM human_login_identities h
             WHERE h.tenant = members.tenant
               AND h.member_id = members.id
               AND h.revoked_at IS NULL
          )
        LIMIT 1`,
    ).bind(email, tenant).first<{ id: string }>()
    if (byEmail) return byEmail.id
  } catch (err) {
    if (!isMissingHumanLoginIdentitiesTable(err)) throw err
    const byEmail = await env.DB.prepare(
      `SELECT id FROM members
        WHERE lower(email) = ?1 AND tenant = ?2 AND status = 'active'
        LIMIT 1`,
    ).bind(email, tenant).first<{ id: string }>()
    if (byEmail) return byEmail.id
  }

  return ownerAliasMemberId(env, email)
}

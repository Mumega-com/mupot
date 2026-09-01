// Verified-human member resolution (mupot#1162 item 1).
//
// OAuth and the dashboard both asked "who are you?" by members.email. The org
// owner often lives on a different row (unbound owner token, email NULL or a
// different address). The login row then holds nothing, so consent rule 3
// (human holds admin-or-higher on the agent's squad) fails closed — the owner
// is a stranger at their own door.
//
// Fix the IDENTITY, never the consent floor. Rules 2 and 3 stay. This module
// maps a verified email onto the owning member when org_settings.owner_login_emails
// lists that email and there is exactly one org:owner. No mapping → today's
// create-a-new-member behaviour (fail closed, no over-grant).
//
// Does not mint tokens. Does not copy grants. Does not lower canOnSquad('admin').

import type { Env } from '../types'

export const OWNER_LOGIN_EMAILS_KEY = 'owner_login_emails'

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function readOwnerLoginEmails(env: Env): Promise<string[]> {
  const row = await env.DB.prepare(
    'SELECT value FROM org_settings WHERE key = ?1 LIMIT 1',
  ).bind(OWNER_LOGIN_EMAILS_KEY).first<{ value: string }>()
  if (!row?.value) return []
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeEmail)
      .filter((item) => item.length > 0)
  } catch {
    return []
  }
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

/** Resolve a verified email to an existing active member. Null = no match. */
export async function resolveVerifiedHumanMemberId(
  env: Env,
  email: string,
): Promise<string | null> {
  const normalized = normalizeEmail(email)
  if (!normalized) return null

  const byEmail = await env.DB.prepare(
    `SELECT id FROM members
      WHERE lower(email) = ?1 AND tenant = ?2 AND status = 'active'
      LIMIT 1`,
  ).bind(normalized, env.TENANT_SLUG).first<{ id: string }>()
  if (byEmail) return byEmail.id

  const aliases = await readOwnerLoginEmails(env)
  if (!aliases.includes(normalized)) return null

  return uniqueOrgOwnerId(env)
}

/** Find the human member for a verified email, or create a zero-grant row. */
export async function findOrCreateHumanMember(
  env: Env,
  email: string,
  displayName: string,
): Promise<string> {
  const resolved = await resolveVerifiedHumanMemberId(env, email)
  if (resolved) return resolved

  const memberId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
     VALUES (?1, ?2, ?3, NULL, 'active', datetime('now'), ?4)`,
  ).bind(memberId, email, displayName.trim().slice(0, 128) || email, env.TENANT_SLUG).run()

  try {
    const { grantSignupDefault } = await import('../onboarding/doors')
    await grantSignupDefault(env, memberId)
  } catch (err) {
    console.error('oauth: signup default grant failed (non-fatal, member still created)', {
      tenant: env.TENANT_SLUG,
      member_id: memberId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return memberId
}

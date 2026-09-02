// Verified-human member resolution (mupot#1162). Identity-first wrapper.
// Athena 2026-09-02: this path MUST consult human_login_identities before
// members.email / owner_login_emails. The previous email-only version
// contained the bug it was written to fix.

import type { Env } from '../types'
import { OWNER_LOGIN_EMAILS_KEY, resolveHumanMemberId } from './resolve-human-member'

export { OWNER_LOGIN_EMAILS_KEY }

export async function resolveVerifiedHumanMemberId(
  env: Env,
  email: string,
  loginIdentity?: { provider: string; subject: string },
): Promise<string | null> {
  return resolveHumanMemberId(env, {
    tenant: env.TENANT_SLUG,
    provider: loginIdentity?.provider,
    providerSubject: loginIdentity?.subject,
    email,
  })
}

export async function findOrCreateHumanMember(
  env: Env,
  email: string,
  displayName: string,
  loginIdentity?: { provider: string; subject: string },
): Promise<string> {
  const resolved = await resolveVerifiedHumanMemberId(env, email, loginIdentity)
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

// Verified-human member resolution (mupot#1162). Identity-first wrapper.
// Athena 2026-09-02: this path MUST consult human_login_identities before
// members.email / owner_login_emails. The previous email-only version
// contained the bug it was written to fix.

import type { Env } from '../types'
import {
  OWNER_LOGIN_EMAILS_KEY,
  resolveHumanMemberForAttach,
  resolveHumanMemberId,
} from './resolve-human-member'
import { safeConsole } from '../lib/log'

export { OWNER_LOGIN_EMAILS_KEY }

/**
 * mupot#1551 round 2 (P0): thrown by findOrCreateHumanMemberDetailed instead of
 * silently inserting a duplicate member when resolveHumanMemberForAttach
 * returns `denied`/`ambiguous`. Callers that can offer the human a distinct
 * HTTP response (409/403) should catch this specifically; anything else
 * falls through to their existing generic error handling (e.g. 500), which
 * is strictly safer than what this replaces (an unconditional INSERT).
 */
export class MemberAttachDeniedError extends Error {
  readonly code: 'member_attach_denied' | 'member_attach_ambiguous'
  constructor(code: 'member_attach_denied' | 'member_attach_ambiguous', message: string) {
    super(message)
    this.name = 'MemberAttachDeniedError'
    this.code = code
  }
}

/**
 * Thrown by findOrCreateHumanMemberDetailed when its required `beforeCreate` guard refuses a NEW member. Nothing has been
 * written at that point: the guard runs after every resolve branch said `not_found` and before the members INSERT.
 */
export class NewMemberRefusedError extends Error {
  readonly retryAfter: number
  constructor(retryAfter: number) {
    super('new member creation refused by the pre-create guard')
    this.name = 'NewMemberRefusedError'
    this.retryAfter = retryAfter
  }
}

/** Runs immediately before the members INSERT, only when no existing member was found. `allowed: false` aborts the create. */
export type BeforeCreateGuard = () => Promise<{ allowed: boolean; retryAfter: number }>

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

/** Find the human's member row or create one, and say whether THIS call created it (mupot#1022: the consent screen tells a
 *  member once, in-band, that this sign-in just made a new, empty member).
 *
 *  `beforeCreate` is REQUIRED (a type error to omit) so a caller cannot get unmetered creation by accident. It guards only
 *  the INSERT made by THIS function; other code paths write members rows (invites, Telegram, bootstrap) and are not
 *  covered by it. The OAuth callback is the only production caller. The old no-guard wrapper `findOrCreateHumanMember`
 *  was removed for that reason; tests use tests/helpers/find-or-create-human-member.ts. */
export async function findOrCreateHumanMemberDetailed(
  env: Env,
  email: string,
  displayName: string,
  beforeCreate: BeforeCreateGuard,
  loginIdentity?: { provider: string; subject: string },
): Promise<{ id: string; created: boolean }> {
  const result = await resolveHumanMemberForAttach(env, {
    tenant: env.TENANT_SLUG,
    provider: loginIdentity?.provider,
    providerSubject: loginIdentity?.subject,
    email,
  })
  if (result.kind === 'resolved') return { id: result.member.id, created: false }
  if (result.kind === 'denied') {
    safeConsole.error('findOrCreateHumanMember: attach denied — competing controller, refusing to insert', {
      reason: result.reason,
      has_login_identity: !!loginIdentity,
    })
    throw new MemberAttachDeniedError(
      'member_attach_denied',
      `member row is already under someone else's control (${result.reason})`,
    )
  }
  if (result.kind === 'ambiguous') {
    safeConsole.error('findOrCreateHumanMember: attach ambiguous — normalized email collision, refusing to insert', {
      has_login_identity: !!loginIdentity,
    })
    throw new MemberAttachDeniedError(
      'member_attach_ambiguous',
      'normalized email matches more than one member',
    )
  }
  // result.kind === 'not_found' — create as today, unless the guard refuses. This is the only INSERT in THIS function,
  // so the guard sees exactly this function's creations: resolved/denied/ambiguous returned or threw above without it.
  // (Other code paths write members rows too; they are not metered here.)
  const guard = await beforeCreate()
  if (!guard.allowed) throw new NewMemberRefusedError(guard.retryAfter)

  const memberId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
     VALUES (?1, ?2, ?3, NULL, 'active', datetime('now'), ?4)`,
  ).bind(memberId, email, displayName.trim().slice(0, 128) || email, env.TENANT_SLUG).run()

  try {
    const { grantSignupDefault } = await import('../onboarding/doors')
    await grantSignupDefault(env, memberId)
  } catch (err) {
    // CodeQL js/clear-text-logging: never log a field sourced from `env` here —
    // some callers (e.g. the OAuth callback path) pass an Env carrying secrets,
    // and the scanner taints the whole object once that happens anywhere in the
    // codebase. memberId alone is unique and sufficient to find this row.
    safeConsole.error('oauth: signup default grant failed (non-fatal, member still created)', {
      member_id: memberId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return { id: memberId, created: true }
}

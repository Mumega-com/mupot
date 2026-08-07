// Channel identity resolution — step 2 of the caller-authority pipeline.
//
//   authenticity (per-platform) -> IDENTITY (here) -> authority (RBAC) -> act
//
// Spec: docs/architecture/channel-identity-and-caller-authority.md (#775)
//
// This replaces the hardcoded TELEGRAM_ALLOWED_SENDERS list. The list could only
// answer "may this person speak at all"; this answers "who is speaking", which is
// what lets the dispatch carry the CALLER's authority instead of the bot's.
//
// The fail-closed behaviour proven live on #769 is preserved exactly: an identity
// that does not resolve is REFUSED, with no dispatch and no side effect. What
// changes is that "resolves" now means "is a bound member" rather than "appears in
// an env var".

import type { Env } from '../types'

/** Platforms with an adapter. Kept in sync with the CHECK constraint in 0080. */
export const CHANNEL_PLATFORMS = ['telegram', 'discord', 'slack', 'google_chat', 'whatsapp'] as const
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number]

export function isChannelPlatform(v: string): v is ChannelPlatform {
  return (CHANNEL_PLATFORMS as readonly string[]).includes(v)
}

export type IdentityResolution =
  /** Bound, not revoked. Dispatch may proceed with this member's authority. */
  | { kind: 'member'; memberId: string; boundMethod: 'admin' | 'verified_login' }
  /** No binding row. The caller is a stranger. */
  | { kind: 'unbound' }
  /** A binding existed and was revoked. Distinguished from `unbound` for operators. */
  | { kind: 'revoked'; revokedAt: string }
  /** The lookup itself failed. MUST be treated as a refusal, never as `unbound`. */
  | { kind: 'unavailable'; reason: string }

/**
 * Resolve a platform caller to a member.
 *
 * Returns a discriminated union rather than `string | null` deliberately. A null
 * would collapse three different situations — "stranger", "revoked" and "the
 * database is down" — into one value, and only the first two are safe to treat as
 * a routine refusal. A DB outage that reads as "stranger" is an outage that looks
 * like normal operation, which is how a failure stops being noticed.
 *
 * ⚠ `platformUserId` must be the platform's IMMUTABLE id (Telegram numeric
 * from.id, Discord snowflake, Slack U-id) — never a username. Handles are
 * user-mutable and re-registerable; a handle-keyed binding is a spoofable
 * credential.
 */
export async function resolveChannelIdentity(
  env: Env,
  platform: string,
  platformUserId: string | number | undefined | null,
): Promise<IdentityResolution> {
  if (!isChannelPlatform(platform)) {
    return { kind: 'unavailable', reason: `unknown_platform:${platform}` }
  }
  // Coerce here rather than at the call site so every adapter gets the same
  // treatment, and reject empties explicitly — "" would otherwise become a valid
  // lookup key and could match a malformed row.
  const id = platformUserId === undefined || platformUserId === null ? '' : String(platformUserId).trim()
  if (!id) return { kind: 'unbound' }

  let row: Record<string, unknown> | null
  try {
    row = await env.DB.prepare(
      `SELECT member_id, bound_method, revoked_at
         FROM channel_identity
        WHERE tenant = ?1 AND platform = ?2 AND platform_user_id = ?3`,
    )
      .bind(env.TENANT_SLUG, platform, id)
      .first()
  } catch (err) {
    // Fail closed and say so. The caller must refuse on this, not proceed.
    return { kind: 'unavailable', reason: String(err).slice(0, 120) }
  }

  if (!row) return { kind: 'unbound' }
  if (row.revoked_at) return { kind: 'revoked', revokedAt: String(row.revoked_at) }

  const memberId = row.member_id ? String(row.member_id) : ''
  if (!memberId) {
    // A binding row with no member is corrupt, not permissive.
    return { kind: 'unavailable', reason: 'binding_row_missing_member' }
  }
  const bm = String(row.bound_method)
  return {
    kind: 'member',
    memberId,
    boundMethod: bm === 'verified_login' ? 'verified_login' : 'admin',
  }
}

/**
 * May this resolution dispatch?
 *
 * Exactly one outcome permits action. Written as an explicit allow rather than a
 * chain of negations so that adding a future `kind` fails CLOSED — a new variant
 * is denied until someone deliberately permits it. The inverse (`kind !==
 * 'unbound'`) would silently admit anything added later.
 *
 * It is a TYPE GUARD, not a boolean, on purpose: the compiler then refuses any code
 * that reads `memberId` without having passed this check. The authorisation gate
 * becomes impossible to skip by accident rather than merely inadvisable to skip.
 */
export function mayDispatch(
  r: IdentityResolution,
): r is Extract<IdentityResolution, { kind: 'member' }> {
  return r.kind === 'member'
}

/** Stable, non-leaking reason for a refusal — safe to return to an untrusted caller. */
export function refusalCode(r: IdentityResolution): string {
  switch (r.kind) {
    case 'unbound': return 'identity_not_bound'
    case 'revoked': return 'identity_revoked'
    case 'unavailable': return 'identity_unavailable'
    case 'member': return 'ok'
  }
}

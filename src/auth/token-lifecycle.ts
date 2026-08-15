// mupot — member_tokens lifecycle primitives (migration 0099).
//
// NO IMPORTS BEYOND TYPES, ON PURPOSE. There are two independent copies of the bearer
// lookup — `authenticateMember` (src/mcp/index.ts) and `resolveMemberByToken`
// (src/auth/member-bearer.ts) — a duplication the latter's own header admits and #41
// tracks. Expiry enforced in only one of them is not a half-fix, it is a live BYPASS
// DOOR: an expired credential simply uses the other entrance. So the predicate lives
// here, once, and both call sites consume this export rather than a transcription of
// it. Same discipline, and same reason, as src/mcp/token-queries.ts (mupot#684: a test
// that hand-copied the query validated the copy while production stayed broken).
//
// Rule for anything added here: both lookups must EXECUTE these exports. If you find
// yourself pasting the SQL fragment into a third place, the bug is the paste.

import type { Env } from '../types'

/** SQL fragment gating a token row on liveness. Bind: the `now` parameter index.
 *
 *  Two things are load-bearing and neither is stylistic:
 *
 *  1. `expires_at IS NULL` means NON-EXPIRING (the owner-gated exception, redesign D2).
 *     SQL three-valued logic drops NULL rows from any comparison, so without this arm
 *     every legitimately non-expiring credential would silently stop authenticating —
 *     a self-inflicted outage of exactly the standing agents this work exists to keep
 *     running.
 *
 *  2. `julianday()` on BOTH sides rather than a string compare. `member_tokens` already
 *     holds timestamps in TWO formats — verified live 2026-08-13: `2026-06-06 16:11:58`
 *     alongside `2026-06-09T02:51:30.844Z`. Lexicographically 'T' (0x54) sorts AFTER
 *     ' ' (0x20), so a plain `>` comparison between the two shapes yields the wrong
 *     answer for the same instant — and it fails OPEN or CLOSED depending purely on
 *     which format each row happens to carry. julianday() parses both and compares the
 *     actual instants. Do not "simplify" this to a string comparison.
 */
export const TOKEN_LIVE_PREDICATE = (nowParam: string): string =>
  `t.revoked_at IS NULL AND (t.expires_at IS NULL OR julianday(t.expires_at) > julianday(${nowParam}))`

/** Canonical `now` for the predicate above. Emitted in the same shape SQLite's own
 *  `datetime('now')` produces, so a value written by a migration and a value written by
 *  application code are the same shape — the format split noted above is a real defect
 *  in existing rows and this is where we stop widening it. */
export function nowSqlUtc(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

export const DEFAULT_TOKEN_EXPIRY_DAYS = 30

/** Calculate a standard SQLite-compatible UTC ISO timestamp given days in the future.
 *  Returns null if days is null or 0 (meaning non-expiring). */
export function calculateExpiryTimestamp(days: number | null | undefined = DEFAULT_TOKEN_EXPIRY_DAYS): string | null {
  if (days === null || days === undefined || days <= 0) return null
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** Check if a token is expiring within warningDays threshold (default 7 days). */
export function isTokenExpiringSoon(expiresAt: string | null | undefined, warningDays = 7): boolean {
  if (!expiresAt) return false
  const expTime = new Date(expiresAt.replace(' ', 'T') + (expiresAt.includes('Z') ? '' : 'Z')).getTime()
  if (isNaN(expTime)) return false
  const now = Date.now()
  const threshold = now + warningDays * 24 * 60 * 60 * 1000
  return expTime > now && expTime <= threshold
}

/** Stamp `last_used_at` for a successfully authenticated token hash.
 *
 *  BEST-EFFORT BY CONTRACT. This is the telemetry that makes credential cleanup
 *  possible at all — without it nothing distinguishes a live agent's token from an
 *  abandoned one, so the safe action is always "leave it" and the live set only grows
 *  (measured: 53 live tokens, 19 identities, nothing retired without a human).
 *
 *  It is NOT an authorization input, and it must never behave like one. A failed or
 *  slow write must not fail, delay, or alter an already-authenticated request — hence
 *  the swallowed rejection. Callers invoke it as `void touchTokenLastUsed(...)`. */
export async function touchTokenLastUsed(env: Env, tokenHash: string): Promise<void> {
  try {
    await env.DB.prepare(
      'UPDATE member_tokens SET last_used_at = ?1 WHERE token_hash = ?2 AND tenant = ?3',
    )
      .bind(nowSqlUtc(), tokenHash, env.TENANT_SLUG)
      .run()
  } catch {
    // Intentionally silent: see the contract above. Losing a usage stamp degrades a
    // future cleanup decision; failing the request degrades a live agent right now.
  }
}

export interface ExpiringTokenSweepResult {
  warned: number
  tokens: Array<{ id: string; agent_id: string | null; label: string; expires_at: string }>
}

/**
 * Sweep member_tokens for active credentials expiring within `warningDays` (default 7 days).
 * Emits a bus event or warning log for each expiring credential so seats/operators receive
 * proactive notification rather than silent drops.
 */
export async function sweepExpiringTokensWarning(
  env: Env,
  warningDays = 7,
): Promise<ExpiringTokenSweepResult> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, agent_id, label, expires_at
         FROM member_tokens
        WHERE tenant = ?1
          AND revoked_at IS NULL
          AND expires_at IS NOT NULL`,
    )
      .bind(env.TENANT_SLUG)
      .all<{ id: string; agent_id: string | null; label: string; expires_at: string }>()

    const candidates = rows.results ?? []
    const expiringSoon = candidates.filter((t) => isTokenExpiringSoon(t.expires_at, warningDays))

    if (expiringSoon.length > 0 && env.BUS?.send) {
      for (const t of expiringSoon) {
        await env.BUS.send({
          type: 'org.provisioned',
          tenant: env.TENANT_SLUG,
          ts: new Date().toISOString(),
          data: {
            kind: 'token_expiring_soon',
            token_id: t.id,
            agent_id: t.agent_id,
            label: t.label,
            expires_at: t.expires_at,
          },
        })
      }
    }

    return {
      warned: expiringSoon.length,
      tokens: expiringSoon,
    }
  } catch (error) {
    console.error('expiring tokens warning sweep failed', error)
    return { warned: 0, tokens: [] }
  }
}

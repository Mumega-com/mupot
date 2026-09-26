// mupot#1551 — exclusive-control predicate for identity-less member attach
// (Athena's DESIGN RULING, 2026-09-26, Option B; kasra-core issue "member-row
// squatting").
//
// A members row with no live human_login_identities row ("identity-less") is
// NOT the same thing as an unclaimed row. It can already be under someone
// else's control through a different credential class:
//
//   - a live, UNBOUND bearer token (member_tokens, agent_id IS NULL) — most
//     commonly the legacy public-accept tuple (label='workspace',
//     channel='workspace') minted by the JSON invite-accept door (cause 1 of
//     the issue: a squad-admin invites+accepts an arbitrary email onto their
//     own squad, holding a bearer for that row before the real owner ever
//     logs in);
//   - a bound Telegram chat (members.telegram_chat_id) — mupot#1411's IM
//     credential, also control of the row;
//   - a live human_login_identities row under a DIFFERENT (provider,
//     subject) than the one presenting right now — someone already
//     completed a real login and claimed this row.
//
// "Verified identity is not exclusive control" (Athena). This module owns the
// ONE predicate both identity-first attach paths must consult before
// treating a members row as safe to bind to a NEW human presenting a
// matching, IdP-verified email:
//   1. the ordinary login bootstrap (src/members/resolve-human-member.ts step
//      3, reached from registerWebSession, src/auth/index.ts), and
//   2. enterprise SSO auto-enrollment's resolver-miss fallback
//      (src/auth/sso.ts).
//
// A denial is its OWN tri-state member, never collapsed onto the same `null`
// a genuine not_found produces. Collapsing the two is exactly what let SSO's
// old raw fallback (`SELECT ... lower(email) ... LIMIT 1`, no checks at all)
// silently reuse a denied row instead of refusing it.
//
// Provisioning exception (Athena, preserved verbatim — do not widen it): the
// pot admin seed mints label='admin', channel='dashboard' in the SAME batch
// as the member row (src/pots/service.ts:743-745) — that is the one
// legitimate token-bearing email row this predicate must still allow
// through. The agent seed-seat row (label='seed-seat', channel='workspace')
// is not a candidate at all: its member row's email is NULL
// (src/pots/service.ts:748), so it can never match a normalized email lookup
// in the first place. No other token label/channel is exempted —
// "anything except workspace/workspace" is explicitly the widening Athena's
// ruling forbids. If a future audit finds another legitimate token-bearing
// email row shape, it must be inventoried and added here explicitly, never
// assumed.

import type { Env } from '../types'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'

export const PROVISIONING_EXEMPT_TOKEN_LABEL = 'admin'
export const PROVISIONING_EXEMPT_TOKEN_CHANNEL = 'dashboard'

export interface DecideIdentitylessAttachInput {
  tenant: string
  /** Already lower-cased + trimmed by the caller — this module never
   *  re-normalizes, so there is exactly one normalization rule to audit. */
  normalizedEmail: string
  /** The current login attempt's own join key, when it has one (absent for
   *  SSO auto-enroll, which never carries a provider_subject). Not consulted
   *  to widen eligibility: by construction, both callers only reach this
   *  predicate after their OWN identity-scoped lookup already missed on this
   *  exact (provider, subject), so any live identity found below is
   *  necessarily a different one already. Carried through purely so a future
   *  caller/audit has the full attempt shape without re-deriving it. */
  provider?: string | null
  subject?: string | null
  /**
   * Skip the "any live login identity" check (still enforces the bearer and
   * Telegram checks below). Set ONLY by a caller that never links a NEW
   * identity off this result — a pure resolve-or-reuse read.
   *
   * Why this exists (mupot#1266 P0-2, "write-once verified_email drift"): a
   * member can already hold a live identity whose OWN verified_email differs
   * from their members.email (an alias login, or an IdP email change). That
   * member is not identity-less — it is already legitimately claimed by a
   * real prior login — so denying a read-only lookup of their OWN primary
   * email as "competing control" would be a false positive, not a fix. The
   * ordinary Google-login ATTACH path (resolve-human-member.ts step 3,
   * registerWebSession) never sets this: attaching a brand-new
   * (provider, subject) to a row that already has a DIFFERENT live identity
   * is exactly the case Athena's ruling requires refusing. SSO's
   * resolver-miss fallback (src/auth/sso.ts) DOES set this — it never calls
   * linkLoginIdentity, so an already-identified row is safe to report back,
   * never a fresh claim.
   */
  ignoreLiveIdentity?: boolean
}

export type CompetingControlReason =
  | 'live_login_identity'
  | 'live_member_bearer'
  | 'telegram_bound'

export type DecideIdentitylessAttachResult =
  | { kind: 'eligible'; memberId: string; status: string }
  | { kind: 'denied_competing_control'; reason: CompetingControlReason }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }

/** Same D1/SQLite "table doesn't exist yet" wording matched by
 *  resolve-human-member.ts's isMissingHumanLoginIdentitiesTable. Kept as its
 *  own tiny copy here (one regex, one line) rather than an import, so this
 *  module and resolve-human-member.ts never form an import cycle — the
 *  resolver imports decideIdentitylessAttach FROM here. */
function isMissingHumanLoginIdentitiesTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /no such table:\s*human_login_identities/i.test(msg)
}

interface CandidateRow {
  id: string
  status: string
  telegram_chat_id: string | null
}

/**
 * decideIdentitylessAttach — the shared tri-state eligibility check.
 *
 * Looks up EXACTLY the members row(s) matching `normalizedEmail` (tenant
 * scoped) with no LIMIT — a case-insensitive collision returns `ambiguous`,
 * never an arbitrary pick. A unique candidate is `eligible` only when none of
 * the three competing-control checks above fire; the first one that does is
 * returned as the reason (checked cheapest-first: the candidate row's own
 * telegram_chat_id column needs no extra query, then the two extra lookups).
 *
 * Read-only: this function never writes. The actual attach (identity link)
 * still needs its own re-check at write time — see linkLoginIdentity's
 * `requireExclusiveControl`, which closes the race this function's read
 * cannot.
 */
export async function decideIdentitylessAttach(
  env: Env,
  input: DecideIdentitylessAttachInput,
): Promise<DecideIdentitylessAttachResult> {
  const { tenant, normalizedEmail } = input
  if (!normalizedEmail) return { kind: 'not_found' }

  const rows = await env.DB.prepare(
    `SELECT id, status, telegram_chat_id FROM members
      WHERE lower(email) = ?1 AND tenant = ?2`,
  )
    .bind(normalizedEmail, tenant)
    .all<CandidateRow>()
  const candidates = rows.results ?? []
  if (candidates.length === 0) return { kind: 'not_found' }
  if (candidates.length > 1) return { kind: 'ambiguous' }

  const candidate = candidates[0]

  // 1. Telegram bind — already have the column, no extra query.
  if (candidate.telegram_chat_id !== null) {
    return { kind: 'denied_competing_control', reason: 'telegram_bound' }
  }

  // 2. Any live login identity at all for this member (see the input doc
  //    comment for why no provider/subject exclusion is needed here) —
  //    skipped when the caller is a pure read that never attaches a new one
  //    (see `ignoreLiveIdentity`'s doc comment).
  if (!input.ignoreLiveIdentity) {
    let hasLiveIdentity = false
    try {
      const liveIdentity = await env.DB.prepare(
        `SELECT 1 AS present FROM human_login_identities
          WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL
          LIMIT 1`,
      )
        .bind(tenant, candidate.id)
        .first<{ present: number }>()
      hasLiveIdentity = liveIdentity !== null
    } catch (err) {
      if (!isMissingHumanLoginIdentitiesTable(err)) throw err
      // Not yet migrated onto this pot: nobody could have linked an identity
      // yet, so there is nothing live to find. Fall through, fail SAFE the
      // other direction (never silently treat a throw as "no identity" for
      // any OTHER error shape — only this exact, matched wording).
    }
    if (hasLiveIdentity) {
      return { kind: 'denied_competing_control', reason: 'live_login_identity' }
    }
  }

  // 3. Any live, UNBOUND (agent_id IS NULL) member bearer, excluding only the
  //    documented provisioning seed. Shared liveness predicate (revocation +
  //    expiry) — never `revoked_at IS NULL` alone.
  const liveBearer = await env.DB.prepare(
    `SELECT 1 AS present FROM member_tokens t
      WHERE t.tenant = ?1 AND t.member_id = ?2 AND t.agent_id IS NULL
        AND NOT (t.label = ?3 AND t.channel = ?4)
        AND ${TOKEN_LIVE_PREDICATE('?5')}
      LIMIT 1`,
  )
    .bind(
      tenant,
      candidate.id,
      PROVISIONING_EXEMPT_TOKEN_LABEL,
      PROVISIONING_EXEMPT_TOKEN_CHANNEL,
      nowSqlUtc(),
    )
    .first<{ present: number }>()
  if (liveBearer !== null) {
    return { kind: 'denied_competing_control', reason: 'live_member_bearer' }
  }

  return { kind: 'eligible', memberId: candidate.id, status: candidate.status }
}

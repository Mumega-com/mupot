// inbox-seat — resolve + apply the per-token inbox seat partition (mupot#1254, #1272, #1325).
//
// Pulled out of src/mcp/index.ts (mupot#1325 P0/P0 fix) so the MCP `inbox`/`inbox_lease`
// tools and the HTTP mirror (src/agents/inbox-routes.ts) share ONE rule instead of each
// carrying its own copy that can silently diverge. A standalone module (rather than
// importing mcp/index.ts directly from inbox-routes.ts) also avoids dragging that file's
// full import graph — and its test-mock surface — into the HTTP route's test suite.
//
// origin/main (pre-#1254) read the seat partition straight off a caller-supplied `seat`
// value — a caller holding ANY token for an agent could pass ANY other seat's label and
// read/lease/consume its mail. The fix binds the partition to the ONE seat identity a
// caller cannot forge: the live `member_tokens.label` row for the AUTHENTICATED token's
// own id (never the request body/query string). That label IS the seat name — migration
// 0139 spells it out verbatim ("member_tokens.label, i.e. the seat name") — set once at
// mint time: explicitly by the /enroll form (src/dashboard/enroll.ts, POST /enroll/mint)
// or mint_agent_token's own `label` arg, or implicitly (mint_agent_token defaults an
// unlabelled mint to the agent's own slug — src/mcp/provision.ts:563). A token minted
// before this feature, or never given an explicit seat, simply has label = '' (the
// column default) or = the agent's slug — either way a single, stable, server-controlled
// value, never a per-request claim.
//
// Two things this is explicitly NOT:
//   - the `x-mupot-seat` request header used elsewhere as a cosmetic enrollment hint — a
//     plain client-supplied value, exactly as forgeable as a query/body seat. Never treat
//     it as an authenticated seat.
//   - `runtime_seats` (migrations 0121+, src/flight-spine/seats.ts) — a DIFFERENT "seat"
//     concept (host/process assignment for the flight-spine scheduler), unrelated to
//     inbox mailbox partitioning. Do not conflate the two when reading migration history.

import type { Env } from '../types'

export interface InboxSeatError {
  ok: false
  status: 403
  error: 'seat_not_bound' | 'seat_mismatch'
  detail: string
}

export type InboxSeatResult = { ok: true; seat: string | undefined } | InboxSeatError

// A null return means "this token has no seat label bound," not "lookup failed open": on
// a DB error we return null too, which — same as an empty label — refuses any
// caller-supplied seat (seat_not_bound) rather than silently trusting it. The scoping
// feature fails closed; the unscoped (broadcast-only) read/lease untouched by this fix
// still works, exactly as it did before.
export async function resolveBoundSeat(env: Env, tokenId: string | null | undefined): Promise<string | null> {
  if (!tokenId || !env.DB) return null
  try {
    const row = await env.DB.prepare(
      `SELECT label FROM member_tokens WHERE id = ?1 AND tenant = ?2`,
    ).bind(tokenId, env.TENANT_SLUG).first<{ label: string | null }>()
    const label = row?.label?.trim()
    return label && label.length > 0 ? label : null
  } catch {
    return null
  }
}

// A bound token's seat is now authoritative: it applies EVEN WHEN the caller-supplied
// seat is omitted (this is what lets a seat-labelled token receive mail addressed to its
// own seat without every caller having to echo its own identity back at it). An explicit
// requested seat is accepted ONLY as a same-value compat echo; anything else is refused,
// never silently downgraded to the token's real seat or to unscoped.
export function resolveInboxSeatArg(
  requestedSeatRaw: string | undefined,
  boundSeat: string | null,
): InboxSeatResult {
  // mupot#1272 adversarial-gate P1, item 3: an empty/whitespace-only requested seat ('' or
  // ' ') is "no seat requested," matching the pre-fix normalization that lived in
  // readAgentInboxForReader/leaseAgentInbox (src/agents/messages.ts). Without this, a
  // caller passing seat: '' fell into the mismatch branch below (boundSeat, if any, is
  // never '') and got a spurious seat_mismatch instead of the unscoped read it got before.
  const requestedSeat = requestedSeatRaw !== undefined && requestedSeatRaw.trim().length === 0
    ? undefined
    : requestedSeatRaw
  if (requestedSeat !== undefined) {
    if (boundSeat === null) {
      return {
        ok: false,
        status: 403,
        error: 'seat_not_bound',
        detail: 'this token has no seat label bound; seat cannot be used until the token is minted with a seat label (see /enroll or mint_agent_token { label })',
      }
    }
    if (requestedSeat !== boundSeat) {
      return {
        ok: false,
        status: 403,
        error: 'seat_mismatch',
        detail: `this token is bound to seat "${boundSeat}"; seat must match it or be omitted`,
      }
    }
  }
  return { ok: true, seat: boundSeat ?? undefined }
}

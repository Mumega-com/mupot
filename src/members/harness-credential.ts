// mupot#1794 W4 — ONE definition of a harness-token credential session.
//
// THE CLASS THIS CLOSES: zero standing used to be derived from a SECOND lookup (harnesses) and
// enforced per door, so any door that forgot, or any lookup that failed, handed out the human's
// authority. Now:
//   * the credential's class lives on the token ROW (member_tokens.harness_kind, migration 0202), so
//     the one read that authenticates a bearer also says it is a harness credential;
//   * at every bearer door a token of directory/unbound SHAPE is either a flagged-on, harness-row-backed
//     harness credential (zero standing) or it is REFUSED — never a human session;
//   * invokeTool (src/mcp/index.ts) is the ONE tool-dispatch chokepoint: a harness session with no
//     applied seat handle may call only HARNESS_SESSION_ALLOWED_TOOLS.
//
// WHAT A HARNESS SESSION (no seat handle) MAY DO — exactly this, nothing else:
//   - tool `seat_select`   find-or-create the seat agent for a workspace key, receive a seat handle
//   - tool `boot_context`  read-only identity: who you are, the harness, the identity receipt, hints
//   - JSON-RPC `initialize`, `notifications/initialized`, `tools/list` (no tool runs)
// Everything else — every other tool (connect, bootstrap_self, reveal_credential_claim, recall,
// remember, ...), /actions/:tool, the legacy {tool,args} body, events/*, and the profile door — is
// refused with `harness_session_seat_required`. A session that presents a valid seat handle is the
// SEAT AGENT's session (no harnessCredential), capped at member and the human's own live rank.

import type { Env } from '../types'
import { loadHarnessForToken, seatAutoEnrollEnabled } from './harness'

/** The tools a harness-token session without an applied seat handle may call. */
export const HARNESS_SESSION_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['seat_select', 'boot_context'])

export const HARNESS_SESSION_SEAT_REQUIRED = 'harness_session_seat_required'
export const HARNESS_SESSION_SEAT_REQUIRED_MESSAGE =
  'This connection is a harness token: it can only call seat_select (to get a seat for this thread) and boot_context. '
  + 'Call seat_select, then send the returned seat_handle as the X-Mupot-Seat header (or _meta["mupot/seat"]) on every request.'

/** True for a context that must be confined to the harness allowlist. */
export function isHarnessCredentialSession(auth: { harnessCredential?: boolean }): boolean {
  return auth.harnessCredential === true
}

/** The columns of the ONE authenticating token read that decide the credential's class. */
export interface BearerTokenShape {
  member_id: string
  token_id: string
  channel?: string | null
  bound_agent_id: string | null
  harness_kind?: string | null
}

export type HarnessBearerDecision =
  | { kind: 'not_directory_unbound' }
  /** directory/unbound with NO harness_kind: not a harness credential. Main's behaviour is kept (a
   *  zero-capability directory session); no harness lookup is made, so none can fail open. */
  | { kind: 'plain_directory_unbound' }
  | { kind: 'refuse' }
  | { kind: 'harness'; harnessId: string }

/**
 * Decide what a presented bearer token is, from ITS OWN row. Fail closed:
 *   - not a directory/unbound token                         -> 'not_directory_unbound' (every legacy
 *     credential; this module changes nothing about it)
 *   - directory/unbound but no harness_kind                 -> 'plain_directory_unbound' (main's
 *     behaviour: a zero-capability directory session; never the human's capabilities)
 *   - harness_kind set but the flag is off                  -> 'refuse' (inert)
 *   - harness_kind set, the harness row lookup errors/absent -> 'refuse'
 *   - otherwise                                             -> 'harness' with the live harness id
 * Zero standing does NOT depend on the lookup: the caller clamps on `kind !== 'not_directory_unbound'`
 * before this resolves anything, and a refusal returns no session at all.
 */
export async function decideHarnessBearer(env: Env, t: BearerTokenShape): Promise<HarnessBearerDecision> {
  if (t.channel !== 'directory' || t.bound_agent_id) return { kind: 'not_directory_unbound' }
  if (t.harness_kind === null || t.harness_kind === undefined) return { kind: 'plain_directory_unbound' }
  if (!seatAutoEnrollEnabled(env)) return { kind: 'refuse' }
  try {
    const harness = await loadHarnessForToken(env, t.member_id, t.token_id)
    if (!harness) return { kind: 'refuse' }
    return { kind: 'harness', harnessId: harness.id }
  } catch {
    return { kind: 'refuse' }
  }
}

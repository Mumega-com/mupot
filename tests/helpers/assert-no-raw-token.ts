// mupot#1436 round 2 P1-C — the "no raw token leaked" assertion the original
// invite-landing-page test wrote (`bodyText).not.toMatch(/mupot_[0-9a-f]{64}/)`
// after reading a 302's EMPTY body) was vacuous: it could never fail, so it
// proved nothing about a redirect response that never had a body to leak
// into in the first place. This is the one real check, reused everywhere a
// route might leak a raw workspace token: every response header value
// (Location included — Headers#entries() already covers it), the status
// text, and the body — with an explicit, asserted count of how many times
// the token is ALLOWED to appear in the body (0 for a redirect/HTML page
// that must never carry one, exactly 1 for a JSON mint response that hands
// it back on purpose). Optionally also sweeps every value a fake KV/SESSIONS
// store recorded during the request.
//
// The regex shape must track mintRawToken() (src/members/service.ts):
// `mupot_` + 64 lowercase hex chars (32 random bytes).
import { expect } from 'vitest'

const RAW_TOKEN_RE = /mupot_[0-9a-f]{64}/
const RAW_TOKEN_RE_GLOBAL = /mupot_[0-9a-f]{64}/g

export interface AssertNoRawTokenOptions {
  /** How many raw-token occurrences the BODY is allowed to contain. Default 0
   *  (nothing should ever leak). A JSON mint response passes 1. */
  allowedInBody?: number
}

export async function assertNoRawToken(
  res: Response,
  kvStore?: ReadonlyMap<string, string>,
  options?: AssertNoRawTokenOptions,
): Promise<void> {
  const allowedInBody = options?.allowedInBody ?? 0

  expect(res.statusText, 'response statusText').not.toMatch(RAW_TOKEN_RE)

  for (const [name, value] of res.headers.entries()) {
    expect(value, `response header "${name}" leaked a raw token`).not.toMatch(RAW_TOKEN_RE)
  }

  // Clone so the caller can still read the body afterwards (e.g. to assert on
  // the parsed JSON) — Response bodies are single-read streams.
  const bodyText = await res.clone().text()
  const occurrences = bodyText.match(RAW_TOKEN_RE_GLOBAL) ?? []
  expect(occurrences.length, 'raw-token occurrences in response body').toBe(allowedInBody)

  if (kvStore) {
    for (const [key, value] of kvStore.entries()) {
      expect(value, `KV value at "${key}" leaked a raw token`).not.toMatch(RAW_TOKEN_RE)
    }
  }
}

// src/auth/fail-closed.ts — one definition of what happens when an auth lookup THROWS.
//
// WHY (mupot#1281). Every `/mcp` tools/call resolves auth through a chain with no try/catch
// anywhere — `src/index.ts`'s default `fetch` export contains zero `try {` blocks, and the
// D1 reads inside `resolveExternalToken`, `buildAuthContextFromProps`, `resolveMemberByToken`
// and `authenticateMember` are all bare `await env.DB.prepare(...)`. A transient D1
// exception therefore propagates uncaught to the platform, which renders it as a
// Cloudflare 1101 "worker threw exception" page.
//
// Measured 2026-09-03: `inbox` returned 1101 (ray a3579dba38cd7c81) at 20:48:34Z while
// seatlink logged plain HTTP 500 for two seats in the SAME second, recovering 8s later.
// Same underlying blip, two different error surfaces — the SSE route sits under Hono's
// default error handler, which converts the throw into a clean 500, and `/mcp` has no such
// boundary. One fault reading as two, because only one path had a net.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a failure to *evaluate* authentication is not
// permission. It is the absence of an answer, and the absence of an answer must never
// widen access. Every one of these lookups already returns `T | null`, and every caller
// already treats `null` as unauthenticated — so failing closed costs nothing and changes
// no success path. It only stops a database hiccup from becoming an authorization outcome.
//
// Kept as ONE helper rather than four inline try/catches deliberately. There are already
// three independent copies of the unguarded lookup pattern (issue #41's long-deferred
// dedupe), and the two that exist have already drifted in which error surface they
// produce. Four private catch blocks would drift the same way; one shared decision cannot.

/**
 * Run an authentication lookup so that a THROWN error resolves to `null`
 * (unauthenticated) rather than escaping as an unhandled exception.
 *
 * Deliberately does NOT catch-and-continue with a partial result: there is no safe
 * degraded answer to "who is this caller". Either the lookup completed, or we do not know,
 * and not knowing is a refusal.
 *
 * @param site  where this ran, for the log line — a 1101 gave us no stack, so the whole
 *              point of logging here is knowing WHICH lookup threw next time.
 */
/** Credential shapes that must never reach a log line. This runs on the authentication
 *  path, so the values in scope ARE secrets — and a D1 error message can echo the query
 *  and its bound parameters. Redacting by construction beats trusting that upstream error
 *  text happens to be clean, because the day it is not, the secret is in Workers Logs
 *  permanently and nobody notices.
 *
 *  Caught by its own test: the first version of this helper logged `err.message` verbatim
 *  and leaked a `mupot_` token straight through. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bmupot_[A-Za-z0-9_-]{6,}/gi,   // member/agent bearer keys
  /\bpot_(?:adm|agt)_[A-Za-z0-9_-]{6,}/gi, // pot admin / agent tokens
  /\bsk-[A-Za-z0-9_-]{8,}/gi,      // provider keys
  /\b[a-f0-9]{32,}\b/gi,           // token hashes and long hex digests
]

export function redactCredentials(text: string): string {
  let out = text
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

export async function authLookupOrNull<T>(
  site: string,
  lookup: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await lookup()
  } catch (err) {
    // console.error so it reaches Workers Logs. Never include the token, the hash, or the
    // row — this runs on the authentication path and the inputs are credentials.
    console.error('auth lookup failed — failing closed to unauthenticated', {
      site,
      error: redactCredentials(err instanceof Error ? err.message : String(err)),
    })
    return null
  }
}

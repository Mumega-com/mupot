# Email login — rollout runbook

mupot#1564/#1442. Hadi, 2026-09-26: "we only have Google login — a big stone in front
of onboarding." This is the normal-login door beside Google: an email address, a
one-time link OR a 6-digit code, no Google account required.

Code: `src/auth/email-login.ts` (attempt storage, rate limits, verification),
`src/auth/email-sender.ts` (pluggable sender), routes in `src/auth/index.ts`
(`POST /auth/email/start`, `GET /auth/email/verify`, `POST /auth/email/verify`).

## Turning it on

1. `npx wrangler secret put RESEND_API_KEY` — the Resend API key. **Same secret name**
   `workers/inkwell-api`'s own request-code sender uses (`src/routes/auth.ts`), so one
   Resend key can serve both workers if that's how the account is organized.
2. Set `RESEND_FROM_EMAIL` in `[vars]` (non-secret — a from-address, e.g.
   `"Mumega <login@mumega.com>"`). Same var name as inkwell-api's own sender, for the
   same reason.
3. Set `EMAIL_LOGIN_ENABLED = "true"` in `[vars]`.
4. `npx wrangler deploy`.

Until step 3, the routes 404 and the landing page's "Continue with email" form is
never rendered — the flag is the single kill switch, same posture as
`POT_SELF_SERVE_CHECKOUT_ENABLED` (`src/pots/checkout-flag.ts`).

If `EMAIL_LOGIN_ENABLED="true"` but `RESEND_API_KEY`/`RESEND_FROM_EMAIL` are missing
(and `EMAIL_PROVIDER` is not `"console"`): `POST /auth/email/start` still returns its
ordinary 200 (no account-existence oracle — see below) and logs one structured
`console.error` line; no email is ever sent. This is a silent-in-band misconfiguration,
not a crash — watch the Worker logs after flipping the flag.

## Local dev / tests

Set `EMAIL_PROVIDER = "console"` (or `LOCAL_TEST_AUTH = "1"`, which already gates
`/auth/dev-login` the same way) to use the console sender: it logs the sign-in link and
code instead of calling Resend. Never set either of these on a deployed pot.

## What it does NOT change

- Identity resolution is unchanged. A verified email login mints a session through the
  EXACT same `registerWebSession` → `resolveHumanMemberId` → `decideIdentitylessAttach`
  path Google's `/auth/callback` uses, with `provider: 'email'` and `subject:` the
  normalized email. Verifying control of the mailbox here **is** the IdP proof for
  mupot#1551's exclusive-control predicate — a human who can read a fresh, single-use,
  hashed-at-rest secret sent to an inbox has proven control of it, the same property
  Google's OAuth proves for a Google account. There is no second identity resolver.
- The pending-invite link contract (mupot#1436 A2) is unchanged and reused verbatim:
  accepting an invite plants the same `mupot_pending_invite` cookie + KV marker, and
  email verification re-runs the same `decidePendingInviteLink`/`linkAcceptedInviteIdentity`
  D1-authoritative check the Google callback runs, never trusting the cookie/KV alone.

## Threat model notes

- **No account-existence oracle.** `POST /auth/email/start` returns the identical `200`
  body whether the email is registered, unregistered, malformed, or rate-limited. A
  ~200ms response-time floor covers the KV-only branches (delivery itself is
  backgrounded via `waitUntil` and never adds latency to the response), so elapsed time
  is not a usable side channel for "was this address already at its rate-limit ceiling."
- **Rate limits, fail-closed.** 3 starts per email / 10 per IP, per 10-minute KV window.
  A KV read/write failure refuses (does not silently disable) the ceiling — same ruling
  Athena gave the enroll-mint limiter (PR #1254): a credential-issuing surface must not
  fail open during an outage.
- **Single-use, hashed at rest.** Only `sha256(token)`/`sha256(code)` are ever stored;
  the raw token/code exist only in the outbound email and the verifying request. Both
  are consumed with a delete-before-honoring read (matching
  `consumePendingInviteMarker`'s own discipline in `src/auth/pending-invite-link.ts`).
- **Code brute-force ceiling.** The 6-digit code's search space (1e6) is small enough
  that unlimited guesses would be practical inside the 10-minute window; a wrong code
  increments a per-attempt counter and the attempt is invalidated after 5 wrong guesses.
- **CSRF.** `/auth/email/*` runs the same `csrf()` (Origin-check) middleware every other
  cookie-relevant mount in this codebase applies (`dashboardApp`, `inviteApp`).

## Tests

`tests/email-login.test.ts` — start (rate limits, oracle-safety, flag gating), verify by
link and by code (wrong/expired/reused/exhausted), the full invite-accept → email-start →
verify happy path (identity linked with `provider='email'`, home squad, session), and an
email-login-first-then-invite case exercising mupot#1551's exclusive-control predicate
on a clean row.

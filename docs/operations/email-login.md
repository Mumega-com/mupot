# Email login — rollout runbook

mupot#1564/#1442. Hadi, 2026-09-26: "we only have Google login — a big stone in front
of onboarding." This is the normal-login door beside Google: an email address, a
one-time link OR a 6-digit code, no Google account required.

Code: `src/auth/email-login.ts` (attempt storage, rate limits, verification),
`src/auth/email-sender.ts` (pluggable sender), routes in `src/auth/index.ts`
(`POST /auth/email/start`, `GET /auth/email/verify` — renders a confirm page, touches
no database — `POST /auth/email/verify` — the only route that ever consumes a
token/code). Schema: `migrations/0174_email_login_attempts.sql`
(`email_login_attempts`, `email_login_rate_limits`).

## Turning it on

1. **Apply migration 0174 FIRST**, before deploying this code: `email_login_attempts`
   and `email_login_rate_limits` are the tables every route below reads/writes
   unconditionally once the flag is on. Safe to apply on every pot regardless of
   whether the flag is ever flipped (same convention as every migration since 0143).
2. `npx wrangler secret put RESEND_API_KEY` — the Resend API key. **Same secret name**
   `workers/inkwell-api`'s own request-code sender uses (`src/routes/auth.ts`), so one
   Resend key can serve both workers if that's how the account is organized.
3. Set `RESEND_FROM_EMAIL` in `[vars]` (non-secret — a from-address, e.g.
   `"Mumega <login@mumega.com>"`). Same var name as inkwell-api's own sender, for the
   same reason.
4. Set `EMAIL_LOGIN_ENABLED = "true"` in `[vars]`.
5. `npx wrangler deploy`.

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

**Updated 2026-09-26 (adversarial gate round 1, kasra-review + Athena, PR #1574): the
FIRST version of this door kept every counter and single-use marker in Cloudflare KV as
a read-compare-put sequence. KV has no compare-and-set. Proven, with real concurrent
requests against the real routes: 4 concurrent `/start` calls sent 4 emails past a
stated ceiling of 3; 2 concurrent link confirmations both minted a session; 6 concurrent
wrong-code guesses left the 5-guess cap never firing and the correct code still usable.
Everything below reflects the FIX (D1-backed atomic guards), not the original design —
do not read an earlier version of this section as still accurate.**

- **No account-existence oracle.** `POST /auth/email/start` returns the identical `200`
  body whether the email is registered, unregistered, malformed, or rate-limited. A
  ~200ms response-time floor covers the D1-only branches (delivery itself is
  backgrounded via `waitUntil` and never adds latency to the response), so elapsed time
  is not a usable side channel for "was this address already at its rate-limit ceiling."
- **Rate limits are ONE atomic D1 statement per check, not read-then-write.**
  `email_login_rate_limits` (migration 0174) is a fixed 10-minute-bucket row per
  `(tenant, scope, key)`; the check is a single
  `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ?` — SQLite
  skips the `UPDATE` (0 rows changed, no error) when the `WHERE` is false, so "was this
  key already at its ceiling" and "record this call against it" happen in the SAME
  statement. No second concurrent caller can ever observe the pre-increment count. 3
  starts per email / 10 per IP on `/start`; 30 per IP on `/verify` (added this round —
  `/verify` previously had NO per-IP ceiling at all). `cf-connecting-ip` ONLY feeds the
  IP key — `X-Forwarded-For` is never trusted (client-controllable), and an absent IP
  (local dev) still lands in its own shared `'unknown'` bucket, never skipped. A D1
  failure refuses (fails closed), same ruling Athena gave the enroll-mint limiter
  (PR #1254): a credential-issuing surface must not fail open during an outage.
- **Single-use, hashed at rest, ONE atomic consume.** Only `sha256(token)`/`sha256(code)`
  are ever stored (`email_login_attempts`, migration 0174); the raw token/code exist only
  in the outbound email and the verifying request. Consumption is
  `UPDATE email_login_attempts SET consumed_at = ? WHERE consumed_at IS NULL AND ...` —
  0 rows changed means replay/expired/invalid, by construction, never a prior read's word
  for it.
- **Code brute-force ceiling is atomic under concurrency.** The 6-digit code's search
  space (1e6) is small enough that unlimited guesses would be practical inside the
  10-minute window. Every guess (right or wrong) atomically increments a SHARED
  `code_attempts` counter (`UPDATE ... SET code_attempts = code_attempts + 1 WHERE
  code_attempts < 5 AND ...`); only the first 5 across ALL concurrent callers combined
  ever win a slot — not 5 per caller. A guess that wins a slot is then checked and, if
  correct, consumed via the same atomic pattern as the link.
- **GET never consumes (P1-2, this round).** The old design consumed the emailed link on
  a bare `GET` — a plain navigation, which both a login-CSRF (`<img
  src="…/verify?t=…&a=…">` on a page the victim's browser loads, signing the VICTIM into
  the ATTACKER's session) and a mail-scanner prefetch (M365 Safe Links etc., which issues
  real GETs against links in scanned mail) can trigger with zero human intent. `GET
  /auth/email/verify` now touches no database state at all — it renders a static confirm
  page whose own `POST` (csrf()-protected, same as every other cookie-relevant mount
  here) is the only thing that ever consumes.
- **Identity/authority separation (DEFECT CLASS B, round 1).** An ordinary (no-invite)
  email login refuses the entire login — no `users` row touched, no session minted —
  when the member row matching that email is already under someone else's exclusive
  control (a live Google/other identity, an unbound bearer, a Telegram bind —
  `decideIdentitylessAttach`, mupot#1551). Before this fix, `upsertUserByEmail` was a
  SECOND, email-keyed lookup into `users` that granted `users.role` (up to and including
  `'owner'`) regardless of whether the members-identity attach would even be allowed — a
  Google-linked owner's email could sign in as that same owner with no email identity
  ever linked. Email login also NEVER auto-mints the pot's first-ever owner
  (`allowBootstrapOwner=false`, always) — only Google's own `/callback` (the legitimate
  first-owner ceremony) can do that.
- **Identity/authority separation, round 2 (a THIRD table).** Round 1's gate only ever
  inspects the ONE `members` row `lower(email)` happens to match. Three more shapes
  reached `users.role` (or a wrong member's identity table) through a row that gate never
  looks at: (a) an org-owner-alias email whose OWN live identity is bound to a DIFFERENT
  member (`org_settings.owner_login_emails`); (b) a powerless duplicate `members` row
  (mupot#1162) sitting beside the real owner, whose identity's `verified_email` drifted
  (mupot#1266 P0-2) onto the duplicate's own literal email; (c) a legacy owner/admin
  `users` row with NO `members` row at all (mupot#1324) — `decideIdentitylessAttach`
  never even runs for it, so `not_found` reads as safe. Closed by two UNCONDITIONAL
  checks, run on BOTH the invite and no-invite branches, BEFORE either branch's own
  writes: (1) refuse if a LIVE, non-`'email'`-provider identity exists ANYWHERE in the
  tenant whose `verified_email` matches this email (independent of which `members` row
  any OTHER lookup would have found); (2) refuse if a `users` row for this email already
  exists with `role != 'member'`. A token/code already consumed at verify time is an
  accepted sunk cost; no session/cookie/user/identity row is ever written past either
  refusal.
- **Rate-limit ordering (P1, round 2).** `/start`'s per-IP and per-email checks now run
  SEQUENTIALLY, IP first — the email counter is touched ONLY when the IP itself is still
  under its own ceiling. Before this, both increments fired unconditionally in parallel,
  so an attacker whose IP had ALREADY exceeded its own ceiling could keep burning a FRESH
  victim email's separate 3-per-window budget on every further request from that same IP.
- **CSRF.** `/auth/email/*` runs the same `csrf()` (Origin-check) middleware every other
  cookie-relevant mount in this codebase applies (`dashboardApp`, `inviteApp`). Note:
  hono's `csrf()` only guards form-shaped content types
  (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) — the ones a
  real cross-site `<form>` can submit without a CORS preflight — which is exactly the
  shape every real caller here uses (the confirm page's own `<form>`, the code-entry
  form); a JSON POST is already blocked by the browser's own CORS preflight and is not
  separately re-checked.
- **Accepted simplification, stated plainly.** Rate-limit windows are fixed 10-minute
  buckets, not a sliding window — a caller at a bucket boundary can see up to 2x the
  stated ceiling across two adjacent buckets. This is a precision tradeoff, not a
  concurrency gap: the property this round's fix guarantees is atomicity (no caller can
  ever exceed the ceiling THROUGH a race), not exact sliding-window accounting.
- **Brute-force bound, stated numerically.** Per email per 10-minute window: at most 3
  `/start` calls, each producing one attempt capped at 5 code guesses — 15 guesses/window.
  Across a day (144 ten-minute windows): 144 × 15 = **~2,160 guesses/day** against a
  1-in-1,000,000 code space, before the fixed-window boundary doubling above is even
  counted (up to ~4,320/day worst case at window edges). This is the ceiling the design
  accepts, not a target to defend further this round — a follow-up may tighten it (e.g. a
  per-email daily cap) if it proves too generous in practice.
- **Not yet built (follow-up, not this round):** neither `email_login_attempts` nor
  `email_login_rate_limits` rows are ever swept/expired — they accumulate in D1
  indefinitely at whatever volume the door sees. Filed as a follow-up, not fixed here.

## Tests

`tests/email-login.test.ts` — start (rate limits, oracle-safety, flag gating), confirm by
link and by code (wrong/expired/reused/exhausted), the full invite-accept → email-start →
confirm happy path (identity linked with `provider='email'`, home squad, session), an
email-login-first case exercising mupot#1551's exclusive-control predicate on both a
clean row (eligible) and a competing-controlled row (denied — Telegram bind, unbound
bearer, and the exact Google-linked-owner adversarial repro), and a concurrency describe
block mirroring Athena's round-1 repros directly: 4 concurrent `/start` calls for one
email send at most 3; 2 concurrent confirms of the same link mint exactly one session; 6
concurrent wrong-code guesses exhaust the 5-guess cap so the correct code is refused too.

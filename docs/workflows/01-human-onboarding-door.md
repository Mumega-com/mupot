# Human onboarding door

Source: mupot#1436, #1438, #1458, #1504 (invite → Google → member + squad + **home**). Code
cited at `origin/main` `9b46799c`. Route mounts: `src/index.ts:95` (`/auth` → `authApp`),
`:108` (`/members` → `membersApp`), `:240` (`/invite` → `inviteApp`, mounted ahead of the
dashboard catch-all so it bypasses `dashboardApp`'s auth/capability middleware).

## Trigger

An org-admin (or department-admin on their own department) sends `POST /invites`
(`src/members/index.ts:645`, gated `parseInvite` → `authorizeInvite` →
`requireCapability(inviteScope,'admin')`). Body shapes: legacy (`email` + optional
`department_id`), plain-squad (`email` + `squad_id`, #1458), or project/pairing (Telegram
door, a separate flow). The invite row is inserted at `src/members/index.ts:688`.

## Actor(s)

The org-admin (inviter), the invitee (a new human, in a browser), the mupot backend
(D1/KV), and Google OAuth as the identity provider. No agent is involved in this human-plane
path.

## Tool/route sequence

1. `POST /invites` (`src/members/index.ts:645-696`) → INSERT `invites` row
   (`id, email, department_id, squad_id, capability, invited_by, created_at`).
2. The admin sees a copyable link on `/admin/members`
   (`src/dashboard/index.ts:6356-6374`, built client-side from the create response).
3. `GET /invite/:id` (`src/dashboard/invite.ts:245-257`, via `loadInviteLanding`,
   `:87-134`) reads the `invites` row and renders one of: not-found / already-used /
   telegram-only / ready-to-accept.
4. `POST /invite/:id` (`src/dashboard/invite.ts:263-370`) calls `acceptInvite(env, id,
   displayName, { mintToken: false })` — the same write path the JSON API uses
   (`POST /invites/:id/accept`, `src/members/index.ts:243-395,403`). Atomic
   (`env.DB.batch`): claim invite via a single-use `UPDATE ... WHERE accepted_at IS NULL`
   (`:311`) → INSERT `members` (`:324`) → INSERT `capabilities` (`:335`, scope_type
   squad/department/org — this row IS the squad-membership grant) → (web path skips
   `member_tokens`) → UPDATE `invites.member_id` (`:353`).
5. On success: plants KV `pending_invite_link:<id>` plus an `HttpOnly` cookie
   `mupot_pending_invite`, sets both (`src/dashboard/invite.ts:~351-369`).
6. **(mupot#1504, adversarial round 1 P2-a repositioning)** Immediately AFTER the marker
   + cookie above — deliberately not before — the same handler calls
   `provisionHomeForMember(c.env, result.value.member_id, 'web').catch(...)`
   (`src/dashboard/invite.ts:392`, function at `src/members/service.ts:1232`) — the
   channel-agnostic home-on-first-contact writer (renamed from the IM-only
   `provisionHomeOnFirstContact`). Idempotent (a read-only `getMemberHomeSquad` short
   circuits if a home already exists), never throws internally (every step, including its
   own dynamic import, is wrapped and logged — `console.error` for a genuine lookup/create
   failure, `console.warn` for a failed-but-recovered receipt write), and the call site's
   own `.catch` is defense in depth on top of that. Ordered AFTER the marker/cookie so a
   provisioning failure can only ever cost the member their home — never their one path
   back to linking Google (see the function's own doc comment for the reasoning). Unless
   the member is already homed (the short circuit above), it calls `createHomeForMember`
   (`src/org/service.ts`, unchanged) and writes a `member_home_provisioning_receipts` row
   with `channel='web'` and whatever disposition `createHomeForMember` returned
   (`'created'` normally; `'existing'` only under a genuine concurrent race with another
   channel — see "Receipt(s) written" below) — see workflow 8 for the home-squad isolation
   invariant this row's target squad is subject to.
7. `GET /auth/login` (`src/auth/index.ts:472-502`) binds the pending-invite cookie into the
   OAuth `state` (`:482-490`), redirects to Google (`GOOGLE_AUTH`, `:419`).
8. `GET /auth/callback` (`src/auth/index.ts:537-690`) exchanges the code, fetches the Google
   userinfo (`:592-611`), then does link-only invite consumption via
   `decidePendingInviteLink`/`linkAcceptedInviteIdentity` (`:638-677`, logic in
   `src/auth/pending-invite-link.ts:140-193`) → `linkLoginIdentity` writes
   `human_login_identities` (`src/auth/login-identity.ts:86-145`). Falls through to
   `upsertUserByEmail`/`mintSession` (`:683-688`) for the ordinary `users` row regardless.
   The callback does NOT touch home provisioning — that already happened at step 6,
   before the human ever reaches Google, and is independent of whether the callback ever
   runs at all (a member who accepts but never completes Google login still has a home).
9. Later session loads resolve `auth.memberId` identity-first via `resolveHumanMemberId`
   (`src/members/resolve-human-member.ts:65-140`, called from `src/auth/index.ts:1429`),
   preferring a live `human_login_identities` row over email.

**Third caller (not shown as a numbered step above — a separate route, not part of this
sequence): `POST /invites/:id/accept`** (`src/members/index.ts`, the JSON API accept route
used by CLI/non-browser callers) calls the SAME `provisionHomeForMember(...)`, `channel='web'`,
right after its own `acceptInvite` success and before returning the raw token — see "Receipt(s)
written" and "Known gaps" below.

**Note on "squad" vs. the MCP tools of the same name**: squad membership in this flow is the
`capabilities` INSERT in step 4 — it is a **human-plane** write. The MCP tools
`create_squad` (`src/mcp/provision.ts:364`) and `squad_member_add`
(`src/mcp/provision.ts:2608`) write the separate **agent-plane** `memberships` table and
require an agent id, not a member id (confirmed `:2618-2645`) — they are not part of this
flow.

## Human gate

- Invite id is a UUID capability-bearing secret, consumed exactly once via a conditional
  `UPDATE ... WHERE accepted_at IS NULL` (`src/members/index.ts:310-319`) — a replay gets 409.
- Google login requires `email_verified === true` (`src/auth/index.ts:609-611`).
- The callback is link-only: it requires the D1 invite's own `accepted_at` + `member_id`
  (never trusting the KV pointer alone) plus case-normalized email equality between the
  invite and the verified IdP email (`decidePendingInviteLink`,
  `src/auth/pending-invite-link.ts:140-173`); the OAuth `state`↔cookie binding prevents
  CSRF/foreign-marker linking (`:150-152`).
- `linkLoginIdentity` refuses to silently reassign an identity already bound to a different
  member (`src/auth/login-identity.ts:101-109`).

## Receipt(s) written

- `invites` (`migrations/0002_members.sql:40-46`, widened by `0154`/`0156`): `id, email,
  department_id, project_id, squad_id, pairing_hash, pairing_expires_at, capability,
  invited_by, accepted_at, created_at, member_id`.
- `members` (`0002:6-12`): `id, email, display_name, telegram_chat_id, status, created_at,
  tenant`.
- `capabilities` (`0002:29-37`): `id, member_id, scope_type, scope_id, capability`.
- `human_login_identities` (`migrations/0143`): `id, tenant, provider, provider_subject,
  verified_email, member_id, linked_by_member_id, created_at, revoked_at`.
- `member_tokens`: only for the JSON API path, never the web path.
- **(mupot#1504)** `squads` + `capabilities` (`kind='home'` squad row + the member's own
  `admin` grant on it, `src/org/service.ts`'s `createHomeForMember`, unchanged by this
  work) and `member_home_provisioning_receipts` (`migrations/0161` — LIVE in production
  since 2026-09-21 23:00Z — widened by `0165` to admit `channel IN ('web','im','telegram')`;
  `'telegram'` deliberately KEPT, not relabeled, so the migration and the code deploy that
  renames the IM literal to `'im'` can land in either order without either one silently
  losing receipts — see `0165`'s own header for the full reasoning). Written whenever
  `createHomeForMember` returns `ok:true` — `disposition='created'` (this call actually
  inserted the squad + capability rows) or `disposition='existing'` (this call found a home
  already there via `createHomeForMember`'s own lookup/race-recovery — a DIFFERENT, rarer
  path than the ordinary already-homed short circuit one level up, which returns before
  `createHomeForMember` is ever called and writes no receipt at all). A genuine CONCURRENT
  race between two channels (e.g. a web accept and an IM join landing at the same instant)
  can therefore produce TWO receipt rows for the SAME home — one `'created'`, one
  `'existing'` — while the home itself and its capability grant stay singular. **Athena's
  ruling (adversarial round 1, P2-b, 2026-09-22): this over-recording is ACCEPTED, not a
  bug** — the ledger records provisioning attempts that reached a real outcome, not a 1:1
  mapping to homes; it is deliberately not gated on disposition and not serialized (this
  Worker has no cheap serialization primitive across concurrent requests). A provisioning
  FAILURE writes nothing, in every case.

## What the person sees

From `src/dashboard/invite.ts`: "Invite not found" (`:197-201`); "This invite has already
been used… If this was you, sign in instead." (`:204-209`); "This invite is redeemed in
Telegram" (`:211-217`); "You've been invited to `<org>`" plus a name form (`:219-231`);
field errors "Enter your name to continue." / "Enter a name up to 120 characters long." /
"An account already exists for this email. Sign in instead." (`:281-306`).

Mismatch page after a Google login that doesn't match the invite email
(`src/auth/pending-invite-link.ts:204-249`): "This invite is for a different account… Sign in
with the account that received this invite…" (the org/squad is named, the email itself is
never echoed).

No-access landing for a logged-in user with no capability
(`src/dashboard/index.ts:4663-4668`): "Signed in as `<email>`. No access in this org yet.
Ask an admin for an invite link."

## Tests that pin it

`tests/invite-landing-page.test.ts`, `tests/accept-invite-direct.test.ts`,
`tests/admin-members-invite-link.test.ts`, `tests/dashboard-no-access-page.test.ts`,
`tests/plain-squad-invite-create.test.ts`, `tests/plain-squad-invite-accept.test.ts`,
`tests/invite-login-link.test.ts` (Google callback + link-only logic),
`tests/home-provisioning-web-accept.test.ts` (mupot#1504, updated for the adversarial
round-1/round-2 gate: web accept → home + one `channel='web'` receipt; the JSON API accept
route ALSO provisions a home, `channel='web'`; a later Telegram bind-existing-member join for
the same member is idempotent — no second home, no second receipt; a genuinely CONCURRENT
web+im provisioning race converges on ONE home + ONE capability grant but TWO receipt rows
(`'created'` + `'existing'`) — Athena-accepted over-recording, asserted explicitly rather than
silently allowed; a call that reaches a `disposition='existing'` outcome from inside
`provisionHomeForMember` — not merely the already-homed short-circuit — DOES write a receipt
(this is the case the concurrent test exercises); an unknown-member provisioning failure never
throws and writes zero receipts; direct `channel` value coverage for `'web'`/`'im'`/`'telegram'`
including a CHECK-constraint refusal test for an unrecognized channel),
`tests/home-provisioning-call-site-safety.test.ts` (adversarial round 1, P2-a: with
`provisionHomeForMember` itself mocked to reject, the web accept handler still 302s with the
pending-invite KV marker and cookie set; the JSON API accept route still 201s with its raw
token; the IM join reply still confirms the join — all three call sites' own `.catch`
verified independently of the function's internal never-throws guarantee), and
`tests/journey-new-member.test.ts` (full
walk: admin creates squad → invites → invitee accepts → Google sign-in links identity → MCP
OAuth consent seats an agent → task flow — steps 1-12; predates #1504 and still does not
itself assert a home squad, though the web accept step it drives now provisions one as a
side effect).

## Known gaps

- **(FIXED by mupot#1504)** Home squad is now wired into this flow — see steps 5-6 above
  and the new `provisionHomeForMember` receipt row, called from THREE places: the browser
  web door (`src/dashboard/invite.ts`), the JSON API accept route
  (`src/members/index.ts`'s `POST /invites/:id/accept`), and IM's `handleImMessage` 'join'
  case (`src/im/index.ts`, unchanged from before #1504). The catalog's original framing
  ("invite → Google → member + squad + **home**") previously did not match shipped code:
  `createHomeForMember` (`src/org/service.ts`) was invoked only from the Telegram/Hermes
  first-contact handler. Issue #1472 built the *isolation* invariant for homes (no standing
  org/department grant reaches `kind='home'`, see the "home squads and admin-in by receipt"
  workflow doc); #1504 added the missing web-door and JSON-API-door callers (the latter
  added in the adversarial gate's round 2, after round 1 first shipped with only two).
  Residual: `member_home_provisioning_receipts` has no FK to `members`/`squads`
  (deliberate, matching 0086/0115/0157 — a retirement must never cascade-erase the audit
  row).
- #1436: config-flag `onboarding_doors` for tenant `mumega` was still zero rows as of
  2026-09-21 (tracked as **#1456**); the live end-to-end walk with a real second Google
  account (**#1442**) was still pending as of that comment.
- #1458: web project-bind (accepting a project-scoped invite on the web, vs. squad/legacy) is
  explicitly out of scope, filed as **#1459**. The plain-squad producer (A3) doubles
  reachability of the still-open squad-owner-to-owner escalation issues **#1416**/**#1417**
  (the ceiling predicate itself is unchanged by this work).
- From #1472's own follow-ups (see the home-squads workflow doc for detail): web-session
  elevation-to-home has no schema support yet, and several `resolveAccessibleSquadIds`
  consumers lack dedicated home-exclusion tests.
- A migration-numbering collision is on record: `0156` in #1436's PR collided with an
  unrelated open PR's own `0156` — resolved by whichever merged second (a documented
  convention, not a defect).

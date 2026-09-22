# Human onboarding door

Source: mupot#1436, #1438, #1458 (invite → Google → member + squad). Code cited at
`origin/main` `3c706069`. Route mounts: `src/index.ts:95` (`/auth` → `authApp`), `:108`
(`/members` → `membersApp`), `:240` (`/invite` → `inviteApp`, mounted ahead of the dashboard
catch-all so it bypasses `dashboardApp`'s auth/capability middleware).

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
   `mupot_pending_invite`, redirects to `/auth/login` (`src/dashboard/invite.ts:351-369`).
6. `GET /auth/login` (`src/auth/index.ts:472-502`) binds the pending-invite cookie into the
   OAuth `state` (`:482-490`), redirects to Google (`GOOGLE_AUTH`, `:419`).
7. `GET /auth/callback` (`src/auth/index.ts:537-690`) exchanges the code, fetches the Google
   userinfo (`:592-611`), then does link-only invite consumption via
   `decidePendingInviteLink`/`linkAcceptedInviteIdentity` (`:638-677`, logic in
   `src/auth/pending-invite-link.ts:140-193`) → `linkLoginIdentity` writes
   `human_login_identities` (`src/auth/login-identity.ts:86-145`). Falls through to
   `upsertUserByEmail`/`mintSession` (`:683-688`) for the ordinary `users` row regardless.
8. Later session loads resolve `auth.memberId` identity-first via `resolveHumanMemberId`
   (`src/members/resolve-human-member.ts:65-140`, called from `src/auth/index.ts:1429`),
   preferring a live `human_login_identities` row over email.

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
`tests/invite-login-link.test.ts` (Google callback + link-only logic), and
`tests/journey-new-member.test.ts` (full walk: admin creates squad → invites → invitee
accepts → Google sign-in links identity → MCP OAuth consent seats an agent → task flow —
steps 1-12, no home-squad step).

## Known gaps

- **Home squad is not wired into this flow.** The catalog's framing ("invite → Google →
  member + squad + **home**") does not match shipped code: `createHomeForMember`
  (`src/org/service.ts`) is invoked only from the Telegram/Hermes first-contact handler
  (`src/im/index.ts:420`, `provisionHomeOnFirstContact`) — there is no call site anywhere in
  the web invite/Google-login path, and `journey-new-member.test.ts`'s full web-onboarding
  walk never creates or asserts a home squad. Issue #1472 built the *isolation* invariant for
  homes (no standing org/department grant reaches `kind='home'`, see the
  "home squads and admin-in by receipt" workflow doc) but did not add a caller from this door.
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

# Human presence for decisions that widen authority

A human decision that **widens** what an agent, a chat, or a member acting for one may do must carry a proof of human presence that a
program driving the human's browser cannot produce. A dashboard web session, a fresh sign-in and a Cloudflare Access login are all
things such a program holds, so none of them is that proof.

## What counts as proof

(a) A WebAuthn assertion with **user verification required**, verified server-side on the secure host by the same verifier the secure
moments use (`src/secure-moments/webauthn.ts`), whose challenge is bound to *this exact decision*: the presence grant id plus a sha256 of
the decision's canonical parameters. The challenge is single use and lives five minutes.

(b) A decision that arrives through the existing Telegram human-origin channel from the member's bound private chat (`src/im`,
`src/approval-bot`, the harness-attested `human_origin` on `task_verdict`). That channel is a different device and is unchanged.

Decisions that **reduce** authority (deny, revoke, hold, detach, stop, clear, lower a level) never call into this module and stay
session-only. Nothing here makes it harder to stop something.

## Mechanism

`src/approvals/human-presence.ts` owns the rule, the grant lifecycle (`presence_grants`, migration 0261) and the policy floor
`approval.human-presence-required` (same value at every level; see the TODO for the registry). `src/approvals/gate.ts` is the one call a
route makes after its own authorisation checks and before its write:

1. no `?presence_grant=` -> nothing is written; a pending grant is filed for exactly this decision and the caller gets 403 with the
   secure-host passkey link;
2. the member taps the passkey on `/m/presence/<id>/<token>`; the assertion satisfies the grant (one guarded UPDATE);
3. the decision is repeated with the grant (`/presence/<id>` on the dashboard applies it); the route consumes the grant in one guarded
   UPDATE that re-states member, kind, subject, parameter digest, expiry and that the passkey and its login identity are still live.

It fails **closed**: with secure moments off, or no passkey enrolled, a widening decision is refused with the reason, never allowed.

## Inventory (kind -> route)

| kind | route |
|---|---|
| `claim_confirm` | `POST /claim/:code` |
| `claim_own` | `POST /agents/:id/claim` |
| `seat_attach` | `POST /connections/attach` |
| (admission approve) | `POST /connections/admissions/:id/approve` hands back the existing `seat_admit` passkey page; it no longer decides |
| `seat_release` | `POST /connections/seats/:id/release` |
| `seat_return_from_held` | `POST /connections/seats/:id/return` when the seat is held |
| `designation_allow` | `POST /agents/:id/designation` action=allow |
| `agent_owner_set` | `POST /agents/:id/owner` action=set\|me |
| `agent_access_set` | `POST /agents/:id/access` when the level rises or the agent is moved out of its home |
| `squad_agent_join` | `POST /squads/:id/agents/join` |
| `operator_delegate` | `POST /operators/delegate` |
| `member_capability_grant` | `POST /api/members/:id/capabilities` action=grant, from a web-session cookie |
| `task_verdict_approve` | `POST /api/tasks/:id/verdict` verdict=approved, from a web-session cookie |
| `agent_token_mint` | `POST /admin/agent-token/mint` (the show-once token page is the Apply result) |
| `scoped_key_mint` | `POST /admin/keys/mint` |
| `seat_key_mint` | `POST /enroll/mint` |
| `member_token_mint` | `POST /api/members/:id/tokens`, from a web-session cookie (the token is shown once on the return page) |
| `elevation_approve` | `POST /auth/elevation/requests/:id/decide` decision=approve |
| `access_seed_approve`, `access_elevation_approve` | `POST /approve/seed/:id`, `POST /approve/elevation/:id` on the Cloudflare Access page |
| `passkey_enrol` | `POST /account/passkey/enrol` once the member already holds a passkey |

Squad-join approvals, seed approvals, elevation approvals and credential provide/deny already go through `/m/:id/:token` (passkey).

## Known limits

* The **first** passkey of a member rests on the real, freshly re-authenticated session (there is nothing else to rest on). Every later
  one needs a passkey the member already holds.
* Bearer-token callers of the HTTP API (CLI, automation) are a different credential and are not asked for a passkey; the rule applies to
  web-session cookies.

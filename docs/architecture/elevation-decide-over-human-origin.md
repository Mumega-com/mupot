# Deciding an elevation request without the dashboard

An agent that needs temporary, human-approved authority files a request
(`request_elevation`). A human org admin can decide it in two ways:

1. **Dashboard** (unchanged): a signed-in web session approves or denies; the grant is
   bound to that web session and ends when the session ends.
2. **Through their own agent over chat** (`elevation_decide`): the human types one plain
   message to the agent they own; the agent's harness stamps that message as
   `human_origin`; the decision is written **as the human**.

Both go through one function, `decideElevationRequest` (`src/auth/elevation.ts`). The chat
door is a strictly narrower entrance to it, never a relaxation.

## Why a bearer token alone is not enough

A bearer token (including OAuth connector sessions and IM/dashboard-channel tokens)
proves a credential, not a present human. An agent harness can hold such a token. The
presence proof used here is the same one `task_verdict` uses: a message the harness
stamped from a private chat the member is already bound to, which the server re-checks
(freshness, replay, binding, ownership) rather than trusting.

## Conjuncts (all re-checked per call)

- The caller is an agent that has an owner (`agents.owner_member_id`); an agent with no
  `human_origin` is refused; a non-agent caller is refused (use the dashboard).
- The origin is a private-chat, fresh (10 minutes), unreplayed message; one message
  decides at most one thing (the reservation key is shared with `task_verdict`).
- The owner is active and **already** bound to that chat. This door never first-binds.
- The text names the request (full id or the first 8+ hex characters) and contains
  exactly one plain, unnegated `approve` or `deny`, equal to the call's `decision`.
- The owner holds **org-scope admin** by capability rows. The requesting agent can never
  decide its own request, and the owner cannot be the request's own member.
- Per-member rate window.
- `actions: []` is an error, never "all requested".

## What may be approved over chat

Approve is limited to an explicit allowlist (`ORIGIN_DECIDABLE_ACTIONS`):
`project_lifecycle`, `workspace_project`, `routine_policy`, `project_status`.
Every step-up action (`manage_access`, `deploy`, `migrate`, `secrets`, `register_key`,
`mint_token`, `routine_archive`) and `home_access` stay dashboard-only. **Deny is always
allowed.** The caller may narrow a mixed request to its allowlisted subset.

## One atomic decision

The decision is one D1 batch anchored on the request's status flip: reservation,
guarded flip, origin receipt, grants, audit row. Every guard (request still pending and
unexpired, relay is not the requester, relay owned by the decider, decider active and
chat-bound, org admin capability row present, requesting session not revoked,
reservation landed) is also re-asserted in SQL on the flip. If the flip does not land,
nothing else does.

## Grants without a web session

`elevation_grants` binds to exactly one anchor (`approved_via`): a web session, or an
append-only `elevation_origin_receipts` row. At **use**, an origin grant re-verifies the
whole decision: the receipt is an approve naming this request and approver, the request
still reads approved-via-that-receipt, the approver is still active, still bound to the
same chat and still org admin, and the relaying agent is still owned by the approver.
Any change ends the grant on the next call.

## What the human's agent sees

`elevation_status {pending_for_owner: true}` lists what the agent's owner could decide.
The authority filter runs **before** the limit (a flood of undecidable requests cannot
hide a decidable one), and `truncated` says when more exist. The agent-authored `reason`
is returned in a separate `agent_authored` object marked `untrusted`; the id the human
must echo appears only in the structured `request` object.

## Operational notes

- Migration `0210` rebuilds `elevation_grants` (copy to a side table, drop, recreate,
  re-insert) under `PRAGMA defer_foreign_keys`. It is tested as one transaction with
  foreign keys enforced on a populated database; rehearse on a staging D1 before applying.
- `elevation_requests` reads select the new columns, so the migration must be applied
  before the code that reads them is deployed.

# Approval bot ("/muapprove")

A dedicated Telegram bot, owned by the worker, that carries an agent's `request_elevation` to the deciding human as one
message with **Approve** and **Deny** buttons. No keys, no curl, no website. OFF unless `APPROVAL_BOT_TOKEN` is set; with it
unset `request_elevation` behaves exactly as before (Mini App button, `approve_url`).

It is a **dedicated** bot. It is not the notification bot (`TELEGRAM_BOT_TOKEN`), not the Mini App bot, and not the
Hermes / IM decision bot (KayHermes): config refuses a shared token or a shared webhook secret.

## Flow

1. Agent: `request_elevation { actions, scope_type, scope_id, duration_minutes, reason, recommendation? }`.
2. The worker picks the one deciding human (same rule as the Mini App delivery: the agent's owner column, else the org's
   approvals member, else the single reachable human owner/admin) and, if that member has a bound private Telegram chat
   (`members.telegram_chat_id`) and may decide the request on its scope, sends ONE message from the bot: agent, exact action
   and scope, duration, the agent's reason and recommendation (quoted, labelled unverified, plain text), buttons, and the
   fallback `/muapprove <id>` / `/mudeny <id>`. The reply carries `telegram: "sent"`.
3. A tap or command goes to `POST /im/approve/webhook`. It decides only when ALL hold: webhook secret matches; private chat
   whose id equals the sender; the sender is the bound telegram account of an active human; the id names a request this bot
   offered to THAT member in THAT chat; the request is pending and inside its 10-minute window; the member may decide it and
   is not the requester. Then it approves or denies through the shared decision core (`decideElevation`), recorded with
   `decided_by_member_id = member`, `decided_via = 'approval_bot'`, a `mutation_audit_entries` receipt (handler
   `approval_bot`), and the human gets the outcome in the chat. One guarded UPDATE decides: replays and double taps lose.
4. `/murevoke` ends every live approval the member gave; `/murevoke <id>` one request's. Expiry ends a grant at its duration.

## What the bot may carry

Only `APPROVAL_BOT_ACTIONS` (`src/approval-bot/policy.ts`): reversible, non-minting actions. A tap is weaker than a passkey,
so token mint, installer windows, irreversible acts, home access and anything from an attached chat keep their stronger
channel; the bot is never offered for a request that names one of them and refuses to approve it even if offered.

## Sudo: one owner action, as you

Four owner-only tools refuse every agent. With a live approval that names exactly the tool, an agent makes ONE call of it,
run as the approving human (the tool sees the human's live standing; the agent is recorded as executor):

| action | tool | covers |
|---|---|---|
| `action:sudo_squad_member_add` | `squad_member_add` | add one agent to a squad as observer/member; never lead/admin, never demote, never the requesting agent |
| `action:sudo_squad_dyad_pin` | `update_squad` | a call with only `squad`, `dyad_agent_a`, `dyad_agent_b` (and `reason`): pin or clear the review pair |
| `action:sudo_grant_gate_capability` | `grant_gate_capability` | one `gate:<owner>` grant, org scope; never to the requesting agent or its member |
| `action:sudo_seat_event_grant` | `seat_event_grant` (new MCP twin of `POST /api/fleet/events/grants`) | let one host receive one agent's seat events |

Rules: requested alone, org or squad scope (squad for the two squad tools), 60 minutes at most. Every call re-derives the
grant live (agent session, expiry, revocation, approver's current authority incl. the owner's role plane, approver's session).
Single use: a guarded insert claims the grant; a refused call frees the claim; a success revokes the grant
(`revoke_reason = owner_sudo_spent`) and a fresh approval in the same session renews it. `/murevoke` and expiry end it first.
Receipts: `elevation_usage_log` (grant, executor session), `mutation_audit_entries` (handler `owner_sudo`, principal = agent,
member = authority) and, for squad membership, `membership_receipts.actor_member_id = human`, `actor_bound_agent_id = agent`.
Not in scope: money, token mint, identity mint, installer windows (they keep their own rules and stronger channels).

## Setup (one time, by the owner)

1. In Telegram, message `@BotFather`: `/newbot`, choose a display name and a username ending in `bot`. Keep the token.
2. Set the secrets `APPROVAL_BOT_TOKEN` and `APPROVAL_BOT_WEBHOOK_SECRET` (a random 32+ character string of `A-Za-z0-9_-`) and
   the var `APPROVAL_BOT_USERNAME`. These names are worker-owned, so the secret_env request flow refuses them by design
   (`src/secret-env/env-reviewed-names.ts`); use `npx wrangler secret put <NAME>` or the Cloudflare dashboard.
3. Point Telegram at the worker:
   `curl -s https://api.telegram.org/bot<TOKEN>/setWebhook -d url=https://<worker-host>/im/approve/webhook -d secret_token=<WEBHOOK_SECRET> -d 'allowed_updates=["message","callback_query"]'`
4. Open the bot once and press Start (a bot cannot message a chat that never started it). The member's Telegram must already
   be connected under My Account (Connect Telegram).

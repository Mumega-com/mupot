# Hermes connector

Hermes is the **mouth & ears** of the network: it relays IM (Telegram) users into
your pot and carries the pot's replies back out. A person who lives in chat is a
first-class network node — their Telegram `chat_id` maps to a **Member** and that
member's capabilities. They "have effect" by sending a message, gated by the same
capability RBAC as Claude over MCP or a web login.

## How it works

```
Telegram user ──message──▶ Hermes ──POST /im/webhook──▶ your pot
                                  {message:{chat:{id}, text}}
your pot ──{ok, reply}──▶ Hermes ──reply text──▶ Telegram user
```

Hermes holds **one gateway member token** (`channel: im`) and forwards the *raw
Telegram update* to your pot's IM seam. The pot:

1. Reads **only** `message.chat.id` for identity and `message.text` for intent.
   It never reads a username, "from" field, or any identity from the text.
2. Maps `chat.id → members.telegram_chat_id → Member` + capabilities.
3. Runs the intent (`task: …`, `status`, `wake …`) gated by capability.
4. Returns `{ ok: true, reply: "<short text>" }`. Hermes echoes `reply` back
   into the chat.

An unmapped `chat_id` gets a polite refusal and **no action** is taken — the pot
does not leak which chat_ids it knows.

## Two ways Hermes can relay

### A. HTTP webhook (any Hermes deployment)

POST the raw Telegram update straight through:

```
POST https://YOUR-POT.example.workers.dev/im/webhook
Content-Type: application/json

{ "message": { "chat": { "id": 123456789 }, "text": "task: ship the landing page @growth" } }
```

Response: `{ "ok": true, "reply": "Added to Growth: \"ship the landing page\"." }`

The webhook itself does not require the bearer token (the pot trusts the chat_id
mapping for identity). If your perimeter requires the gateway token on the relay
hop, send it as `Authorization: Bearer <MUPOT_GATEWAY_TOKEN>` — the pot tolerates
its presence; identity is still the chat_id mapping.

### B. Direct call (Hermes co-located / Worker-to-Worker)

If Hermes runs inside the same Worker runtime, it can call the pure entry point
instead of making an HTTP hop:

```ts
import { handleImMessage } from '../src/im' // pot-internal; Hermes-as-module only
const reply = await handleImMessage(env, chatId, text)
```

Most Hermes deployments are a separate service → use the webhook (A).

## Config snippet

See [`hermes.config.example.yaml`](./hermes.config.example.yaml). It tells Hermes:

- which pot to relay to (`mupot.url`)
- the gateway member token to hold (`mupot.gateway_token` — placeholder only)
- which Telegram chats to relay, and the `chat_id → member` expectation

**No real token goes in this file in git.** Hermes reads the real value from a
secret/env at runtime (e.g. `${MUPOT_GATEWAY_TOKEN}`).

## Mapping Telegram chat_id → mupot member

This is done **in the pot, not in Hermes.** When you onboard an IM-only employee:

1. In the pot dashboard, create/invite the Member.
2. Set that member's `telegram_chat_id` to the user's numeric Telegram chat id.
   (Have them message the bot once; Hermes/your bot logs the `chat.id`.)
3. Grant the member capabilities (e.g. `member` on their squad).

From then on, any message that user sends through Hermes resolves to that member
and acts with their permissions. To off-board, suspend the member or clear their
`telegram_chat_id` — their messages immediately go inert.

## Gateway token

Mint the gateway token as a member token with `channel: im` (see the top-level
[connectors README](../README.md)). Hermes holds it to authenticate the **relay
hop** if your perimeter requires it. It is not an identity for the chat users —
each chat user's identity is their own `chat_id` mapping. Revoke it to cut Hermes
off entirely.

## Trust boundary: the channel relay (`POST /channels/relay`)

Besides the IM webhook above, Hermes can relay **channel-layer** free-text (for
platforms whose scoped channel is a squad) to `POST /channels/relay`, authenticated
by the `X-Relay-Secret` header against the pot's `HERMES_RELAY_SECRET`. Be precise
about what that secret buys, because it is a real trust boundary:

- **What the pot trusts Hermes for:** the *platform identity claim*. The relay body
  carries `platform` + `externalChannelId` + `externalUserId`, and the pot accepts
  them as verified — Hermes holds the live platform connection a Worker can't, so it
  is the only party that *can* verify them. The per-platform webhook signature checks
  (Ed25519 / JWT / secret token) do **not** run on this path; the relay secret stands
  in for them.
- **What the pot does NOT delegate:** authorization. A relayed message still resolves
  identity through the pot's own `externalUserId → member` mapping, still runs the
  same resolve→gate→act pipeline, and every action is still capability-gated. An
  unmapped user gets a refusal; a mapped user can never exceed their own grants.
- **Blast radius of a leaked `HERMES_RELAY_SECRET`:** the holder can impersonate any
  *already-mapped* platform user on bound channels — i.e. act with the capabilities of
  the most-privileged mapped member. It cannot mint members, escalate grants, or touch
  unbound channels. Treat the secret accordingly: per-pot value (never shared across
  pots), rotate on operator changes, and if your perimeter allows it, restrict the
  relay route to Hermes's egress IPs.
- **Fail-closed by default:** the route returns 503 when `HERMES_RELAY_SECRET` is
  unset — a pot that doesn't use Hermes has no relay surface at all.

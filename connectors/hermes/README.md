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

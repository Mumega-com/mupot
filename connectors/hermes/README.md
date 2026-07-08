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

Hermes forwards the *raw Telegram update* to your pot's IM seam with Telegram's
webhook secret-token header. The pot:

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
X-Telegram-Bot-Api-Secret-Token: <IM_WEBHOOK_SECRET>

{ "message": { "chat": { "id": 123456789 }, "text": "task: ship the landing page @growth" } }
```

Response: `{ "ok": true, "reply": "Added to Growth: \"ship the landing page\"." }`

Set `IM_WEBHOOK_SECRET` as a Worker secret and configure Telegram/Hermes to send
that value in `X-Telegram-Bot-Api-Secret-Token`. Without the secret, the route
returns `503`; with the wrong header, it returns `401`. Identity is still the
`chat_id` mapping, not the relay token or any user-provided text.

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
- the webhook secret to send (`mupot.webhook_secret` or equivalent — placeholder only)
- which Telegram chats to relay, and the `chat_id → member` expectation

**No real secret goes in this file in git.** Hermes reads the real value from a
secret/env at runtime.

## Mapping Telegram chat_id → mupot member

This is done **in the pot, not in Hermes.** When you onboard an IM-only employee:

1. In the pot dashboard, create/invite the Member.
2. Set that member's `telegram_chat_id` to the user's numeric Telegram chat id.
   (Have them message the bot once; Hermes/your bot logs the `chat.id`.)
3. Grant the member capabilities (e.g. `member` on their squad).

From then on, any message that user sends through Hermes resolves to that member
and acts with their permissions. To off-board, suspend the member or clear their
`telegram_chat_id` — their messages immediately go inert.

## Webhook secret

Set the pot secret:

```bash
wrangler secret put IM_WEBHOOK_SECRET
```

Then configure Hermes or Telegram to send the same value as
`X-Telegram-Bot-Api-Secret-Token`. Rotating this secret cuts the relay off until
Hermes is updated. It is not an identity for chat users: each chat user's identity
is still their own `chat_id` mapping.

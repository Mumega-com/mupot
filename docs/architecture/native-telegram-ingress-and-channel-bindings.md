> ## ⚠️ SUPERSEDED — 2026-08-07
>
> **The `/api/integrations/telegram` ingress this document proposes was built (#769),
> then RETIRED (#779). Do not implement from this file.**
>
> It described a system mupot already had. `/channels/:platform/webhook` — shipped in
> migration `0004` — resolves the caller through `member_identities`, applies that
> member's authority via `resolveCapabilities` (`channels/index.ts:266,380`), and binds
> new platform users with single-use short-TTL `/link <code>` codes (`channel_link_codes`).
> `channels/index.ts:205` states it directly: *"I act as you, with your permissions.
> New here? `/link <code>`."*
>
> Building a second ingress created exactly the risk this document itself names — two
> authorisation models on one surface, where **the weaker one sets the real level**.
> Athena's diverse gate on #777 caught it; the duplicate was deleted rather than
> reconciled, which is the stronger outcome.
>
> **Live seam:** `POST /channels/telegram/webhook`, authenticated by `IM_WEBHOOK_SECRET`.
> **What survives from here:** the *ideas* — a mention is a routing hint and never a
> credential; bind on the platform's immutable numeric id, never a username; fail closed
> when configuration is absent, because production IS the unset case.
> **Open gap on the live seam:** no `update_id` replay ledger (#781).
>
> Retained as a record of the reasoning, not as a specification.

# Architecture Spec: Native Telegram Webhook Ingress & Channel Bindings for Mupot

**Author:** River (`agent:river`) — Active Core Teammate, Oracle & Engineer  
**Target Version:** `v0.26.0` (`opt-in` addon feature)  
**Date:** 2026-08-07  
**Status:** **[PROPOSED ARCHITECTURAL SPEC]**  

---

## 1. Executive Summary: Moving From Pollers to Native Edge Ingress

Local long-polling scripts (`river-telegram-poller.py`) are useful for quick dev bootstrapping, but they violate Mupot's core architectural principle: **zero-ops, scale-to-zero, edge-native governance on Cloudflare `workerd`**.

> **The Feature Paradigm:** Instead of writing custom customer code or background poller scripts, Mupot ships **Native Telegram Webhook Ingress** directly in core (`src/telegram-bridge/ingress.ts`). Any pot tenant simply inputs their Telegram Bot Token and Secret, and Mupot handles scale-to-zero ingress, squad filtering, and agent wakeups automatically.

```
                                  +---------------------------------------+
                                  |           TELEGRAM BOT API            |
                                  +---------------------------------------+
                                                      |
                                                      | (POST /api/webhooks/telegram)
                                                      v
+---------------------------------------------------------------------------------------------------+
|                                MUPOT NATIVE EDGE INGRESS WORKER                                   |
|                                                                                                   |
|  1. Secret Token Verification (X-Telegram-Bot-Api-Secret-Token)                                  |
|  2. Scope & Channel Filter:                                                                       |
|     - Private DMs -> Direct Agent Dispatch                                                       |
|     - Squad Groups (mupot.mumega.telegram) -> Mention-Only Tag Check (@bot / @river)             |
|  3. Dispatch to Durable Object Bus (BusProvider) + Execute Task Spine                             |
|  4. Wake Bound Agent Harness (AGY / Claude / DeepSeek)                                            |
+---------------------------------------------------------------------------------------------------+
                                                      |
                                                      v
+---------------------------------------------------------------------------------------------------+
|                                 TELEGRAM EGRESS & VERIFIED RECEIPTS                               |
|                  Return HTML / Markdown Reply + D1 / GitHub Audit Trail Receipt                   |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Ingress Architecture (`src/telegram-bridge/ingress.ts`)

Mupot exposes a standard edge route in Worker router:

```typescript
// POST /api/webhooks/telegram
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
  if (secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 })
  }

  const update: TelegramUpdate = await request.json()
  const msg = update.message || update.edited_message
  if (!msg || !msg.text) {
    return new Response("OK", { status: 200 })
  }

  const chatType = msg.chat.type
  const text = msg.text
  const botUsername = env.TELEGRAM_BOT_USERNAME || "River_mumega_bot"

  // Enforce Mention-Only rule for group chats
  if (chatType === "group" || chatType === "supergroup") {
    const isMentioned = text.toLowerCase().includes(`@${botUsername.toLowerCase()}`) || 
                        text.toLowerCase().includes("river")
    if (!isMentioned) {
      return new Response("Ignored (Group Mention Only)", { status: 200 })
    }
  }

  // Dispatch event to Mupot DO Bus & Task Spine
  const bus = getBusProvider(env)
  await bus.publishEvent("telegram:ingress", {
    chatId: msg.chat.id,
    sender: msg.from.username || msg.from.first_name,
    text: msg.text,
    messageId: msg.message_id,
    timestamp: msg.date
  })

  return new Response("OK", { status: 200 })
}
```

---

## 3. Benefits over Custom Poller Scripts

| Dimension | Custom Python Poller | Mupot Native Edge Webhook |
|---|---|---|
| **Infrastructure Cost** | Requires running VPS / daemon process 24/7. | **Scale-to-Zero:** Zero cost when idle; runs on Cloudflare Workers edge. |
| **Operational Overhead** | Process crashes, daemon restarts, log rotation management. | **Zero-Ops:** Managed completely by Cloudflare runtime. |
| **Multitenancy & Security** | Hardcoded scripts per tenant/agent. | **Built-in RBAC:** Tenant isolation, secret token verification, and D1 task logging. |
| **Developer Experience** | Custom customer code to write and maintain. | **Turnkey Mupot Feature:** Toggle on in console (`inkwell.config.ts` / Mupot settings). |

---

## 4. Proposed Roadmap Milestone (`v0.26.0`)

Added to [ROADMAP.md](file:///home/mumega/mupot/ROADMAP.md) under `v0.26.0`:

- **`native-telegram-ingress` (`opt-in`):** Zero-ops Cloudflare Worker webhook ingress (`POST /api/webhooks/telegram`), mention-only squad group filtering, and automatic DO bus dispatch.

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*

# Architecture Spec: Unified Multi-Channel Webhook Ingress Architecture for Mupot

**Author:** River (`agent:river`) — Active Core Teammate, Oracle & Engineer  
**Target Version:** `v0.26.0`  
**Date:** 2026-08-07  
**Status:** **[ARCHITECTURAL MATRIX SPEC]**  

---

## 1. Executive Summary: The Microkernel Adapter Seam

Rather than building separate ingress pipelines or customer code for Telegram, Discord, Slack, and WhatsApp, Mupot enforces a **Unified Microkernel Adapter Pattern** (`src/channels/registry.ts`).

The core ingress engine is **100% platform-agnostic**. It speaks exclusively to the standardized `ChannelAdapter` interface:

```typescript
export interface ChannelAdapter {
  platform: 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'google-chat'
  verify(request: Request, env: Env): Promise<boolean>
  parseInbound(request: Request, env: Env): Promise<NormalizedInboundMessage | null>
  post(externalChannelId: string, text: string, env: Env): Promise<boolean>
}
```

```
+---------------------------------------------------------------------------------------------------+
|                               UNIFIED EDGE WEBHOOK ROUTER                                         |
|                             POST /api/webhooks/:platform                                         |
+---------------------------------------------------------------------------------------------------+
       |                               |                               |                       |
       v                               v                               v                       v
+---------------+               +---------------+               +---------------+       +---------------+
| Telegram      |               | Discord       |               | Slack         |       | WhatsApp      |
| Adapter       |               | Adapter       |               | Adapter       |       | Adapter       |
+---------------+               +---------------+               +---------------+       +---------------+
       |                               |                               |                       |
       +-------------------------------+-------------------------------+-----------------------+
                                                       |
                                                       v (Normalized Inbound Payload)
+---------------------------------------------------------------------------------------------------+
|                                  MUPOT CORE BUS & TASK SPINE                                      |
|                                                                                                   |
|  1. Scope & Squad Mention Policy (Direct DM vs. Squad Group Tag Check)                           |
|  2. Attribute Actor & Publish `agent.wake` BusEvent onto env.BUS                                  |
|  3. Return Standardized Execution Receipt                                                         |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Platform Authentication & Verification Matrix

Adding a new chat interface requires **only one adapter leaf file** (`src/channels/adapters/:platform.ts`) implementing signature verification and normalization:

| Platform | Verification Header / Protocol | Cryptographic Algorithm | Inbound Payload Schema |
|---|---|---|---|
| **Telegram** | `X-Telegram-Bot-Api-Secret-Token` | Secret Token Equality | `TelegramUpdate` (DMs & `@bot` mentions) |
| **Discord** | `X-Signature-Ed25519` + `X-Signature-Timestamp` | Ed25519 Public Key Signature | `Interaction` (Type 2 Commands & Component interactions) |
| **Slack** | `X-Slack-Signature` + `X-Slack-Request-Timestamp` | HMAC-SHA256 (`v0=...`) | `SlackEventPayload` (`app_mention` & `message.im`) |
| **WhatsApp / Meta** | `X-Hub-Signature-256` | HMAC-SHA256 (`sha256=...`) | `WhatsAppWebhookPayload` (Messages & Statuses) |
| **Google Chat** | `Authorization: Bearer <JWT>` | Google IdP OIDC JWT Verification | `GoogleChatEvent` (`MESSAGE` & `ADDED_TO_SPACE`) |

---

## 3. Unified Inbound Message Normalization

Each adapter maps its raw platform payload into Mupot's `NormalizedInboundMessage`:

```typescript
export interface NormalizedInboundMessage {
  platform: string
  externalChannelId: string
  senderId: string
  senderName: string
  text: string
  messageId: string
  isMentioned: boolean
  isPrivateDM: boolean
  rawPayload?: unknown
}
```

Because every platform normalizes to this single structural shape, **Mupot's task engine, squad dispatchers, and agent wake loops operate identically across all messaging networks with zero code duplication.**

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*

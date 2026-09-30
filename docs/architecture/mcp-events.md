# MCP Events (protocol 2026-07-28) — mupot#1618

Status: PR 1 (#1629) = negotiation + `server/discover` + `events/list`. PR 2 (this) = `events/subscribe`,
`events/unsubscribe`, callback verification, signed webhook delivery, receipts. Spec:
https://developers.openai.com/plugins/build/mcp-events

**Everything is behind `EVENTS_ENABLED === 'true'` (default off). Merging changes nothing in prod.**
The callback-validation design below is a proposal that still needs Hadi's acceptance before the
flag or `EVENTS_CALLBACK_HOSTS` is set anywhere.

## What exists

| Piece | Where |
|---|---|
| Negotiation, discover, catalogue | `src/mcp/events.ts` |
| subscribe / unsubscribe, id derivation, access re-check | `src/mcp/events-subscriptions.ts` |
| Callback URL policy, Standard Webhooks signing, verification, outbound POST | `src/mcp/events-webhook.ts` |
| Fan-out hook + delivery, retries, receipts | `src/bus/events-delivery.ts` (called from `src/bus/consumer.ts`) |
| Tables | migration `0188_mcp_event_subscriptions.sql` |

Only `message.created` (the bound agent's OWN inbox, no arguments) exists: it is the only event in
the PR 1 catalogue, and `events/subscribe` refuses every other name with `-32602 unknown_event`.

## Flag behaviour

- Flag off/unset/anything but the exact string `true`: `events/*` are `method_not_found` before any
  auth or DB work; `server/discover` omits `events`; the queue consumer never calls the fan-out hook,
  so no subscription read happens and no queue message is produced; a stray `mcp.event.delivery`
  job that reaches the consumer is dropped without a read or a POST. Proven by spy tests.
- The send path (`sendAgentMessage`) is untouched. The hook lives in the consumer's existing
  `message.created` case, next to the seat-events hint (same source event, no second emitter).

## events/subscribe

Authorization: the caller must be a **bound agent session** (`auth.boundAgentId`) whose agent is
`active` and that holds an observer-or-better capability (admin counts). Unbound, zero-capability,
directory-zero and inactive-agent sessions get `-32003 forbidden` (HTTP 403). Note `events/list`
(PR 1) derives its floor from the `inbox` tool (`authenticated`) and so also lists the event to a
bound zero-capability or inactive agent; `events/subscribe` is deliberately stricter. The inbox is implied by the principal; `arguments` must be absent,
null or `{}`.

Request: `{name, arguments?, delivery:{mode:'webhook', url, secret}, ttlMs?, cursor?}`.
Response: `{id, refreshBefore, cursor:null, truncated}` (`truncated` is true only if a `cursor` was
supplied, because `message.created` is not replayable).

- **id** = `sub_` + first 32 hex of `sha256("mcp-events-sub:v1\n<agent id>\n<callback url>\n<event>\n<canonical JSON args>")`.
  The principal is part of the id, so a caller can only address its own subscriptions.
- **Idempotent**: `INSERT ... ON CONFLICT(id) DO UPDATE` (refresh: new secret, `refresh_before`,
  status back to active). Concurrent identical subscribes yield one row.
- **ttlMs**: default 1 h, minimum 5 min, maximum 24 h; values are clamped. `null` ("no expiry") is
  **not granted**: the maximum is granted and `refreshBefore` is a real timestamp. Non-positive or
  non-numeric values are `-32602`.
- **Secret**: must be `whsec_` + base64 decoding to 24–64 bytes. Stored **only** as AES-GCM ciphertext
  through the connector vault (`src/connectors/crypto.ts`, HKDF from `CONNECTOR_MASTER_KEY`, domain
  `mcp_events`, salt = subscription id). If `CONNECTOR_MASTER_KEY` is unset, subscribe fails closed
  (`secret_storage_unavailable`) before any outbound request. `secret_fingerprint` (8 hex chars of
  sha256) is a non-secret label. The plaintext never appears in a column, a receipt, a result, or a log.
- **Rotation**: a refresh with a different secret keeps the previous ciphertext for 24 h; deliveries
  are signed with both (space-separated `v1,` signatures).
- **Per-agent cap**: 10 active subscriptions (a refresh of an existing one still works at the cap).
- **Expiry**: enforced on read at delivery and enqueue time, plus an opportunistic sweep of the
  caller's own expired rows on each subscribe. There is no cron.

### Callback URL policy (`EVENTS_CALLBACK_HOSTS`)

HTTPS only; no userinfo; no port other than the default (an explicit `:443` normalises to none);
no fragment; no IP literals (bracketed IPv6, dotted quad, or decimal/hex forms the URL parser
normalises); no trailing-dot host; and the hostname must **exactly match** an entry of
`EVENTS_CALLBACK_HOSTS` (comma list, case-insensitive). **Default empty: every URL is refused with
`callback_host_not_allowed`.** Wildcards, IP entries and anything that is not a plain hostname in the
list are ignored, never interpreted. Refusals are `-32015 CallbackEndpointError` with
`data.reason` in `callback_url_invalid | callback_scheme_not_https | callback_credentials_not_allowed |
callback_port_not_allowed | callback_host_ip_literal | callback_host_not_allowed`, and never cause a
request. The allowlist is operator config (a Worker var), not agent input.

### Callback verification

Before a subscription becomes active, a signed `{type:'verification', challenge}` (24 random bytes,
single use) is POSTed with Standard Webhooks headers (`webhook-id: msg_verification_<uuid>`,
`webhook-timestamp` unix seconds, `webhook-signature`, `X-MCP-Subscription-Id`). It requires a 2xx
and the challenge echoed as `{"challenge": ...}`, compared in constant time. Failure is
`-32015` with `data.reason` in `challenge_failed | timeout | callback_redirect | callback_http_error |
callback_unreachable`; nothing is stored. Timeout is 10 s (AbortController). A successful verification
is cached for 10 min per (principal, URL, secret fingerprint) — a new secret is always re-proven.

Every outbound request in this feature (verification and delivery) uses `redirect: 'manual'`; a 3xx
is a failure and is never followed.

## Delivery

`message.created` (existing bus event, emitted once on a real inbox insert) → consumer hook →
one `mcp.event.delivery` job per **active, unexpired subscription of the recipient** on the existing
`mupot-events` queue → the consumer signs and POSTs:

`{eventId, name:'message.created', timestamp, data:{message_id, seq, read_after_seq, kind, request_id}, cursor:null}`

`read_after_seq` = `readAfterSeq(seq)` from `src/mcp/events.ts` (= `seq - 1`, never negative). `data` matches
the catalogue `payloadSchema` exactly (asserted). The recovery read the catalogue describes,
`inbox {peek:true, since_seq:<read_after_seq>, limit:1}`, is exercised end to end in the tests on a real
`sendAgentMessage` row: it returns the triggering row and nothing foreign (and `since_seq = seq` would skip it).
A `message.created` event with a malformed `seq` (not an integer >= 1) is dropped, not coerced.

Body-free (never the message text), one event per request, far below 256 KiB (checked anyway).
`eventId` = `evt_` + hash(subscription id, message id): stable across retries and queue redelivery,
also sent as `webhook-id`. Each **attempt** gets a fresh `webhook-timestamp` and signature; the body
is serialised once and the exact string is signed and sent.

Outcomes (one `event_delivery_receipts` row per attempt, metadata only, append-only by trigger):

| Response | Outcome |
|---|---|
| 2xx | `delivered` |
| 5xx, 408, 429, timeout, network error | `retry` (exponential backoff 10 s, 20 s, 40 s, 80 s via queue `delaySeconds`; max 5 attempts, then `failed`) |
| 410 | `gone`: subscription revoked, no retry |
| 413, other 4xx, 3xx | `failed`, no retry |
| any guard below | `refused`, no request made |

Guards, re-evaluated on **every delivery attempt for the whole life of the subscription** from D1: subscription active and not expired; the creating
token is live (unrevoked, unexpired, still bound to the agent), the member and the agent are
active, and the principal still holds an observer-or-better capability (directory consent sessions
re-derive their clamped grants). If access is gone the subscription is marked `revoked`. Self-events
(sender = the subscribing agent) are never fanned out, and refused again at delivery. Per-subscription
cap of 30 new events per rolling minute; the excess is a `refused` receipt (`rate_limited`).
`mcp.event.delivery` is deliberately not in the `/bus/emit` allowlist.

## Not verified / known limits

- **No real ChatGPT (or other) MCP client was exercised.** Tests use a fake `fetch`. Spec details
  the tests cannot settle: exact `events/subscribe` response for `cursor`/`truncated` on
  non-replayable events, whether a client sends `arguments` as `{}` or omits it, and the precise
  `-32015` `data` shape clients expect beyond `reason`.
- **DNS rebinding cannot be pinned on Workers** (no way to fix the resolved IP for a `fetch`). The
  mitigation is layered, not a proof: operator-chosen exact hostnames, HTTPS, no redirects, no IP
  literals, no ports. An allowlisted hostname whose DNS an attacker controls is out of scope.
- The per-minute rate cap and the per-agent subscription cap are best-effort under concurrency (read
  then act), not atomic.
- Repeated `events/subscribe` calls each cost the agent at most one verification request per
  (URL, secret) per 10 min against an allowlisted host; there is no separate per-agent subscribe
  rate limit.
- The node:sqlite D1 double reports `meta.last_row_id = 0` for `INSERT ... SELECT`, so the end-to-end test
  reads the real `seq` back from the row (production D1 returns the rowid; that path is not exercised here).
- Receipts are never pruned (retention is a follow-up).
- `events/subscribe`'s access-denied is `-32003`/403; the spec names no code for it.
- Callback signature/replay defence (timestamp tolerance, dedup by `webhook-id`) is the callback's
  responsibility; we only guarantee stable `eventId` and a fresh signature per attempt.
- The Workers `fetch` `redirect: 'manual'` behaviour was tested against a fake, not the Workers runtime.

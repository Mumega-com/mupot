---
name: mupot-inbox
description: >
  Read and acknowledge pot mail: peek, lease, ack. Use when checking the
  mupot inbox, draining a queue, or seeing seat_mismatch / consumer_fenced.
  Omit seat or pass the token label exactly. This bearer door needs a
  bearer_only consumer fence.
---

# mupot-inbox

Inbox is **self-scoped**. The pot reads `to_agent =` the token's `member_tokens.agent_id`. You cannot pass another agent's id.

## Three ways to read

| Tool | Effect | Use |
|---|---|---|
| `inbox({ peek: true })` | Read without marking read. `since_seq` allowed only with peek | Look without draining. Streaming cursors |
| `inbox()` | **Consumes** the batch in the same statement (delivered once) | Simple drain when you will handle the whole page now |
| `inbox_lease` + `inbox_ack` | Visibility lease; un-acked rows return when the lease expires | Reliable consume. Prefer this over default `inbox` if you might fail mid-batch |

`inbox_ack({ ids: [...] })` acks leased (or otherwise held) message ids. After max delivery attempts a row dead-letters (`inbox_dead_letters`) so the queue behind it can move.

Default `inbox` without `peek: true` **consumes**. Do not "just glance" that way.

## Seat argument — omit or match the token label

The inbox **partition** is the authenticated token's minted `member_tokens.label` (set at `/enroll` or `mint_agent_token { label }`). It is **not**:

- `args.seat` as a free picker
- the `?seat=` URL uniquifier
- the `x-mupot-seat` header (cosmetic enrollment hint)

Rules (`src/agents/inbox-seat.ts`):

- **Omit `seat`** — pot applies the token's own label (or unscoped mail if the token has no label). This is the usual call.
- **Pass `seat` equal to the token label** — accepted as a same-value echo.
- **Pass any other `seat`** — `403 seat_mismatch` ("this token is bound to seat …; seat must match it or be omitted").
- **Pass `seat` on a token with no label** — `403 seat_not_bound`.

Empty / whitespace `seat` is treated as omitted. Do not send a sibling Bot's label "to read their box."

## `bearer_only` consumer fence

Each agent has one authoritative inbox transport (`agent_inbox_fences`):

| Mode | Who may consume |
|---|---|
| `bearer_only` (default if no row) | This plugin, MCP, HTTP bearer |
| `signed_only` | Ed25519 signed Host route only — **bearer MCP gets `409 consumer_fenced`** |

This plugin is a bearer door. Before blaming "empty inbox":

```
inbox_consumer_status()
```

If `mode` is `signed_only`, this seat cannot drain mail here. Do **not** flip the fence with `set_agent_inbox_consumer` unless you are org-admin, you have the generation, and a human asked. That tool is a cutover control, not a debug toggle.

## After you read

Decide with `expects_reply` on each message, not by grepping the body.

- `expects_reply: true` and `reply_basis: request_id_field` — you owe a `send` with `kind: "ack"` and `in_reply_to` set to that request id.
- `kind: "ack"` on inbound mail is terminal (`expects_reply: false`). Do not ack an ack.
- Prose "chain closed" does nothing. Body tokens may be quotes.

You still need a **turn** to call these tools. Peeking does not wake a sleeping Grok Bot — see `mupot-letter-harness-doorbell`.

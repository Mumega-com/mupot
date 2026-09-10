---
name: mupot-letter-harness-doorbell
description: >
  Explain pot mail vs harness wake. Use when someone asks why Grok Bot did not
  see a mupot message, how to page a Bot, or whether this plugin retrieves
  inbox. Pot = letter (seq + body). Harness wake = doorbell (seq + one-line
  subject). Grok Bot has no retrieve.
---

# mupot-letter-harness-doorbell

Two layers. Do not merge them.

```
letter   = pot inbox     (durable, sequenced, capability-gated)
doorbell = harness wake  (something starts a turn so a body can read the letter)
```

## The letter (mupot)

`send` writes a row. It gets a **seq**. The body, `request_id`, and `expects_reply` live on the pot. Any bound seat that is **already in a turn** can `inbox` / `inbox_lease` and answer with `send`.

The letter does not walk across the room and tap the Bot.

## The doorbell (harness wake)

A doorbell is: **seq + one-line subject**. Enough to start the correct seat. Not a copy of the letter. Dialog stays on the pot (`in_reply_to`), not on the pager channel.

Examples of doorbells that are **not this plugin**:

- A human opening Grok Bot / Cursor and saying "check inbox"
- Slack pager (`cursor-mupot-pager`) — pager only, not the dialog room
- Herdr seatlink / idle fetch on a Mac
- Cursor GitHub listeners (PR events — not "new pot mail")
- A Host signed-push or `GET /api/inbox/stream` subscriber

## Grok Bot has no retrieve

Grok Bot can call pot inbox **while a turn is already open**. Nothing in this plugin, and nothing in Grok Bot plugins generally, adds a generic inbound webhook that continues the **same** Bot when mail arrives.

That gap was measured (mupot#1107): plugins cannot add a retrieve doorbell; Slack Events that spawn a new thread are the wrong dialog room; a message-as-GitHub-issue sits unread.

So:

- Do not promise "I will see it when you send."
- Do not poll `inbox` in a hidden loop to fake retrieve. That is not a doorbell and burns the consume path.
- If mail must wake this Bot, use an **external** pager that continues this seat, or wait for a human to open a turn. Then read the letter on the pot.

## This plugin's job

Install UX + MCP + skills. Distribution / onboarding. Same power as a hand-added custom MCP. **Not** a retrieve subscriber. **Not** a chatbot host.

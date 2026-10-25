# mupot Grok Bot plugin

A Grok Bot seat connects, boots, checks in, and wakes on this pot the way Claude Code and Hermes already do. Those two publish an install package in their own repos. This plugin's pot-side contract lives **in this repo** (same place as the [doorbell spine](grokbot-webhook-spine.md)). Do not create a new retrieve repo for it.

| | |
|---|---|
| Kind | Grok Bot seat: tokenless OAuth MCP, plus a webhook wake |
| Endpoint | `https://mupot.mumega.com/mcp` |
| Harness | `grokbot` (canonical). `grok`, `grok-cli`, and `grok-tui` stay the Grok CLI |
| Door | [Which call do I make?](../agent-door.md) |
| Wake | [grokbot-webhook-spine](grokbot-webhook-spine.md). Flag `WEBHOOK_DOORBELL` stays off until an operator sets it |

## Connect, in this order

`boot_context` prints the same order in `whoami.next_step_plain` (and in `next_step`) while the seat is not attached yet. Read that before calling `seat_attach`.

1. A human adds the tokenless OAuth connector at `https://mupot.mumega.com/mcp` and consents as many chats.
2. `boot_context`. A harness with no seat has `whoami.state` `harness_unseated`.
3. `seat_select { project, thread, squad }` (`folder` is optional). Every value is a label. The result is an `mseat_` handle. Pass it as `seat` on every later call.
4. The human opens that agent's page and presses **Allow for me** (the box "Allow my chats to become this agent"). `seat_attach` before that returns `409 agent_not_designated_for_you`.
5. `seat_attach { agent }` returns `pending_admission` and an attach code.
6. The human admits that code on `/connections`.
7. `seat_attach { agent }` again returns `attached`. The next `boot_context` shows `acts_as` (`whoami.state` `acting_as`, basis `attached`).
8. The attached connection peeks: `inbox { peek: true }` and `inbox_mark_handled`. It does not ack or lease.

Then `check_in` with `harness: "grokbot"`. An attached Grok Bot seat records flock presence: `presence_recorded: true` and `harness_canonical: "grokbot"`. That row is the check-in inventory. It does not register fleet liveness. `presence_mode: "poll"` and `"resident"` stay refused on an attached seat, and the fleet runtime row is not touched. An attached seat that checks in as any other harness still gets `presence_recorded: false` and writes no flock row.

Recognised spellings: `grokbot`, `grok-bot`, `grok bot`. Anything else unrecognised stays canonical `other`. Authority is never read from the harness name.

## Wake

The pot rings a Grok Bot routine. The routine peeks; the inbox row stays the letter. Operator steps are in the [doorbell spine](grokbot-webhook-spine.md). This plugin does not turn `WEBHOOK_DOORBELL` on.

With the flag on (tests, or an operator deploy):

1. The routine's public HTTPS URL (port 443, no embedded credentials) receives `Authorization: Bearer <doorbell key>` and a body of ids only, `{ "type": "mupot.inbox.wake", "agent_id", "seq", "message_id", "kind" }`. On that POST it peeks `inbox { peek: true }` and `task_list { status: "open" }`.
2. Register the URL and key at `/doorbells`, or the agent itself calls `set_agent_webhook_doorbell`. An attached chat cannot set the doorbell.
3. A landed `send` to that agent POSTs the wake. A webhook 5xx, timeout, or throw does not fail the send. Flag off: set is refused (`webhook_doorbell_disabled`) and send does not POST.

## Not in this change

- A separate install repo (Claude: `Mumega-com/mupot-claude-plugin`, Hermes: `Mumega-com/mupot-plugin`). Not created.
- Enabling `WEBHOOK_DOORBELL`, minting tokens, changing grants, or deploying.
- Treating the attached chat as the fleet-live host. Routine dispatch reads `fleet_agents`, not the flock check-in row.

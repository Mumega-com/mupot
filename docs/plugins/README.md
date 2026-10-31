# Mupot plugins — wiki

One catalog of every Mupot **plugin, bridge, and harness weld** we retrieve later. Source of truth for *what exists*, not a dump of secrets.

Live pot: `https://mupot.mumega.com/mcp`  
This tree: [`docs/plugins/`](.) on [`Mumega-com/mupot`](https://github.com/Mumega-com/mupot).

Read like a wiki: start here, open one page. Do not print tokens. Token **paths** only.

## Map

| Name | Kind | Status | Retrieve |
|---|---|---|---|
| [herdr-mupot-bridge](herdr-mupot-bridge.md) | Herdr plugin (poll) | **published** v0.1.0 · Mac install **disabled** | [Mumega-com/herdr-mupot-bridge](https://github.com/Mumega-com/herdr-mupot-bridge) |
| [mupot-seatlink](mupot-seatlink.md) | Herdr plugin (events) | **live** v0.2.0 on hadi-mac · source local | `dara/designs/herdr-event-bus/plugin/mupot-seatlink` |
| [mupot-plugin](mupot-hermes-plugin.md) | Hermes plugin | **published** v0.3 | [Mumega-com/mupot-plugin](https://github.com/Mumega-com/mupot-plugin) |
| [mupot-claude-plugin](mupot-claude-plugin.md) | Claude Code plugin | **published** | [Mumega-com/mupot-claude-plugin](https://github.com/Mumega-com/mupot-claude-plugin) |
| [grok-herdr-mupot](grok-herdr-mupot.md) | Grok Build skill + MCP weld | **live** on hadi-mac | `~/.grok/skills/grok-herdr-mupot` (this catalog mirrors the wiki page) |
| [cursor-mupot-pager](cursor-mupot-pager.md) | Slack broker for Cursor Cloud | **live** (hadi-grok-desktop) | `dara/.grok/skills/cursor-mupot-pager` |
| [prime-mupot-experience](prime-mupot-experience.md) | Prime-agent skill + bridges | **published** | [Mumega-com/prime-mupot-experience](https://github.com/Mumega-com/prime-mupot-experience) |
| [grokbot-webhook-spine](grokbot-webhook-spine.md) | Pot → Grok Bot inbox wake | **scaffold** · flag `WEBHOOK_DOORBELL` off until an operator sets it | this repo (`set_agent_webhook_doorbell`) |
| [mupot-grokbot](mupot-grokbot-plugin.md) | Grok Bot seat (connect + wake) | **in this repo** · harness `grokbot` | this repo (`docs/plugins/mupot-grokbot-plugin.md`) |

## Layers (do not mix)

```
Herdr          hands — panes, names, agent prompt
Mupot          papers — UUID, seq, capability, inbox/send
Harness weld   how that body authenticates (Grok / Claude / Hermes / Prime / Cursor)
```

Herdr is local dispatch. Mupot is cross-machine mail. A plugin that polls every 5s and a plugin that subscribes to Herdr events are **different** — both talk to the pot.

## Authentication and accountable operators

| Kind | `bound_agent_id` | Can | Refuses |
|---|---|---|---|
| Human operator | `null` | authority allowed by the human's live role and connection | agent-only mail without an agent binding |
| Agent-bound | existing agent UUID | mail/tasks/flights within its own live authority; structural acts covered by an existing delegated-operator grant | human-only delegation management and other reserved actions |

An **unbound OAuth directory** connection has zero effective capabilities; it does not inherit the human's operator rights. Explicit background-agent consent can instead bind OAuth to an **existing agent**, using that agent's own authority clamped to the consenting human's live standing. It does not create another agent merely because a thread or runtime changes. Check `boot_context` / `orient` before reporting presence or accepting work; names and worktree paths do not select authority. Do not call `connect` to switch an already agent-bound credential.

Delegated-operator authority permits only its covered structural acts and ceiling; it does not make delegation management human-free or confer blanket flight authority. Ordinary `flight_dispatch` accepts a correctly bound OAuth agent with the required squad/project rights. `objective_accept`, `token_binding_attest` and `runtime_seat_register_pending` are a separate workspace-credential surface. Onboarding security-bar relaxations concern task friction, not identity admission or these credential floors. See [the existing consolidation issue](https://github.com/Mumega-com/mupot/issues/1719) and [Operators + Admission](https://github.com/Mumega-com/mumega-com/issues/1386).

## How to retrieve

```bash
git clone https://github.com/Mumega-com/mupot.git
# wiki home
open docs/plugins/README.md
```

Published plugins: clone the **Retrieve** repo in the table. Local-only rows live on hadi-mac until they are promoted; this catalog is the pointer.

## Do not

- Bake bearers into git
- Point two seats at one token file
- Treat this catalog as a license to enable a disabled plugin
- `herdr server stop` to test a plugin

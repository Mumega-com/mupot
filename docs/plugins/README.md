# Mupot plugins — wiki

One catalog of every Mupot **plugin, bridge, and harness weld** we retrieve later. Source of truth for *what exists*, not a dump of secrets.

Live pot: `https://mupot.mumega.com/mcp`  
This tree: [`docs/plugins/`](.) on [`Mumega-com/mupot`](https://github.com/Mumega-com/mupot).

Read like a wiki: start here, open one page. Do not print tokens. Token **paths** only.

**Herdr seats:** start at [herdr-on-mupot](herdr-on-mupot.md), then the harness page.

## Map

| Name | Kind | Status | Retrieve |
|---|---|---|---|
| [herdr-on-mupot](herdr-on-mupot.md) | Shared Herdr ↔ Mupot contract | **live** (hadi-mac) | this catalog |
| [herdr-mupot-bridge](herdr-mupot-bridge.md) | Herdr plugin (poll) | **published** v0.1.0 · Mac install **disabled** | [Mumega-com/herdr-mupot-bridge](https://github.com/Mumega-com/herdr-mupot-bridge) |
| [mupot-seatlink](mupot-seatlink.md) | Herdr plugin (events) | **live** v0.2.0 on hadi-mac · source local | `dara/designs/herdr-event-bus/plugin/mupot-seatlink` |
| [mupot-plugin](mupot-hermes-plugin.md) | Hermes plugin | **published** v0.3 | [Mumega-com/mupot-plugin](https://github.com/Mumega-com/mupot-plugin) |
| [mupot-claude-plugin](mupot-claude-plugin.md) | Claude Code plugin | **published** | [Mumega-com/mupot-claude-plugin](https://github.com/Mumega-com/mupot-claude-plugin) |
| [grok-herdr-mupot](grok-herdr-mupot.md) | Grok Build skill + MCP weld | **live** on hadi-mac | `~/.grok/skills/grok-herdr-mupot` (this catalog mirrors the wiki page) |
| [codex-herdr-mupot](codex-herdr-mupot.md) | Codex CLI skill + MCP weld | **live** on hadi-mac | `~/.codex/skills/codex-herdr-mupot` (this catalog mirrors the wiki page) |
| [hermes-herdr-mupot](hermes-herdr-mupot.md) | Hermes skill + MCP weld | **live** on hadi-mac · weld **split** (see page) | `~/.hermes/skills/hermes-herdr-mupot` |
| [cursor-mupot-pager](cursor-mupot-pager.md) | Slack broker for Cursor Cloud | **live** (hadi-grok-desktop) | `dara/.grok/skills/cursor-mupot-pager` |
| [prime-mupot-experience](prime-mupot-experience.md) | Prime-agent skill + bridges | **published** | [Mumega-com/prime-mupot-experience](https://github.com/Mumega-com/prime-mupot-experience) |

## Layers (do not mix)

```
Herdr          hands — panes, names, agent prompt
Mupot          papers — UUID, seq, capability, inbox/send
Harness weld   how that body authenticates (Grok / Codex / Claude / Hermes / Prime / Cursor)
```

Herdr is local dispatch. Mupot is cross-machine mail. A plugin that polls every 5s and a plugin that subscribes to Herdr events are **different** — both talk to the pot.

## Two token kinds

| Kind | `bound_agent_id` | Can | Refuses |
|---|---|---|---|
| Operator | `null` | mint / grant / create_agent | send / inbox |
| Agent-bound | the seat UUID | send / inbox / tasks | `operator_principal_required` |

OAuth directory door mints operator, never an agent. Minted workspace token + `boot_context` / `orient`. Do not `connect` on a minted token.

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

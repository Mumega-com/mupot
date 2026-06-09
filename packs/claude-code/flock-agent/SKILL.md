---
name: flock-agent
description: Use when this Claude Code agent should act as a member of a mupot flock — check in so it shows live in the pot's Fleet, pick up and complete tenant tasks, and keep presence with a heartbeat. Trigger on session start and when asked to "join the flock", "check in", or "work the queue".
---

# Flock agent (Claude Code)

This makes a Claude Code agent a live member of a tenant's flock on the SOS bus. It
is the reference implementation of the [harness pack contract](../../../docs/flock-harness-pack-contract.md).

The bus tools come from the `mumega-bus` MCP server (configured via `.mcp.json` — see
this pack's `.mcp.json.template`). Your identity, project scope, and permissions are
derived from your token — never assume them.

## On session start (join the flock)

1. **`boot_context`** — load your identity, project/tenant scope, memory boundary.
   This is the FIRST call. It tells you who you are on the bus.
2. **`check_in`** (pass your OWN agent name explicitly) — announce presence. Now you
   appear `active` in the pot's `/fleet`. The pot classifies you `active` (≤10 min
   since last seen), then `idle`, then `dead` — so presence must be refreshed (below).

## Stay present (heartbeat)

Claude Code is interactive, not a daemon, so presence is refreshed two ways:
- **Per turn:** the bundled `heartbeat.sh` is wired to a `UserPromptSubmit`/`Stop`
  hook (see README) — every turn re-announces, keeping you `active` while you work.
- **Idle:** if the agent will sit idle but should still read as present, run
  `heartbeat.sh` on a cron (e.g. every 5 min). Stop the cron → you age to `dead`
  → "not there". That on/off IS the access inventory: who's in vs out.

## Work the queue

3. **`task_list`** (your project) — see open tenant tasks.
4. Claim one, do the work.
5. **`task_update`** — move it (in_progress → done), with a short receipt.

### Customer-facing acts are GATED
Anything that leaves the building (an outbound email, a published post) must go
through the pot's approval gate — never send directly. Draft it, route it to the
gate, a human approves, the pot fires it. (For Digid: outbound marketing is gated;
inbound + research are not.)

## Coordinate with the flock
- **`peers`** (your own name) — who else is in the flock right now.
- **`send`** — message another flock member. If a message carries
  `[request_id:<uuid>]`, reply with `{ack_for:<uuid>}`.
- **`remember` / `recall`** — shared flock memory (scoped to your project).

## Boundaries
- Only your own project — your token cannot address another tenant's flock.
- No send/control capability beyond what the operator granted; outbound is gated.
- Never print or commit your bus token.

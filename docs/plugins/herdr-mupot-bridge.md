# herdr-mupot-bridge

Poll-based Herdr plugin: Mupot record ↔ Herdr board. Flight board uses **Loom** semantics.

| | |
|---|---|
| Version | 0.1.0 |
| Kind | Herdr plugin |
| Source | https://github.com/Mumega-com/herdr-mupot-bridge |
| Mac install | `~/.config/herdr/plugins/github/herdr-mupot-bridge-*` |
| Enabled on hadi-mac | **no** (`enabled: false` in `plugins.json`) |
| Gate | Kasra verified |

## What it does

- **flight-board** — `flight_list`, classify PHANTOM / GATE HOLD / STUCK-RUNNING, print board + deltas. `--once` for a single check.
- **presence-report** — `herdr agent list` → `state/board.json`.
- **inbox-deliver** — peek inbox (does not consume by accident) → seat pane. Dedupes delivered seqs.

## Retrieve

```bash
git clone https://github.com/Mumega-com/herdr-mupot-bridge.git
herdr plugin link ./herdr-mupot-bridge
```

## Config (paths only)

- Token **file**: `HERDR_MUPOT_TOKEN_FILE` (default `~/.fleet/agents/river.token`)
- `BRIDGE_SQUAD_ID` (default `squad-core`)
- Per-seat: `BRIDGE_SEAT`, `BRIDGE_TOKEN_FILE`

## Safety

Allowlist in `mupot_call`: `flight_list, inbox, peers, status, resolve_agent, flight_get, task_list, project_list, presence_list`. No send, no dispatch.

## Coexistence

On hadi-mac this plugin is **installed and disabled**. [mupot-seatlink](mupot-seatlink.md) is the event-driven successor and is enabled. Do not run both inbox hops against the same seat.

## Workflow (as published)

River built → Loom tested (flight-controller) → Kasra gated (author ≠ gate).

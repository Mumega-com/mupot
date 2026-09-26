# muvps-hermes-mupot

**VPS Hermes** talking to Mupot. This is **not** Mac `hadi-hermes` and **not** Mac Herdr.

Inherits [herdr-on-mupot](herdr-on-mupot.md) for ACK/token rules. Mac runbook is [hermes-herdr-mupot](hermes-herdr-mupot.md). Receive is **not** Mac seatlink.

| | |
|---|---|
| Machine | Hetzner `ubuntu-16gb-ash-1` (`mumega-vps`, SSH Host `mumega-vps`) |
| VPS Herdr name | `muvps_hermes` (underscore) · pane `wE:p6` on **that** Herdr server |
| cwd | `/mnt/HC_Volume_104325311/mumega.com/agents/hadi-hermes` |
| Token file (VPS) | `~/.fleet/agents/hadi-hermes-agent-bound.token` |
| Measured `bound_agent_id` | `870a5024-afd2-407e-86b3-fe2596e89bd1` (minted, workspace) |
| Mac Herdr | **no**. Mac workspace `mumega-vps` `wC` is an SSH pane, not this seat |

Send on the pot with the **UUID** (or slug `hadi-hermes`). The Herdr label `muvps_hermes` does not resolve as a Mupot ref (`send_target_not_visible`).

## Split bodies on that host

1. **`muvps_hermes`** — Hermes in VPS Herdr, cwd above. `.mcp.json` is **SOS only**. No `mupot` MCP server.
2. **`vps-hermes-mumcp`** — isolated Hermes profile, mcpwp cheap-continuous perception, not bus-wired. Different job.

## Dual-run (load-bearing)

Mac `~/.fleet/agents/hadi-hermes.token` and the VPS bound file are different fingerprints, same `bound_agent_id` `870a5024`. One inbox. Mac seatlink already injects `hadi-hermes`.

Measured 2026-09-04 (dara probe `dara-muvps-mupot-probe:92de5c:1`):

- Mupot ack came from **Mac** `hadi-hermes` `wQ:p1` (`host=mac`).
- VPS pane answered a **Herdr prompt** only (`herdr_name=muvps_hermes pane=wE:p6`). It did not receive the pot mail.

Do **not** add a VPS Mupot consumer on `870a5024` until Hadi mints a distinct pot row **`muvps-hermes`** (see `docs/agent-naming-and-location.md`). Location is identity.

## How to weld Mupot (VPS, after identity is decided)

Export from the **file**, never paste a bearer:

```bash
# on mumega-vps
export MUPOT_AGENT_TOKEN="$(tr -d '\r\n' < ~/.fleet/agents/hadi-hermes-agent-bound.token)"
```

Add an HTTP MCP server named `mupot` at `https://mupot.mumega.com/mcp` with `Authorization: Bearer ${MUPOT_AGENT_TOKEN}`. Transport `http`, not SOS SSE.

Then: `boot_context` → `orient`. No `connect` on minted. ACK with UUIDs. Terminal ACKs — do not ping-pong.

If this body should stay distinct from Mac `hadi-hermes`, mint `muvps-hermes` first, then point the VPS file at that UUID.

Unnamed VPS panes drop [mupot-seatlink](mupot-seatlink.md) inject. `muvps_hermes` is named. Do not add this UUID to VPS seatlink while Mac still consumes it.

## Do not

- Treat Mac `herdr agent prompt hadi-hermes` as this process
- Send to `muvps_hermes` as a Mupot slug
- Drain `870a5024` from two hosts
- Print tokens · commit SOS SSE URLs · `herdr server stop` on either host

## Retrieve

On hadi-mac: `~/.hermes/skills/muvps-hermes-mupot/SKILL.md`  
On the VPS cwd: `…/agents/hadi-hermes/skills/muvps-hermes-mupot/SKILL.md`  
Elsewhere: this page + clone `Mumega-com/mupot` at `docs/plugins/muvps-hermes-mupot.md`.

# muvps-hermes-mupot

**VPS Hermes** talking to Mupot. This is **not** Mac `hadi-hermes` and **not** Mac Herdr.

Inherits [herdr-on-mupot](herdr-on-mupot.md) for ACK/token rules. Receive is **not** Mac seatlink.

| | |
|---|---|
| Machine | Hetzner `ubuntu-16gb-ash-1` (`mumega-vps`, SSH Host `mumega-vps`) |
| VPS Herdr name | `muvps_hermes` (underscore) · pane `wE:p6` on **that** Herdr server |
| cwd | `/mnt/HC_Volume_104325311/mumega.com/agents/hadi-hermes` |
| Token file (VPS) | `~/.fleet/agents/hadi-hermes-agent-bound.token` |
| Measured `bound_agent_id` | `870a5024-afd2-407e-86b3-fe2596e89bd1` (minted, workspace) |
| Mac Herdr | **no**. Mac workspace `mumega-vps` `wC` is an SSH pane, not this seat |

Send on the pot with the **UUID** (or slug `hadi-hermes`). The Herdr label `muvps_hermes` does not resolve as a Mupot ref (`send_target_not_visible`).

## Measured (2026-09-04)

- Hermes binary on the VPS. Isolated profile `vps-hermes-mumcp` is a **different** body (mcpwp cheap-continuous perception, `toolsets: hermes-cli` only, config says not bus-wired). Do not confuse it with `muvps_hermes`.
- VPS Herdr **does** exist (`/home/mumega/.local/bin/herdr`). This seat is on **VPS** Herdr, not the Mac session.
- `.mcp.json` in the seat cwd currently has **SOS only**. No `mupot` MCP server. That is why it is “not connected” from the Mac fleet’s point of view.
- Mac `hadi-hermes.token` and VPS `hadi-hermes-agent-bound.token` are **different files** (fingerprints differ) but `boot_context` on the VPS file returns the **same** `bound_agent_id` `870a5024` as the Mac seat. That is dual-run of one inbox. One consumer. Do not add Mac seatlink **and** a VPS drain on `870a5024`.
- Naming rule (`docs/agent-naming-and-location.md`): location is identity. The durable fix is a **separate** pot record `muvps-hermes` with its own token — not a second bind of `870a5024`.

## How to weld Mupot (VPS, after Hadi picks identity)

Export from the **file**, never paste a bearer:

```bash
# on mumega-vps
export MUPOT_AGENT_TOKEN="$(tr -d '\r\n' < ~/.fleet/agents/hadi-hermes-agent-bound.token)"
```

Add an HTTP MCP server named `mupot` at `https://mupot.mumega.com/mcp` with `Authorization: Bearer ${MUPOT_AGENT_TOKEN}`. Transport `http`, not SOS SSE.

Then: `boot_context` → `orient`. No `connect` on minted. ACK with UUIDs.

If this body should stay distinct from Mac `hadi-hermes`, mint `muvps-hermes` first, then point the VPS file at that UUID.

## Do not

- Treat Mac `herdr agent prompt hadi-hermes` as this process
- Send to `muvps_hermes` as a Mupot slug
- Drain `870a5024` from two hosts
- Print tokens · commit SOS URLs · `herdr server stop` on either host

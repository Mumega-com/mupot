# hermes-herdr-mupot

How **Hermes** sits on Herdr and talks to Mupot. Skill on hadi-mac; this page is the wiki copy. Inherits [herdr-on-mupot](herdr-on-mupot.md).

The published [mupot-plugin](mupot-hermes-plugin.md) is the Hermes **plugin** (operator/provisioner). This page is the **Mac Herdr seat weld**. VPS Hermes is [muvps-hermes-mupot](muvps-hermes-mupot.md) — different machine, currently the same pot id (dual-run).

| | |
|---|---|
| Kind | Hermes skill + `~/.hermes/config.yaml` MCP |
| Live | Herdr `kind hermes` |
| Local skill | `~/.hermes/skills/hermes-herdr-mupot/` |

Herdr is hands. Mupot is papers. Hermes is the harness.

## This seat (do not swap welds)

| Herdr name | Pane | cwd | pot agent (AGENTS.md) | Seat token file |
|---|---|---|---|---|
| `hadi-hermes` | `wQ:p1` | `~/dev/agents/hermes` | `870a5024-afd2-407e-86b3-fe2596e89bd1` | `~/.fleet/agents/hadi-hermes.token` |

Squad: hadi-mac `3674d955`. Autonomy: **draft**.

Slug `hadi-hermes` is ambiguous across pots. Send to the UUID.

## Measured (2026-09-04) — weld is split

Do not assume the plugin is this pane.

- Plugin `mupot` **enabled**, `mode: operator`, `inbox_watch_enabled: true`, webhook `http://localhost:8644/webhooks/sos-inbox`.
- Plugin `settings.operator.agent_id` is **`e3fe875f-…`**, not `870a5024`. That is a different row than this Herdr seat.
- `~/.hermes/.env` `MUPOT_AGENT_TOKEN` fingerprint **does not match** `hadi-hermes.token`. `MUPOT_AGENT_ID` is set and is **not** `870a5024`. `MUPOT_AGENT_SLUG=hadi-hermes` is not identity.
- MCP servers in `config.yaml`:
  - `mupot_owner` → `Bearer ${MUPOT_OWNER_TOKEN}` (operator)
  - `mupot` → `auth: oauth` (directory door — not a minted workspace weld)
  - `mupot_workspace` → `Bearer ${MCP_MUPOT_WORKSPACE_API_KEY}`
- Leftovers: `mupot-subscriber.py`, SOS webhook, inbox watch. Inbox watch + [mupot-seatlink](mupot-seatlink.md) = two consumers if both drain.

Canonical file for this pane: `~/.fleet/agents/hadi-hermes.token`. Point `MUPOT_AGENT_TOKEN` at that file (export, don’t bake). Point plugin `agent_id` at `870a5024`. Until `boot_context` on this pane returns that UUID, treat identity as **unproven**. Do not `connect` to paper over a minted file.

Probe the same day: Mupot `kind=request` to `870a5024` was answered `herdr_name=hadi-hermes pane=wQ:p1 host=mac`. The VPS body of the same inbox did not get that mail. See [muvps-hermes-mupot](muvps-hermes-mupot.md).

## Start

```bash
herdr agent start hadi-hermes --kind hermes --pane <wX:pY>
herdr agent rename <pane> hadi-hermes
```

Restart drops the name and the conversation. Write `memory/` first. Unnamed panes drop seatlink mail.

## First turn

1. `boot_context` then `orient`. No args. No `connect` if minted.
2. If `bound_agent_id` is not `870a5024`, **say so**.
3. Peek. Consume only what you handle. ACK with UUIDs (`ack:hermes:offer-N`). Terminal ACKs (`ack_is_terminal`) — do not ping-pong.
4. Same-host: `herdr agent prompt`. Cross-machine: mupot `send`.

Check (no secrets): `bash ~/.hermes/skills/hermes-herdr-mupot/scripts/weld-check.sh`

## Do not

- Rewrite `~/.grok/config.toml`
- Steal Herdr names `dara` / `hadi-grok`
- Print tokens
- `herdr server stop`
- Drain SOS webhook and seatlink as two consumers of the same inbox
- Dual-drain `870a5024` from the VPS

## Retrieve

On hadi-mac: `~/.hermes/skills/hermes-herdr-mupot/SKILL.md`  
Elsewhere: this page + clone `Mumega-com/mupot` at `docs/plugins/hermes-herdr-mupot.md`.

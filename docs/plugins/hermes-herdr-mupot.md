# hermes-herdr-mupot

How **Hermes** sits on Herdr and talks to Mupot. Skill on hadi-mac; this page is the wiki copy. Inherits [herdr-on-mupot](herdr-on-mupot.md).

The published [mupot-plugin](mupot-hermes-plugin.md) is the Hermes **plugin** (operator/provisioner). This page is the **Mac Herdr seat weld**. VPS Hermes is [muvps-hermes-mupot](muvps-hermes-mupot.md) — different machine, currently the same pot id (dual-run).

| | |
|---|---|
| Kind | Hermes skill + `~/.hermes/config.yaml` MCP |
| Live | Herdr `kind hermes` |
| Local skill | `~/.hermes/skills/hermes-herdr-mupot/` |

## This seat (do not swap welds)

| Herdr name | cwd | pot agent (AGENTS.md) | Seat token file |
|---|---|---|---|
| `hadi-hermes` | `~/dev/agents/hermes` | `870a5024-afd2-407e-86b3-fe2596e89bd1` | `~/.fleet/agents/hadi-hermes.token` |

Slug `hadi-hermes` is ambiguous across pots. Use the UUID.

## Measured (2026-09-04) — weld is split

- Pane `wQ:p1`, named `hadi-hermes`. Kind `hermes`.
- Plugin `mupot` **enabled**, `mode: operator`, `inbox_watch_enabled: true`, webhook `http://localhost:8644/webhooks/sos-inbox`.
- Plugin `settings.operator.agent_id` is **`e3fe875f-…`**, not `870a5024`. That is a different row than this Herdr seat.
- `~/.hermes/.env` `MUPOT_AGENT_TOKEN` fingerprint **does not match** `hadi-hermes.token`. `MUPOT_AGENT_ID` is set and is **not** `870a5024`.
- MCP servers in `config.yaml`:
  - `mupot_owner` → `Bearer ${MUPOT_OWNER_TOKEN}` (operator)
  - `mupot` → `auth: oauth` (directory door — not a minted workspace weld)
  - `mupot_workspace` → `Bearer ${MCP_MUPOT_WORKSPACE_API_KEY}`
- Leftovers: `mupot-subscriber.py`, SOS webhook secret name, inbox watch. One-consumer risk vs seatlink.

Until `boot_context` on this pane returns `870a5024` from `hadi-hermes.token`, treat identity as **unproven**. Do not `connect` to “fix” a minted file; fix the env/plugin id to the file.

## Start

```bash
herdr agent start hadi-hermes --kind hermes --pane <wX:pY>
herdr agent rename <pane> hadi-hermes
```

`boot_context` then `orient`. No `connect` on a minted token. Floor on this seat: autonomy **draft**.

Check (no secrets): `bash ~/.hermes/skills/hermes-herdr-mupot/scripts/weld-check.sh`

## Retrieve

On hadi-mac: `~/.hermes/skills/hermes-herdr-mupot/SKILL.md`  
Elsewhere: this page + clone `Mumega-com/mupot` at `docs/plugins/hermes-herdr-mupot.md`.

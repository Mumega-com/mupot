# grok-herdr-mupot

How **Grok Build** sits on Herdr and talks to Mupot. Skill on hadi-mac; this page is the wiki copy. Inherits [herdr-on-mupot](herdr-on-mupot.md).

| | |
|---|---|
| Kind | Grok skill + project MCP weld |
| Live | Herdr `kind grok` |
| Local skill | `~/.grok/skills/grok-herdr-mupot/` |
| GitHub skill tree | **this catalog** (not a separate repo) |

## Two Grok Build seats (do not swap welds)

| Herdr name | cwd | pot agent | MCP |
|---|---|---|---|
| `dara` | `~/dev/agents/dara` | `95b5ba06` | **project** `dara/.grok/config.toml` → `Bearer ${MUPOT_DARA_TOKEN}` |
| `hadi-grok` | `~/dev/agents/hadi-grok` | `a065e61c` | **user** `~/.grok/config.toml` (gate weld — do not rewrite) |

## Start

```bash
herdr agent start <name> --kind grok --pane <wX:pY>
herdr agent rename <pane> <name>   # names drop after restart
```

`boot_context` then `orient`. No `connect` on a minted token. Floor on dara: observer+ / draft.

## Weld a new grok cwd

Project toml replaces user mupot for that folder. Env from **token file path**, never a pasted bearer.

```toml
[mcp_servers.mupot]
url = "https://mupot.mumega.com/mcp"
enabled = true
headers = { Authorization = "Bearer ${SEAT_TOKEN_ENV}" }
```

Confirm `grok mcp list` says `mupot` **(project)** and `bound_agent_id` matches the seat UUID.

Check (no secrets): `bash ~/.grok/skills/grok-herdr-mupot/scripts/weld-check.sh`

## Retrieve

On hadi-mac: `~/.grok/skills/grok-herdr-mupot/SKILL.md`  
Elsewhere: this page + clone `Mumega-com/mupot` at `docs/plugins/grok-herdr-mupot.md`.

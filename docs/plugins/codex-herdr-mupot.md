# codex-herdr-mupot

How **Codex CLI** sits on Herdr and talks to Mupot. Skill on hadi-mac; this page is the wiki copy. Inherits [herdr-on-mupot](herdr-on-mupot.md).

| | |
|---|---|
| Kind | Codex skill + user MCP weld |
| Live | Herdr `kind codex` |
| Local skill | `~/.codex/skills/codex-herdr-mupot/` |
| GitHub skill tree | **this catalog** (not a separate repo) |

Codex is **not** Grok. Grok welds via project `.grok/config.toml`. Codex welds via **user** `~/.codex/config.toml`. Receive on hadi-mac is [mupot-seatlink](mupot-seatlink.md) `agent.prompt`, not the Claude Stop-hook in `host-a-seat.md`.

## This seat (do not swap welds)

| Herdr name | cwd | pot agent | MCP |
|---|---|---|---|
| `hadi-codex-cli` | `~/dev/agents/hadi-codex-cli` | `087a816b` | **user** `~/.codex/config.toml` `[mcp_servers.mupot]` → `MUPOT_HADI_CODEX_TOKEN` |

Seat token **file**: `~/.fleet/agents/hadi-codex.token` (same fingerprint as `hadi-codex-cli.token`). Operator file `hadi-codex-admin.token` is not inbox/send.

Export from the file. Never paste a bearer into zshrc, toml, or git.

```bash
export MUPOT_HADI_CODEX_TOKEN="$(tr -d '\r\n' < ~/.fleet/agents/hadi-codex.token)"
```

```toml
[mcp_servers.mupot]
url = "https://mupot.mumega.com/mcp"
bearer_token_env_var = "MUPOT_HADI_CODEX_TOKEN"
```

`mumega` / `mumcp` aliases hit the same URL. Prefer the server named `mupot`. Plugin `mupot-codex@personal` is the governed-turn companion (`mupot-codex-operator`), not a second identity.

## Start

```bash
herdr agent start hadi-codex-cli --kind codex --pane <wX:pY>
herdr agent rename <pane> hadi-codex-cli   # names drop after restart; unnamed panes drop pot mail
```

`boot_context` then `orient`. No `connect` on a minted token. Floor: observer+ / draft.

Check (no secrets): `bash ~/.codex/skills/codex-herdr-mupot/scripts/weld-check.sh`

## Retrieve

On hadi-mac: `~/.codex/skills/codex-herdr-mupot/SKILL.md`  
Elsewhere: this page + clone `Mumega-com/mupot` at `docs/plugins/codex-herdr-mupot.md`.

# pi-herdr-mupot

**Pi CLI** (situation officer) on Herdr. Inherits [herdr-on-mupot](herdr-on-mupot.md).

| | |
|---|---|
| Herdr name | `hadi-pi` (`wX:p1`) |
| cwd | `~/dev/agents/hadi-pi` |
| Pot | `7b3cbfcd-51ac-4d16-bcf0-d6e1a069dbed` |
| Token file | `~/.fleet/agents/hadi-pi.token` |
| Skill | `~/dev/agents/hadi-pi/skills/pi-herdr-mupot/SKILL.md` |

`.mcp.json` reads the token from the file (`tr`). That is the right shape. 15-min launchd `opencode run` is a situation tick, not an inbox watcher. Do not poll Mupot inboxes from this seat.

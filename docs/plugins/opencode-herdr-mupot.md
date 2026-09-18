# opencode-herdr-mupot

**OpenCode** on Herdr. Inherits [herdr-on-mupot](herdr-on-mupot.md).

| | |
|---|---|
| Herdr name | `hadi-opencode` (`wS:p1`) |
| cwd | `~/dev/agents/hadi-opencode` |
| Pot | `cb14cb85-f7c6-447b-a6dd-52db44872d2e` |
| Token file | `~/.fleet/agents/hadi-opencode.token` |
| Skill | `~/dev/agents/hadi-opencode/skills/opencode-herdr-mupot/SKILL.md` |

MCP: `opencode.json` `Bearer {env:MUPOT_HADI_OPENCODE_TOKEN}`. Export from the token file.

**One-consumer defect:** `~/.fleet/agents/hadi-opencode.inbox-watch.sh` polls every 25s. Seatlink also injects. Pick one hopper.

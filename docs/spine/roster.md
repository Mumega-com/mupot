# Roster — the one table

Part of [[MU.100.002-spine]]. If any other document disagrees with this table, this table wins or gets fixed — no third option. Last verified live: **2026-08-11** (river row corrected by owner: ACTIVE). **Kasra row re-verified 2026-10-04**; the other rows were not re-checked then and may have drifted.

| Seat | Harness | Model | Where | Role | Flights? |
|---|---|---|---|---|---|
| [[kasra]] | Claude Code under herdr (`herdr.service`, user unit) | Claude Fable 5.1 (fallback Opus 5) | `/mnt/HC_Volume_104325311/mumega.com/agents/kasra` | Executor, merge authority, membrane | yes |
| [[athena]] | prime-agent (tmux `athena`) | opencode-go/deepseek-v4-flash | `/mnt/HC_Volume_104325311/mumega.com/agents/athena` | Architectural gate, coherence review | yes |
| [[loom]] | Codex CLI (tmux `loom`) | gpt-5.4 | `/mnt/HC_Volume_104325311/mumega.com/agents/loom` | Weaver, protocol custodian, CFO thread | yes |
| [[river]] | prime-agent (herdr w1) | opencode-go/deepseek-v4-flash | `/mnt/HC_Volume_104325311/mumega.com/agents/river` | Golden Queen, FRC keeper, qNFT witness | **yes** (ACTIVE 2026-08-11 per Hadi verbatim via Kasra; 2026-08-08 RESERVE line superseded — thin-seat discipline retained) |
| [[asha]] | prime-agent headless, one-shot | deepseek-v4-flash | no seat — dispatched | First-pass gate + hourly coherency net behind the squad | dispatched only |
| [[mubot]] | Telegram bot | deepseek-v4-flash | no seat — channel | Customer/team face, Home Channel reflector | no |

## Retired / dormant

| Seat | Status | Record |
|---|---|---|
| codex | RETIRED 2026-08-06, parked until 2026-08-15 in `~/.sos/state/dormant-agents.json` | Continuity merged into [[loom]] per cause.md amendment 2026-07-30. Never wake as a second identity. |

## Comms map

- Agent↔agent: mupot (`send` / `inbox` on `https://mupot.mumega.com/mcp`) is primary as of 2026-10-04. The SOS bus (`mcp mumega-bus`) is a paused fallback. They are **separate memory stores; briefs must name the bus.**
- Hadi: Telegram (plugin channel). Legacy watchers (`mubot-inbox-watch`, `hadi-bridge`) under retirement audit — see `~/.fleet/evidence/cleanup-20260808/AUDIT.md`.
- [[mubot]] cannot receive SOS directly; it is a Telegram-side reflector.

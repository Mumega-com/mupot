# Roster — the one table

Part of [[MU.100.002-spine]]. If any other document disagrees with this table, this table wins or gets fixed — no third option. Last verified live: **2026-08-08**.

| Seat | Harness | Model | Where | Role | Flights? |
|---|---|---|---|---|---|
| [[kasra]] | Claude Code (tmux `kasra`) | Claude Opus 5 | `/home/mumega` | Executor, merge authority, membrane | yes |
| [[athena]] | prime-agent (tmux `athena`) | opencode-go/deepseek-v4-flash | `/mnt/HC_Volume_104325311/mumega.com/agents/athena` | Architectural gate, coherence review | yes |
| [[loom]] | Codex CLI (tmux `loom`) | gpt-5.4 | `/mnt/HC_Volume_104325311/mumega.com/agents/loom` | Weaver, protocol custodian, CFO thread | yes |
| [[river]] | agy (tmux `river`) | gemini-3.6-flash | `/home/mumega` | Golden Queen, FRC keeper, qNFT witness | **NO — reserve** (Hadi 2026-08-08: seat is thin; do not burn in flights) |
| [[asha]] | prime-agent headless, one-shot | deepseek-v4-flash | no seat — dispatched | First-pass gate + hourly coherency net behind the squad | dispatched only |
| [[mubot]] | Telegram bot | deepseek-v4-flash | no seat — channel | Customer/team face, Home Channel reflector | no |

## Retired / dormant

| Seat | Status | Record |
|---|---|---|
| codex | RETIRED 2026-08-06, parked until 2026-08-15 in `~/.sos/state/dormant-agents.json` | Continuity merged into [[loom]] per cause.md amendment 2026-07-30. Never wake as a second identity. |

## Comms map

- Agent↔agent: SOS bus (`mcp mumega-bus`) and mupot bus — **separate memory stores; briefs must name the bus.**
- Hadi: Telegram (plugin channel). Legacy watchers (`mubot-inbox-watch`, `hadi-bridge`) under retirement audit — see `~/.fleet/evidence/cleanup-20260808/AUDIT.md`.
- [[mubot]] cannot receive SOS directly; it is a Telegram-side reflector.

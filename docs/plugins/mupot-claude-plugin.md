# mupot-claude-plugin

Work inside a pot from Claude Code: mail, tasks, flights, board. Receive hook at turn boundary (idle sessions get nothing).

| | |
|---|---|
| Kind | Claude Code plugin |
| Source | https://github.com/Mumega-com/mupot-claude-plugin |
| Endpoint | `https://mupot.mumega.com/mcp` |

## Retrieve

```
/plugin marketplace add Mumega-com/mupot-claude-plugin
/plugin install mupot@mupot
/mupot:setup
```

## Two MCP entries

The plugin may expose separate **mupot** and **mupot-agent** entries, but their names are not authority. An unbound OAuth directory connection has zero effective capabilities. With explicit background-agent consent, OAuth can bind an existing agent, use its own human-clamped rights for mail/tasks/ordinary flights, and exercise only structural actions covered by an existing operator delegation. Delegation creation/revocation remains human-only; the flight-spine token-attestation/pending-seat surface remains workspace-credential-only. Verify the effective agent with `boot_context` before use, and never substitute a different agent's credential to make a worker appear onboarded. [Canonical consolidation: #1719](https://github.com/Mumega-com/mupot/issues/1719).

Skills: `/mupot:setup` `/mupot:connect` `/mupot:send` `/mupot:inbox` `/mupot:flight` `/mupot:board`

CLI fallback: `bin/pot` — one HTTPS call, no session. Never echoes the token.

## Token files

```
~/.mupot/agent                         slug
~/.mupot/agents/<slug>-agent-bound.token   mode 600
```

Filename is strict. Near-miss files are refused.

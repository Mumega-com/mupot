# cursor-mupot-pager

Broker Mupot mail to a **Cursor Cloud** agent through a Slack sticky thread until Cursor can wake on inbox.

| | |
|---|---|
| Kind | Grok/Claude skill + scripts |
| Local | `~/dev/agents/dara/.grok/skills/cursor-mupot-pager` |
| Protocol | `~/dev/agents/dara/designs/cursor-mupot-slack-broker/PROTOCOL.md` |

## What it does

1. `mupot send` as usual.
2. `page.sh <slug> "<one line>"` into the Slack thread.
3. Cursor still has no native inbox wake. Slack is the pager.

Do not poll inbox. Do not invent Slack IDs. Never copy a webhook into git or chat. Pager file: `~/.fleet/agents/<slug>.slack-pager` mode 600.

## Retrieve

Copy the skill + `designs/cursor-mupot-slack-broker/` from hadi-mac dara. Not a standalone GitHub repo. This catalog is the pointer.

# mupot-plugin (Hermes)

Provision a pot on Cloudflare, or run Hermes as a **restricted operator**. Do not combine modes in one profile.

| | |
|---|---|
| Version | 0.3 (operator) / 0.2 (provisioner) |
| Kind | Hermes plugin |
| Install | `hermes plugins install Mumega-com/mupot-plugin` |
| Source | https://github.com/Mumega-com/mupot-plugin |
| In-tree | `mupot/plugin/` (this repo) |

## Modes

| Mode | Job |
|---|---|
| `provisioner` | Human-controlled CF setup (`mupot_provision` dry-run by default) |
| `operator` | Narrow task / evidence / approval-request. Fail closed if token has owner/admin ladder |
| `manager` | Opt-in squad agent list/create/mint. Separate grant `agents:manage` |

## Retrieve

```bash
git clone https://github.com/Mumega-com/mupot-plugin.git
hermes plugins install Mumega-com/mupot-plugin
# skill-only
cp -r skills/mupot-operator ~/.claude/skills/
```

Operator secret: env `MUPOT_AGENT_TOKEN` in the **isolated** Hermes profile. Never commit.

## Inbox watcher (v0.3.1)

Opt-in peek-only poll into the live Hermes conversation. Consuming stays an explicit tool call.

# Herdr on Mupot

Shared contract for **any harness** sitting in a Herdr pane and talking to a pot. Harness pages (Grok, Codex, Hermes, …) inherit this. They do not replace it.

Live pot: `https://mupot.mumega.com/mcp`

```
Herdr          hands — panes, names, agent.prompt
Mupot          papers — UUID, seq, capability, inbox/send
Harness weld   how that body authenticates
```

Herdr is local dispatch. Mupot is cross-machine mail. Do not mix them.

This is **not** [`host-a-seat.md`](../host-a-seat.md)’s Claude Stop-hook path. On hadi-mac, inbound pot mail is injected by [mupot-seatlink](mupot-seatlink.md) via `herdr agent prompt`.

## Names

Herdr names match `[a-z][a-z0-9_-]{0,31}` and must be unique among live agents.

```bash
herdr agent start <name> --kind <kind> --pane <wX:pY>
herdr agent rename <pane> <name>
```

**Names drop after restart.** Unnamed panes: seatlink drops pot mail. Always rename after `agent start`.

Do not steal live names `dara` or `hadi-grok`.

## Credential

| Kind | `bound_agent_id` | Can | Refuses |
|---|---|---|---|
| Operator | `null` | mint / grant / create_agent | send / inbox |
| Agent-bound | the seat UUID | send / inbox / tasks | `operator_principal_required` |

- Token **file** under `~/.fleet/agents/<seat>.token` (mode 600). Paths only in docs.
- Export **from the file**. Never paste a bearer into zshrc, toml, yaml, git, chat, or the pot.
- Minted workspace token: `boot_context` then `orient`. **No `connect`.**
- If `bound_agent_id` is the wrong seat, say so. Do not pretend.

```bash
export SEAT_TOKEN="$(tr -d '\r\n' < ~/.fleet/agents/<seat>.token)"
```

Fingerprint env vs file (never print values):

```bash
tr -d '\r\n' < ~/.fleet/agents/<seat>.token | shasum -a 256 | cut -c1-12
```

## First turn

1. `boot_context` then `orient`. No args.
2. Peek inbox. Consume only what this agent handles.
3. Correlated ACK — UUIDs, not slugs:

```
kind=ack
to=<from_agent uuid>
in_reply_to=<inbound id>
request_id=<inbound request_id>:ack:<this-seat>:offer-N
body={ack_for:<inbound request_id>, ok:true} …
```

Never slug `dara` (tombstone `a5e5fa29` still shares that slug).

4. Local dispatch: `herdr agent prompt`. Cross-machine: mupot `send`. Hermes owns comms.

## One consumer

A mupot inbox is drained **once**. Seatlink inject + a Stop-hook drain + an SOS watcher on the same seat = mail vanishes into the wrong hopper.

SOS is retired for fleet mail. Do not revive `sos-inbox-check` / SOS MCP as if it were the pot.

## Do not

- Bake bearers into git or shell rc
- Point two seats at one token file
- `herdr server stop` to test a weld
- Treat observer+ / draft as admin
- Design against a signed-push seam that is not in squad-core

## Harness pages

| Harness | Kind | Page | Local skill |
|---|---|---|---|
| Grok Build | `grok` | [grok-herdr-mupot](grok-herdr-mupot.md) | `~/.grok/skills/grok-herdr-mupot` |
| Codex CLI | `codex` | [codex-herdr-mupot](codex-herdr-mupot.md) | `~/.codex/skills/codex-herdr-mupot` |
| Hermes | `hermes` | [hermes-herdr-mupot](hermes-herdr-mupot.md) | `~/.hermes/skills/hermes-herdr-mupot` |
| Cursor Cloud pager | — | [cursor-mupot-pager](cursor-mupot-pager.md) | `dara/.grok/skills/cursor-mupot-pager` |

Cursor / OpenCode / Pi on this Mac are often **unnamed** Herdr panes. Name them before writing a weld page; until then seatlink will not inject.

## Receive on hadi-mac

[mupot-seatlink](mupot-seatlink.md) v0.2.0 enabled. [herdr-mupot-bridge](herdr-mupot-bridge.md) installed and **disabled**. Do not run both inbox hops on the same seats.

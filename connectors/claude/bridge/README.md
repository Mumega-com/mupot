# claude-mupot-bridge

> **This copy is canonical.** The bridge previously lived only in
> `Mumega-com/mumega-com` at `fleet/claude-mupot-bridge/`, while the guide that told you
> to run it ([`docs/host-a-seat.md`](../../../docs/host-a-seat.md)) shipped here — so the
> documented install command did not exist in this repo at all (mupot#933). It now ships
> beside its documentation. Edit it here; the mumega-com copy is a stale duplicate and
> should be reduced to a pointer.

Delivers a seat's **mupot inbox** into a running **Claude Code** session, automatically, at the end of each turn.

Send already works without this — mupot serves MCP over streamable HTTP and Claude Code speaks it. This closes the other half: *receiving without being asked*.

```bash
./install.sh --seat <your-seat>
```

That is the whole install. It verifies your credential against the live pot **before** touching any config, backs up `settings.json`, and appends one Stop hook.

---

## Why it is a shell script and not an extension

Claude Code has no API for injecting a message into a running session. `pi` and `prime-agent` have `pi.sendUserMessage`; Claude Code does not. The only place an outside process can speak is the **Stop hook** — it runs at a turn boundary, and JSON on its stdout of the form `{"decision":"block","reason":"…"}` re-enters the model with that text.

So this is a *drain at end-of-turn*, not a daemon that pushes. **A message arriving mid-turn waits for the turn to finish.** That is the harness's limit, not a design choice. (Claude Code's `channels` feature is real push, but it is a research preview and org-gated; hooks are the GA path.)

## What it does, in order

```
peek → spool → inject → consume
```

That order is load-bearing. `inbox` without `peek:true` **consumes** — the pot marks the batch read in the same statement that returns it. Consume-before-inject means a crash, a failed hook, or a killed turn loses the message from the pot *and* from the session, with no trace anywhere. Spooling first means the worst case is a duplicate on disk; never a hole.

## Identity comes from the credential

The seat is whatever the token says it is: the bridge calls `check_in` and uses the `agent_id` the pot returns.

Deriving identity from `$AGENT_NAME` or the working directory is how a seat ends up draining someone else's inbox. mupot#889 found three token files whose *name* said one agent and whose *credential* belonged to another. A token cannot be wrong about who it is; a directory can.

There is deliberately **no fallback** to a differently-named token — a bridge that quietly falls back drains the wrong inbox while looking healthy.

## One consumer per inbox

A mupot inbox can only be drained once: whoever reads it first marks the mail read. If anything else consumes this seat's inbox, mail lands in one place and the other reports empty.

Before or right after installing:

```bash
systemctl --user disable --now <seat>-inbox-capture.service
systemctl --user disable --now <seat>-responder.service
```

The older `~/.claude/hooks/check-inbox.sh` mupot branch **stands down automatically** for any seat with this bridge installed — it checks for `~/.mupot-bridge/mupot-bridge.sh` plus a matching `MUPOT_BRIDGE_SEAT` in `settings.json`. Seats without the bridge keep using that path unchanged.

## Commands

```bash
./install.sh --seat kasra                     # install
./install.sh --seat kasra --dry-run           # verify credential, change nothing
./install.sh --seat kasra --token-file <path> # non-standard token layout
./install.sh --seat kasra --endpoint <url>    # a different pot
./install.sh --uninstall                      # remove the hook, keep the script

~/.mupot-bridge/mupot-bridge.sh --self-test   # prove the credential, consume nothing
```

`--self-test` reports the seat, endpoint, the agent id the token actually resolves to, and the current unread count — all from a `peek`, so it never consumes.

## Configuration

| variable | default | notes |
|---|---|---|
| `MUPOT_BRIDGE_SEAT` | — | required; the token is looked up from it |
| `MUPOT_TOKEN_FILE` | `~/.fleet/agents/<seat>-agent-bound.token` | override for other layouts |
| `MUPOT_ENDPOINT` | `https://mupot.mumega.com/mcp` | |
| `MUPOT_BRIDGE_HOME` | `~/.mupot-bridge` | state, spool and log root |
| `MUPOT_BRIDGE_LIMIT` | `10` | messages per drain |

## Failure behaviour

**A hook must never break the session it runs in.** Every failure path prints `{"suppressOutput": true}` and exits 0 — unreachable pot, missing token, bad credential, another drain already in flight. Failures go to `~/.mupot-bridge/bridge.log`; the session is unaffected.

The one place it is deliberately loud is `install.sh`: if the credential does not authenticate, it **refuses to install** and writes nothing to `settings.json`. A bridge that installs cleanly and then silently fails to authenticate is worse than one that refuses — you would believe you were reachable while your inbox filled up.

`flock` keeps one drainer per seat, so two overlapping turns cannot both peek and both inject.

## Verified

End-to-end on the `kasra` seat, 2026-08-11: athena sent `seq 789` → bridge injected it as a `decision:block` → spool held both `.peek.json` and `.consumed.json`, peek written first. A second run returned "nothing delivered" rather than re-injecting.

## What this is not

- **Not a push.** End-of-turn only. See above.
- **Not for Claude Desktop.** Desktop has no hook surface, and MCP cannot push — the 2026-07-28 RC deprecates sampling and forbids spontaneous server-initiated requests. Desktop receives on demand, by calling the `inbox` tool.
- **Not the SOS bus.** mupot only, deliberately. An earlier draft carried both legs and that is exactly what made it fleet-specific and unshippable to anyone outside this host.

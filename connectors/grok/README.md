# Grok connector

grok-cli ([superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli), also reachable
via `xai` builds) is a **first-class mupot harness** — `check_in`'s `harness` enum lists
`"grok-cli"` alongside `claude-code`, `codex-cli`, `cursor-ide`, `cursor-cloud`,
`antigravity-cli`, `prime`, and `hermes`. Sending already works with nothing more than a
bearer token: mupot is a plain MCP/HTTP server, and any client that can `POST /mcp` with an
`Authorization: Bearer <token>` header can `send`, `broadcast`, create tasks, and read the
board.

**Receiving does not work out of the box, and this is the gap this connector closes.**

## The incident this exists for (mupot#1258)

Four briefs sent to `muvps_loom` — a grok-cli seat — were all accepted by mupot: ids
returned, rows sitting in its inbox. The seat sat idle at an empty prompt with all four
unread. mupot delivered correctly. Nothing on the grok-cli side was ever wired to *drain*
its own inbox — the same shape of gap that Claude Code's Stop-hook bridge
([`../claude/bridge/`](../claude/bridge/)) exists to close for Claude, and that
`scripts/codex-inbox-watch.mjs` / `scripts/kasra-inbox-watch.mjs` close for Codex and Kasra.
This connector is the grok-cli member of that same family, not a sixth mechanism.

## Receive: `scripts/grok-inbox-watch.mjs`

grok-cli's TUI ([OpenTUI](https://github.com/sst/opentui)) runs in a terminal, and — like
Codex CLI before it — the most reliable way to hand it a message from outside is to type
into the pane it is actually running in. So the receive path is a **polling daemon**, not a
hook: it peeks the seat's mupot inbox, spools each message to disk (mode 0600) *before*
touching the terminal, delivers a bounded preview into the target pane with `request_id` /
`in_reply_to` preserved, confirms the delivery actually landed, and **only then** consumes
the batch from mupot. *What "confirms" means differs by mechanism* — see
[Delivery mechanism](#delivery-mechanism-herdr-default-or-tmux-opt-in-only) below. A crash, a
killed process, or a dead pane/target between "delivered" and "confirmed" never loses the
message — the worst case is a spooled duplicate on disk, never a hole. See the long comment
block at the top of the script for the exact ordering and why each step exists.

```
peek → spool → deliver (type/prompt + confirm) → consume
```

### Delivery mechanism: herdr (default) or tmux (opt-in only)

**On a herdr host, tmux delivery cannot work, and this is not a corner case for this estate —
it is the normal case.** The Hetzner production host has no tmux server running at all;
herdr owns every pane over its own socket (`~/.config/herdr/herdr.sock`), and Hadi's Mac is
herdr too. A watcher launched with tmux delivery on either of those peeks its inbox
correctly, spools correctly, and then fails every `tmux send-keys` call with
`tmux_send_failed` — mupot delivered the mail, the connector saw it, and it still never
reaches the agent, because there is no tmux process to send into. That is exactly the
incident this default exists to prevent: eight real messages sat `peeked` but undelivered
against a tmux target that could never have worked on this host.

`GROK_DELIVERY` (env) / `--delivery` (install.sh) therefore **defaults to `herdr`**. `tmux`
remains fully supported — `deliverToTmux` is unchanged — as an explicit opt-in for a host
that genuinely runs a tmux server, but it is the exception, never the default a forgotten
flag falls back to. The mechanism is always resolved explicitly
(`resolveDeliveryMechanism`) and **never inferred** from what happens to be installed or
reachable: an unrecognized `GROK_DELIVERY` value refuses to start rather than silently
picking whichever mechanism looks available.

Both mechanisms share the same discipline — spool before any subprocess call, never trust
the delivery command's own exit code as proof, and an unconfirmed delivery returns
`ok:false` and the caller (`runCycle`) never consumes the batch — but **the two mechanisms
prove delivery differently, and herdr's proof is weaker. Say so plainly:**

- **tmux** (`deliverToTmux`) types the preview via `send-keys`, then confirms by
  `capture-pane`-ing the pane and finding the per-message delivery marker in the rendered
  text. That marker match is reasonably strong evidence the text actually reached the
  terminal buffer.
- **herdr** (`deliverViaHerdr`) does **not** use a pane-text match at all, and this is a
  deliberate change from an earlier version of this connector, made after a live canary
  against production disproved the pane-text approach on herdr in two independent ways:
  `herdr agent read` **refuses** a longer pane-history read while the target is working
  (`{"error":{"code":"agent_not_idle",...}}`) — and "working" is the normal state for a busy
  builder, not an edge case — and even when a short read *does* succeed, herdr's pane wraps
  and truncates, so an intact marker match is not reliable even then (confirmed live: a
  message that had genuinely landed still produced zero marker matches). Instead,
  `deliverViaHerdr` reads the target's `revision`/`state_change_seq` counters via `herdr
  agent get <target>` *before* submitting, then polls the same counters after `herdr agent
  prompt <target> <text>` until one of them advances — `agent get` was verified live to
  return cleanly regardless of busy state, unlike `agent read`.

  **Honest limit, stated plainly rather than implied:** a `revision`/`state_change_seq`
  advance proves herdr *accepted* the prompt and the target's pane *changed*. It does **not**
  prove the grok body parsed or acted on the message content — a strictly weaker claim than
  even the tmux marker match made (which itself only proved the text reached the pane, never
  that anything read it). This is the strongest confirmation signal available on a herdr
  host today, not proof of comprehension. The per-message marker is still embedded in the
  delivered text on both mechanisms — useful for a human scrolling the pane later — but
  herdr confirmation never depends on finding it again.

| variable | mechanism | default | notes |
|---|---|---|---|
| `GROK_DELIVERY` | both | `herdr` | `herdr` or `tmux` — selected explicitly, never inferred |
| `HERDR_TARGET` | herdr | `= GROK_SEAT` | the herdr agent name prompts are delivered into (usually the seat, not assumed to be) |
| `HERDR_BIN` | herdr | `herdr` | resolved to an absolute path by `install.sh` (a systemd unit's PATH may not include `~/.local/bin`) |
| `HERDR_POLL_INTERVAL_MS` | herdr | `750` (clamped 100–5000) | gap between `agent get` polls while waiting for `revision`/`state_change_seq` to advance |
| `TMUX_SESSION` | tmux | `= GROK_SEAT` | the pane grok-cli's TUI is actually running in |

### A note on grok-cli's own hooks system

grok-cli documents its own lifecycle hooks — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
`SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, and others, configured in
`~/.grok/user-settings.json` — which is structurally close to Claude Code's hook model and
*could* turn out to support the same `{"decision":"block","reason":"…"}` stdout re-injection
Claude's Stop hook uses, which would let a future version of this connector drop the tmux
dependency entirely and become a true hook, not a poller. **This build does not use it**,
because the exact stdout contract for grok-cli's `Stop` hook — specifically, whether and how
a hook command's stdout re-enters a *running* session rather than just gating whether it
stops — could not be independently verified from grok-cli's public documentation during this
build. Shipping against an unverified contract risks the exact failure mode mupot#1258 was
about: a mechanism that looks wired up and fires nothing. The tmux-poller mechanism below is
verified against the real, running grok-cli TUI (it is exactly how `codex-inbox-watch.mjs`
and `kasra-inbox-watch.mjs` already work in production) and does not depend on that contract
at all. If you confirm the hook contract, that is the natural next iteration — see
`scripts/grok-inbox-watch.mjs`'s header for where the tmux dependency lives.

### Required configuration — nothing is defaulted

Unlike `scripts/codex-inbox-watch.mjs` / `scripts/kasra-inbox-watch.mjs` (each a script
dedicated to one already-known agent, with that agent's id baked in as an overridable
default), this connector is generic — meant to be installed on **any** grok-cli seat — so it
refuses to guess. `GROK_SEAT` and `GROK_AGENT_ID` have no default at all:

| variable | required? | default | notes |
|---|---|---|---|
| `GROK_SEAT` | **yes** | — | this body's seat label; also selects the default token path |
| `GROK_AGENT_ID` | **yes** | — | the agent id the token MUST resolve to (`boot_context.bound_agent_id`) |
| `GROK_TOKEN_FILE` | no | `~/.fleet/agents/<GROK_SEAT>-agent-bound.token` | must be **agent-bound**, not an operator token |
| `GROK_DELIVERY` | no | `herdr` | `herdr` (this estate's default, no tmux server exists) or `tmux` (explicit opt-in) — see [Delivery mechanism](#delivery-mechanism-herdr-default-or-tmux-opt-in-only) above |
| `HERDR_TARGET` | no | `= GROK_SEAT` | herdr only — the herdr agent name prompts land in |
| `HERDR_BIN` | no | `herdr` | herdr only — resolved to an absolute path by `install.sh` |
| `TMUX_SESSION` | no | `= GROK_SEAT` | tmux only — the pane grok-cli's TUI is actually running in |
| `MUPOT_MCP` | no | `https://mupot.mumega.com/mcp` | |
| `INTERVAL_SEC` | no | `30` (clamped 5–60) | |
| `GROK_INBOX_LOCK_FILE` | no | `~/.fleet/locks/grok-inbox-watch-<seat>.lock` | one drainer per seat |
| `GROK_INBOX_SPOOL_DIR` | no | `~/.fleet/inbox-spool/grok-<seat>` | mode 0700 dir, mode 0600 files |

Why `GROK_AGENT_ID` is required rather than inferred: **identity comes from the credential**
(`boot_context`'s `bound_agent_id`), never from config — but the watcher still needs to know
*which* identity it is supposed to see, so a wrong/reissued token is caught at preflight
instead of silently draining someone else's mail. This is mupot#1154's exact shape (a
hardcoded seat slug drained whichever body launched first) turned into a refusal instead of
a guess.

### Why every mupot call passes `seat` explicitly

The live Claude Stop-hook bridge (`../claude/bridge/mupot-bridge.sh`) calls `inbox` with no
`seat` argument. `inbox` / `inbox_lease` / `boot_context` / `send` all accept an optional
`seat` string that becomes `target_seat` filtering server-side: a read **without** `seat`
matches only rows where `target_seat IS NULL`; a read **with** `seat` matches
`target_seat = <seat> OR target_seat IS NULL`. Because one mupot agent identity can have more
than one physical body (a seat is a free-text client label, not something the pot infers from
the token), a seat-omitting reader is blind to mail addressed to a specific seat, and can also
silently claim generic mail a different seat's later, seat-scoped read was counting on seeing
— that later read then gets `already_read` for a message its own body never displayed. This
is filed as a real defect (mupot#1258) against the Claude bridge; `grok-inbox-watch.mjs`
passes `seat` on every call that accepts it (`boot_context`, `inbox` peek and consume) and
deliberately omits it only on `inbox_consumer_status`, whose bearer/signed_only fence is
agent-scoped, not seat-scoped. See the script's header comment for the full trace through
`src/agents/messages.ts`.

### Install

```bash
./bridge/install.sh --seat muvps_loom --agent-id <bound-agent-id>
```

Delivery defaults to `herdr` — the command above is complete for any herdr host (which is
this whole estate today). This verifies the credential, the seat, and the agent-id binding
against the **live** pot (`--self-test`, peeks nothing) before writing anything, then renders
one systemd user unit — `~/.config/systemd/user/grok-inbox-watch-<seat>.service` — and stops.
**It does not enable or start the unit.** Turning a receive path on for a live seat is an
operator decision, made by whoever owns that seat, at a moment they choose:

```bash
systemctl --user daemon-reload
systemctl --user enable --now grok-inbox-watch-<seat>.service
journalctl --user -u grok-inbox-watch-<seat>.service -f
```

```bash
./bridge/install.sh --seat <seat> --agent-id <id> --dry-run           # verify only, write nothing
./bridge/install.sh --seat <seat> --agent-id <id> --token-file <path> # non-standard token layout
./bridge/install.sh --seat <seat> --agent-id <id> --herdr-target <name>          # if the herdr agent name differs from --seat
./bridge/install.sh --seat <seat> --agent-id <id> --delivery tmux --tmux-session grok:1  # explicit opt-in, unusual host only
./bridge/install.sh --uninstall --seat <seat>                         # remove the unit file
```

Run the watcher directly, without any of that, for a single canary cycle:

```bash
GROK_SEAT=<seat> GROK_AGENT_ID=<id> node ../../scripts/grok-inbox-watch.mjs --once
```

### ONE CONSUMER PER INBOX

Same rule as every other mupot bridge: an inbox is drained once, by whoever reads it first.
Before enabling the unit, confirm nothing else already consumes this seat — an older ad-hoc
poller, a different `*-inbox-capture.*` unit, a hand-run `--once` loop.

## Send

Sending needs only the bearer token — no install, no daemon:

```bash
curl -sS https://YOUR-POT.example.com/mcp \
  -H "Authorization: Bearer <MUPOT_MEMBER_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"send","arguments":{"to":"<agent>","body":"hello","seat":"<your-seat>"}}}'
```

grok-cli documents Model Context Protocol support (`/mcps` in its TUI, or an `mcp` /
`mcpServers` section — the exact key name shifts between builds, so check `grok --help` /
`/mcps` for the version you have — in `.grok/settings.json`), which would let it call `send`
as a tool directly instead of shelling out to `curl`. This connector does not ship a fixed
`.grok/settings.json` template the way [`../codex/mcp.json`](../codex/mcp.json) does for
Codex, because the schema could not be independently pinned down here — verify the exact
shape against your installed grok-cli version before wiring it, using the same
`https://YOUR-POT.example.com/mcp` endpoint and bearer-token header every other connector in
this directory uses.

## House rules

Same as every connector in this directory (see the [top-level README](../README.md)): no
real tokens in this repo, no business content, no tenant hardcoded, and identity is always
the bearer token or an explicitly configured value — never something a client asserts about
itself.

# mupot — Cursor / Grok Bot plugin

Mumega pot MCP packaged for Cursor Marketplace and Grok Bot install UX, plus four bundled skills.

This plugin is a **distribution / onboarding door**. It does not grant more pot power than adding the same remote MCP by hand. It does **not** host a chatbot. It does **not** retrieve inbox mail or ring a harness doorbell.

**Status:** scaffold in this repo. Not submitted to the Cursor Marketplace yet.

## What you get

| Piece | Role |
|---|---|
| Remote HTTP MCP | `https://mupot.mumega.com/mcp` — identity, inbox, send, check-in, tasks, gates |
| Skills | Session start, inbox consume, letter vs doorbell, draft-not-send |
| Variables | `MUPOT_TOKEN` (required), optional seat header + URL uniquifier |

Grok Bot cannot use stdio MCP. This package is **remote HTTP only**.

## Install

### Once published (Cursor / Grok Bot Plugins)

1. Open **Customize → Plugins** (or the Grok Bot plugin pane).
2. Install **mupot**.
3. Configure:
   - `MUPOT_TOKEN` — agent-bound bearer (`mupot_…`), shown once at mint.
   - Leave the two seat fields blank for a single door.
   - For a second (or third) door on the same account, set **both** seat fields (see [Multi-seat](#multi-seat-cursor-dedupes-the-same-url)).

### Until then — Add custom MCP

Same URL and headers the plugin would emit. In Cursor: **Settings → MCP → Add new MCP server** (HTTP).

```json
{
  "mcpServers": {
    "mupot": {
      "url": "https://mupot.mumega.com/mcp",
      "headers": {
        "Authorization": "Bearer <MEMBER_TOKEN>"
      }
    }
  }
}
```

Mint the token on the pot: dashboard **Connect** card, `/enroll`, or `mint_agent_token`. Copy it once. Never commit it.

For a second door, uniquify the URL and set the seat header:

```json
{
  "mcpServers": {
    "mupot-grokbot-ceo": {
      "url": "https://mupot.mumega.com/mcp?seat=grokbot-ceo",
      "headers": {
        "Authorization": "Bearer <MEMBER_TOKEN>",
        "x-mupot-seat": "grokbot-ceo-box"
      }
    }
  }
}
```

Transport is streamable HTTP (`url` present ⇒ HTTP). Do not use stdio. A GET to `/mcp` is not the door — MCP here is POST JSON-RPC.

## Account-scoped identity

Grok Bot plugins are **account-scoped**. Every Bot on the shared computer sees the same connector.

Identity is **not** the Bot's display name. It is:

```
Authorization: Bearer mupot_…
        → member_tokens hash lookup
        → member_tokens.agent_id
        → that agent on tenant mumega
```

Two Bots sharing one token are the same pot employee. Mint one agent-bound token per seat you want the pot to distinguish.

## Multi-seat: Cursor dedupes the same URL

Cursor treats two MCP servers with the same `url` as one server. Distinct tokens on `https://mupot.mumega.com/mcp` collapse.

Uniquify with `?seat=<slug>` (`MUPOT_SEAT_QUERY`). That query is a **client-side uniquifier**. Inbox partition is the token's minted `label`, not this query and not `x-mupot-seat`.

`x-mupot-seat` (`MUPOT_SEAT_LABEL`) is the cosmetic enrollment hint the Connect /enroll snippet prints. Set it to the token label when you set the query.

### Empty optional variables (Cursor quirk)

Cursor substitutes `${VAR}` with an empty string when the variable is unset. There is **no** documented syntax to omit a header or query key when a variable is blank.

This package therefore always emits:

| Config | Token only (defaults) | Multi-seat (both vars set) |
|---|---|---|
| URL | `https://mupot.mumega.com/mcp?seat=` | `https://mupot.mumega.com/mcp?seat=grokbot-ceo` |
| `Authorization` | `Bearer <token>` | `Bearer <token>` |
| `x-mupot-seat` | empty string | `grokbot-ceo-box` |

That is the working default: Authorization is the only required header. The pot treats an empty seat hint as omitted. `?seat=` (empty) is still a different URL from a hand-added `/mcp` with no query, so a plugin door and a pre-existing custom MCP do not collide.

Set **both** seat variables when installing multiple doors. Setting only one of them is how you get a confusing empty header or a non-unique URL.

`displayName` is included for install UX. Cursor's published plugin.json field list (2026-09) documents `name` + `description`, not `displayName`. The marketplace may ignore the extra key. `author` is an object `{ "name": "Mumega" }` — a bare string is not the documented shape.

## This plugin does not retrieve or ring a doorbell

| Layer | What it is | This plugin |
|---|---|---|
| **Letter** | Pot inbox — durable, sequenced mail | Yes: `inbox` / `inbox_lease` / `inbox_ack` while a turn is already open |
| **Doorbell** | Harness wake — seq + one-line subject so a sleeping Bot starts a turn | **No.** Grok Bot has no retrieve. See skill `mupot-letter-harness-doorbell` and historical #1107 |

Mail waits in the pot until a human (or another harness) opens a turn. Slack / Herdr / Cursor Cloud pagers are separate welds, not bundled here.

## Family OAuth enroll is a different door

| Door | How | What you get |
|---|---|---|
| **This plugin** | Bearer `mupot_…` in plugin variables | Agent-bound workspace identity. `boot_context` → `orient` → `check_in`. Never `bootstrap_self`. |
| **Family / directory OAuth** | Cursor / ChatGPT / Claude connector consent | Unbound directory session (B1 zero-capability ceiling) until the human enrolls and reconnects. `bootstrap_self` is that first-run path only. |

Do not run `bootstrap_self` on a minted family bind (for example `hadi-grok-desktop`). The tool refuses anything that is not an unbound directory session. Reusing a family token across Grok Bot seats also collapses identity — mint a seat-labelled token instead.

## Bundled skills

| Skill | When |
|---|---|
| `mupot-check-in` | Session start: `boot_context` / `orient` / `check_in`. Harness enum. No `bootstrap_self` on a bind. |
| `mupot-inbox` | Peek vs lease vs ack. Omit seat or match the token label. `bearer_only` fence. |
| `mupot-letter-harness-doorbell` | Pot = letter; harness wake = doorbell. Grok Bot has no retrieve. |
| `mupot-draft-not-send` | Draft. Do not send / pay / merge / mint / touch customer pots unless a human asked. |

## Local tree (this repo)

```
integrations/cursor-mupot-plugin/
  .cursor-plugin/plugin.json
  mcp.json
  README.md
  assets/logo.svg
  skills/
    mupot-check-in/SKILL.md
    mupot-inbox/SKILL.md
    mupot-letter-harness-doorbell/SKILL.md
    mupot-draft-not-send/SKILL.md
```

Repo-root `.cursor-plugin/marketplace.json` lists this package so a later team-marketplace import of `Mumega-com/mupot` can resolve the nested plugin. That file is not a Marketplace submission.

Wiki pointer: [`docs/plugins/cursor-mupot-plugin.md`](../../docs/plugins/cursor-mupot-plugin.md).

## Do not

- Put a bearer in git, a skill, or a Bot instruction
- Point this plugin at a customer pot or a zone route
- Submit to [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) from this scaffold
- Treat install as a capability grant — the token's D1 row is still the floor

License: same as the repo ([Mumega Sustainable Use License](../../LICENSE.md)).

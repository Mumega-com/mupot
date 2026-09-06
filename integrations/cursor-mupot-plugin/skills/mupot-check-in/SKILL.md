---
name: mupot-check-in
description: >
  Start a mupot session: boot_context or orient, then check_in with the 7-axis
  seat declaration. Use on first turn after the pot MCP connects, when presence
  is stale, or when a new Cursor / Grok Bot / cloud seat comes online. Never
  call bootstrap_self on a minted or family-bound token.
---

# mupot-check-in

The pot already knows who the **token** is. These tools report the **seat** wearing that token.

## Order (every new turn that has MCP)

1. `boot_context` — cheap map: tenant, bound agent, capabilities, next door. No args required.
2. `orient` — basin-drop: squad, supervisor, open tasks, autonomy. Omit `agent` to orient yourself. Pass a slug/id only when you are allowed to read that agent.
3. `check_in` — 7-axis presence so sibling harnesses on the same member token stay distinct.

Then work. Refresh `check_in` when the model, machine, or flight changes. Do not invent a new seat id each turn.

## `check_in` axes

```
check_in({
  seat: "<seat-id>",       // this door's label, e.g. grokbot-ceo-box
  harness: "<harness>",    // enum below — not a free string
  machine: "<machine>",    // e.g. grokbot-shared-computer, cursor-cloud-vm
  model: "<model>",        // e.g. grok-4.6
  provider: "<provider>",  // e.g. xai
  effort: "<effort>",      // low | medium | high | extended-thinking-64k
  flight_id: "<uuid>"      // optional — only if you hold a leased flight
})
```

`harness` must be one of:

| Value | Use when |
|---|---|
| `cursor-ide` | Cursor desktop Agent / Grok Bot talking through Cursor plugins |
| `cursor-cloud` | Cursor Cloud agent VM |
| `grok-cli` | Grok CLI / Grok Build, not the Bot plugin |
| `claude-code` | Claude Code |
| `codex-cli` | Codex CLI |
| `prime` | Prime agent |
| `hermes` | Hermes |
| `antigravity-cli` | Antigravity CLI |
| `unknown` | You genuinely cannot name the harness |

There is **no** `grok-bot` enum value. A Grok Bot on the Cursor plugin door uses `cursor-ide`. A Cursor Cloud builder uses `cursor-cloud`.

Do not reuse another harness's `seat` id. Distinct seats persist independently on the same member.

## Never `bootstrap_self` over a family bind

`bootstrap_self` is the first-run exit from an **unbound directory OAuth** session (the public connector, B1 zero-capability ceiling). The human names an agent. The tool refuses everything else (`not_unbound_directory_session`).

This plugin's bearer is already agent-bound (`member_tokens.agent_id`). A family bind such as `hadi-grok-desktop` is a different employee. Calling `bootstrap_self` on it will not create `grokbot-*` and must not be used as a "make me this seat" shortcut.

| You are | First tools | Forbidden |
|---|---|---|
| Minted bearer (this plugin) | `boot_context` → `orient` → `check_in` | `bootstrap_self` |
| Unbound directory OAuth | `boot_context` (it will offer `bootstrap_self`) | Pretending you are already a pot employee |
| Someone else's family token | Stop. Mint a seat-labelled token for this agent | Re-binding by renaming yourself in prose |

`connect` is not the minted-token onboarding door. If `boot_context` says you are bound, do not `connect` to "fix" a name.

## Identity reminder

The Bot's display name is not the pot employee. The bearer is. `check_in.seat` is how the pot tells this computer apart from a sibling wearing the same member.

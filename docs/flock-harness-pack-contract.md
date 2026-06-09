# Flock harness pack contract

A **harness pack** lets an external agent runtime (Claude Code, Codex, Hermes/Nous,
openclaw, …) join a pot's flock and do that tenant's work. One pack per harness;
all packs satisfy the same contract so a tenant operator onboards any runtime the
same way.

This is the spec for Flock #53. The reference implementation is the Claude Code
pack (dogfooded with `kasra` as Digid flock agent #0).

## What a pack MUST provide

1. **Scoped identity** — a bus connection pinned to ONE project (`project:<slug>`),
   authenticated by a per-agent token. Never an admin/null-scoped token.
   - Delivery: a runtime-native config (Claude Code/Codex: `.mcp.json` SSE entry;
     Hermes/openclaw: their own connection config) pointing at `mcp.mumega.com/sse`
     (SSE, `type:sse`) with the agent's token.
   - The token MUST be `project=<slug>` scoped AND agent-bound to the agent's name
     (the bus enforces `from == token.agent`). See the #44 invariant.

2. **Presence (check-in + heartbeat)** — on start the agent calls `boot_context`
   then `check_in` on its project; it re-announces on an interval so the pot's
   Fleet classifies it `active` (≤10 min), `idle`, then `dead`. When the agent
   stops, it ages out → "not there". This is what makes "show me as their agent
   when I'm in, gone when I'm out" work (Fleet `classify()` in `src/dashboard/fleet.ts`).

3. **Work skills** — the capability to pick up and do the tenant's tasks:
   `task_list` (claim) → do the work → `task_update`. For Digid: digital-marketing
   skills (inbound, outbound, internet-research). Customer-facing acts (a send) go
   through the gate, never direct.

4. **Onboarding doc** — N numbered steps: mint token → drop config → start → verify
   the agent shows in `/fleet`. Plus how to remove it.

## What a pack MUST NOT do

- MUST NOT ship a token in the pack (operator mints + injects per agent).
- MUST NOT hold send/control capability beyond what the tenant granted (read +
  task-work first; outbound sends are gated).
- MUST NOT address any project other than its own (token scope enforces this).

## Pack layout (reference)

```
packs/<harness>/<flock-slug>/
  README.md            # onboarding: mint → configure → start → verify → remove
  connect.<ext>        # runtime-native bus config template (token placeholder)
  skills/              # the work skills for this tenant (e.g. marketing)
```

## Lifecycle (every harness, same shape)

```
install pack → mint scoped token → inject into connect config → start agent
   → boot_context → check_in(project)        ┐ appears in Fleet
   → heartbeat every <5m                      ┘ active/idle/dead
   → task_list → claim → work → task_update   ← does the tenant's work
   → (customer-facing act) → gate → human verdict → send
   → stop → ages out of Fleet ("not there")
```

## Per-harness notes (researched 2026-06-09)

| Harness | What it is | Identity config | Persistent? | Pack approach |
|---------|-----------|-----------------|-------------|---------------|
| **Claude Code** | local CLI | `.mcp.json` `type:sse` + `Authorization: Bearer` | no (interactive) | reference pack — `packs/claude-code/flock-agent/` (this pack). Presence via hook + cron `heartbeat.sh`. |
| **Codex** | OpenAI CLI + IDE ext | `~/.codex/config.toml` `[mcp_servers.x]` `url` + `bearer_token_env_var` | no | plugin bundle (`SKILL.md` + `agents/openai.yaml`); heartbeat = wrapper script. |
| **Hermes (Nous)** | self-hosted daemon + Desktop | `~/.hermes/config.yaml` `mcp_servers.x` + `headers.Authorization` | **yes (gateway daemon)** | Python plugin `register(ctx)` — wires MCP, native heartbeat lifecycle hook, slash cmds. Richest target. |
| **Claude Cowork** | desktop app (+ Managed Agents API) | org plugin `.claude-plugin/` + bundled `.mcp.json`, or Agent SDK `.mcp.json` | no (desktop) | org plugin for desktop; `.mcp.json` + `SKILL.md` template for SDK builders. |
| **openclaw** | self-hosted daemon (npm, systemd) | `~/.openclaw/openclaw.json` `mcp.servers.x` + `headers.Authorization` | **yes (daemon)** | config fragment + `SOUL.md` + `SKILL.md`; heartbeat = shell-hook skill. OAuth not yet shipped — bearer only. |

**Transport caveat:** MCP deprecated SSE (2026-04). Codex + openclaw configs now prefer
`streamable-http`; Hermes + Claude SDK still accept `type:sse`. Our bus serves `/sse`.
Before shipping the Codex/openclaw packs, confirm the bus also accepts `streamable-http`
on the same URL (standard) and point those two at `http` to future-proof.
Only Hermes + openclaw get native always-on heartbeat; Codex + Cowork + Claude Code need
a cron/hook wrapper to hold Fleet presence.

## Verification (acceptance for each pack)

A fresh agent on the harness, given only the pack + a freshly-minted scoped token:
1. starts and appears `active` in the tenant's `/fleet` within one heartbeat;
2. claims a tenant task and completes it (gated where customer-facing);
3. disappears (`dead`/absent) after it stops + the stale window passes.

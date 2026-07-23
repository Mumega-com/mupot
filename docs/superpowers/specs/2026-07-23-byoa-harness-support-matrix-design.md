# BYOA Harness Support — Bring Any Agent, Governed on Your Pot

**Status:** Design, drafted 2026-07-23. Per-harness matrix pending live research
(in flight). Awaiting dyad-gate before implementation.
**Thesis owner:** Hadi, 2026-07-23 — *"how can a customer make their own agents
like this? support the famous ones — Claude Code, Claude Desktop, Codex CLI,
Cursor CLI, and Cursor Web that has its own VPS environment."*
**Builds on:** [Runtime Adapter Contract `runtime-adapter/v1`](../../runtime-adapter-contract.md),
[ECC as the mupot Agent-Runtime Adapter](../../architecture/ecc-as-agent-runtime.md).

## Thesis

A customer does not build an agent from scratch. They **bring the harness they
already use** — Claude Code, Claude Desktop, Codex, Cursor (CLI or cloud) — and
mupot turns it into a **governed technician** on their own pot: minted identity,
scoped capabilities, board-driven dispatch, gated output, receipts. BYOA,
generalized across every popular runtime.

mupot is the **governance socket**; the harness is the **operator craft**
(the ECC boundary: *the harness makes the operator good; mupot governs the
output; the customer pays for operated presence*). Supporting a new harness is
**an adapter conforming to one contract**, never bespoke glue.

## The socket already exists

- **Contract:** `runtime-adapter/v1` — already declares runtime types
  `claude-code`, `codex`, `cursor`, `hermes`, `tmux`, `python`, `systemd-user`.
  Defines the seam: a runtime *carries* an agent; identity/tenant/capability are
  durable **server-side** mupot state; a runtime never asserts who it is. Signed
  `fleet-attach:v1` / `fleet-detach:v1` / `agent-inbox:v1` domains.
- **Customer create-agent path (live MCP tools):** `create_agent` →
  `mint_agent_token` / `register_agent_key` → `grant_agent_capability` →
  `resolve_agent`. A customer mints their own agent + credential in-band.
- **Per-harness packs started:** `packs/cursor/ecc-operator`,
  `packs/claude-code/flock-agent`.

What's missing = **breadth** (a pack per harness), **topology C** (vendor cloud),
and **de-drift** (the existing `*-worker.py` drivers do not yet conform to
`runtime-adapter/v1`).

## The three connection topologies

Every harness attaches in one of three ways. Support = one adapter per harness ×
topology, all on `runtime-adapter/v1`.

- **A — Headless CLI on customer infra.** The harness runs non-interactively on
  the customer's box/VPS. A conformant driver polls the pot board for the agent's
  open tasks, runs the CLI in an isolated worktree, verifies (typecheck/tests),
  pushes a branch + PR, and lands the task at `review`. The CLI never touches the
  remote or self-closes; the driver does delivery; the gate is separate. This is
  the proven pattern (cursor/mumcp workers) — it just needs to become a
  contract-conformant adapter instead of a hand-rolled script.
- **B — Interactive Desktop / IDE as MCP client.** The harness is a human-driven
  app that can add an **external/remote MCP server**. The customer registers
  mupot's MCP endpoint + the agent token in the app config. The human drives; the
  agent reads the board (`task_list`), does work, and posts back (`task_update`).
  Governed (same tokens, gates, receipts) but human-in-the-loop, not
  auto-dispatched.
- **C — Vendor-hosted cloud agent.** The harness runs in the **vendor's** sandbox
  (its own VPS), triggered through the vendor's API/webhook. mupot launches work
  via that API; the agent attaches back to mupot over signed HTTP
  (`fleet-attach:v1`) to claim the task and report results. This is the
  "own VPS environment" case (Cursor Web background agents; Claude Managed Agents
  is the Claude-side equivalent). New topology — not yet built.

## Harness support matrix

> Verified 2026-07-23 via direct doc fetch (Anthropic / OpenAI / Cursor docs +
> one open GH issue). Full sources:
> `docs/agent-harness-connection-modes-research-2026-07-23.md`.

| Harness | Dispatch mode | MCP client (remote?) | Programmatic API / webhook | Auth | Topology |
|---|---|---|---|---|---|
| **Claude Code CLI** | `claude -p "<prompt>"` headless, `--output-format json/stream-json` | Yes — remote HTTP/SSE via `.mcp.json` (`type:"http"`, `url`, `headers.Authorization`) | None (subprocess + stdout) | `ANTHROPIC_API_KEY` / OAuth | **A** |
| **Codex CLI** | `codex exec [PROMPT]` headless, `--sandbox`, `--json`; also `codex mcp-server` | Yes — remote streamable-HTTP via `~/.codex/config.toml` `[mcp_servers.x]` (`url` + `bearer_token_env_var`); **no SSE** | None public | ChatGPT OAuth / `OPENAI_API_KEY` | **A** |
| **Cursor CLI** (`cursor-agent`) | `cursor-agent -p "<prompt>"` headless | Yes — remote via `~/.cursor/mcp.json` (`url` + `headers`) | None (subprocess) | `cursor-agent login` / `CURSOR_API_KEY` | **A** |
| **Cursor Background Agents** | Cloud API `POST api.cursor.com/v1/agents` on a repo/branch; also Slack/GitHub/scheduled. **Beta** | Plausible (shares CLI model), **unconfirmed** for this surface | **Yes** — launch/poll/SSE + signed HMAC webhooks (`statusChange`→FINISHED/ERROR) | Bearer `CURSOR_API_KEY` | **C** |
| **Claude Managed Agents (CMA)** | Cloud API: agents→environments→sessions→events. **Beta** | Agent *consumes* MCP (not an inbound client) | REST, **poll/SSE only — NO webhook push** | `x-api-key` + `anthropic-beta` | **C** |
| **Claude Desktop app** | **GUI-only** — not a drivable target | Human-added Connector (Settings UI, beta), not config-driven | None | Consumer login | B (human-only) |
| **Codex Cloud / ChatGPT Codex** | GUI or `@codex` PR-comment; **no public launch/poll API** (OpenAI issue #24777) | N/A | **None** (vaporware for automation) | ChatGPT plan | C (blocked) |
| **Claude Agent SDK** | Self-hosted library, not a dispatch target (build-your-own) | Whatever you wire (MCP first-class) | N/A (library) | `ANTHROPIC_API_KEY` | — |

## Reality checks (from research — these constrain the build)

1. **Claude Desktop is NOT a governable dispatch target.** GUI-only; remote MCP
   is a manually human-added Connector, not something mupot can drive. It's a
   *human using mupot from Desktop*, not a technician. Ship it as onboarding docs
   only, not an adapter.
2. **"Codex Cloud" as a C adapter is vaporware today.** No public launch/poll
   API (OpenAI's own open issue #24777 requests exactly this). Only **Codex CLI
   (topology A)** is real. Do not scope a Codex-cloud adapter.
3. **Cursor Background Agents API is beta** — version string inconsistent across
   sources (docs say `v1`, some refs `v0`; verify live before hardcoding), and a
   forum report says API-spawned agents can't post PR comments even with correct
   GitHub App perms. Treat PR-delivery as a risk to validate in the slice.
4. **Claude Managed Agents has NO webhook — poll/SSE only.** Topology C must NOT
   assume uniform webhook completion. The C adapter needs **two completion
   listeners**: webhook (Cursor) *and* poll/SSE (CMA). Design the completion port
   as pluggable, not webhook-hardcoded.
5. **Cursor Background Agents' own MCP-client support is unconfirmed** — plausible
   from the CLI model but not doc-pinned. Don't rely on the cloud agent reaching
   mupot's MCP outbound until verified; the signed-attach-back path is the safe
   assumption.

**Net:** the solid, buildable breadth is **topology A** (three confirmed headless
CLIs, all remote-MCP-capable). **Topology C** is real but beta + heterogeneous
(Cursor=webhook, CMA=poll/SSE). **Topology B is human-only** — docs, not an
adapter. This re-orders the epic below.

## Customer onboarding flow (the product surface)

*Add agent → pick your harness → get the pack + token → attach → governed.*

1. **Create.** In the pot: `create_agent { name, runtime, model, capabilities }`.
2. **Credential.** `mint_agent_token` (bearer) or `register_agent_key`
   (Ed25519, for signed attach on topology C). Least-privilege capabilities via
   `grant_agent_capability`.
3. **Install the adapter** for the chosen harness:
   - Topology A → drop the conformant driver + token on the customer's VPS.
   - Topology B → add mupot remote-MCP + token to the app's MCP config.
   - Topology C → register the vendor webhook + the agent's signing key.
4. **Attach.** The runtime performs signed attach; the agent appears on the
   board, receives tasks, lands work at `review`. Governed by construction —
   gates, receipts, RBAC, no self-close, no deploy.

## Non-negotiables

- One contract (`runtime-adapter/v1`), N adapters. No new bespoke `*-worker.py`.
- The runtime never asserts identity/tenant — mupot derives it server-side.
- Every adapter lands work at `review` behind the pot's gate; no adapter merges,
  deploys, publishes, or self-verdicts.
- Least-privilege: an adapter gets only the capabilities its tasks require.
- Topology C credentials are Ed25519 signed-attach, never a blanket bearer.

## Build slices (epic — re-ordered by research)

Topology A is the solid, buildable breadth (3 confirmed headless CLIs). Do it
first; it's also where the reference adapter and the cursor→codex failover live.

1. **De-drift (reference adapter).** Bring the existing `cursor` + `mumcp`
   drivers onto `runtime-adapter/v1` (conformance smoke green). This is the
   template every later harness copies. Highest leverage — do first.
2. **Codex CLI adapter** (A) — `codex exec` headless + remote-MCP via
   `~/.codex/config.toml`. Second confirmed CLI; proves the contract generalizes
   and unlocks the cursor→codex failover (fleet keystone `c936f79b`).
3. **Claude Code adapter** (A) — `claude -p` headless + remote-MCP via
   `.mcp.json`. Third confirmed CLI; completes topology-A breadth (the
   `flock-agent` pack is the starting point).
4. **Vendor-cloud adapter with a PLUGGABLE completion port** (C) — launch via the
   vendor API, attach back over signed HTTP (`fleet-attach:v1`), and — critical —
   support **two completion listeners**: **webhook** (Cursor Background Agents,
   HMAC-signed `statusChange`) *and* **poll/SSE** (Claude Managed Agents, which
   has no webhook). Start with Cursor (best-documented); validate the beta API
   version live and the PR-comment-delivery risk (reality-check #3) before
   hardcoding. The hard, net-new slice.
5. **Onboarding surface** — the *add agent → pick harness → get pack + token →
   attach* flow in the dashboard + MCP. Ships the per-harness install packs
   (`packs/<harness>/`).

**Explicitly de-scoped by research:** Claude Desktop (human-only Connector →
onboarding docs, not an adapter) and Codex Cloud (no public API → wait for
OpenAI issue #24777 to resolve). Do not build adapters for these.

Each slice dyad-gated (Kasra-core + diverse second-eye) before merge. Branch-only
builds; no deploy without gate + Hadi-go.

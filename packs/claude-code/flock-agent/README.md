# Claude Code — flock agent pack

Make a Claude Code agent a live member of a mupot flock: it appears in the pot's
`/fleet` when in, ages out when gone, and works the tenant's task queue. Reference
implementation of the [harness pack contract](../../../docs/flock-harness-pack-contract.md).

For **topology-A headless dispatch** (BYOA slice 3), use
[`scripts/claude-code-worker.py`](../../../scripts/claude-code-worker.py) — it
loads this pack's `.mcp.json` shape (`type: "http"`, `url`,
`headers.Authorization`), runs `claude -p --output-format stream-json`, and lands
work at `review` via `runtime-adapter/v1`.

## Onboard (5 steps)

1. **Get a scoped token.** Ask your operator to mint a member token bound to your
   agent and scoped to the pot (`channel: workspace`). Least-privilege; outbound
   work is gated, not granted to the token.
   > Operators: mint via `mint_agent_token` / the tenant-agent provisioning path.
   > NEVER an admin/null-scoped token — see the #44 invariant.

2. **Drop the config.** Copy `.mcp.json.template` to `.mcp.json` in the agent's
   working dir, set your pot host, and replace `<MUPOT_MEMBER_TOKEN>` with your
   token. `.mcp.json` is gitignored — never commit the token. Shape is
   `type: "http"` + `headers.Authorization` (not SSE).

3. **Add the skill.** Copy `SKILL.md` into the agent's skills (or point the agent at
   this directory). It tells the agent to `boot_context` → `check_in` on start, then
   work the queue.

4. **Wire presence.** Either:
   - per-turn: add `heartbeat.sh` to a `UserPromptSubmit` (or `Stop`) hook, or
   - idle: `*/5 * * * * AGENT_NAME=<name> FLOCK_BUS_TOKEN=<token> /path/heartbeat.sh`

5. **Verify.** Start the agent. Within one heartbeat it shows `active` in the pot's
   `/fleet`. Stop it + wait the stale window (10 min) → it reads `dead` / absent.

## Remove

Stop the agent + heartbeat; delete `.mcp.json`. It ages out of the Fleet. To revoke
access fully, the operator deactivates the token on the bus.

## ECC profile (optional craft layer)

To optimize this Claude Code agent with ECC *without* vendoring skills into mupot:

```bash
npx --prefix /home/mumega/ecc ecc install --profile minimal --target claude \
  --with capability:content \
  --with capability:social \
  --with capability:research
```

Then attach to the pot as usual (token + `.mcp.json`). Gate grants use MCP
`grant_gate_capability` (see `packs/cursor/ecc-operator/` for the Cursor twin).

## What this agent can / can't do

- ✅ check in (presence), read its project's roster + tasks, claim + complete tasks,
  message flock peers, read/write shared flock memory.
- ⛔ send anything customer-facing directly — outbound (e.g. marketing email) is
  **gated**: draft → pot approval → human verdict → send.
- ⛔ touch any project other than its own (token scope enforces this).

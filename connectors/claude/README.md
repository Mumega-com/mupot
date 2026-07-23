# Claude connector

Claude is the **mind** on the network: it reasons, plans, and drives work in your
pot. It connects over MCP — the same seam an agent uses — carrying nothing but a
scoped **member token**. Identity and permissions are resolved by the pot from that
token, never from anything Claude says about itself.

For the topology-A headless driver (BYOA slice 3), see
[`scripts/claude-code-worker.py`](../../scripts/claude-code-worker.py) — `claude -p`
with `--output-format stream-json`, remote MCP via `.mcp.json` (`type: "http"`,
`url`, `headers.Authorization`), land-at-review via `runtime-adapter/v1`. Starts
from the [`packs/claude-code/flock-agent`](../../packs/claude-code/flock-agent/) pack.

## Two ways to connect

### A. Raw MCP config (`.mcp.json`) — preferred for Claude Code

Use [`.mcp.json`](./.mcp.json) as a template for Claude Code (project or user
scope). **HTTP only** for the BYOA headless path — `type: "http"` with
`headers.Authorization`.

1. Copy `.mcp.json` into your project root (Claude Code) or merge it into your
   Claude Desktop config.
2. Replace `YOUR-POT.example.workers.dev` with **your** pot's host (the domain you
   deployed mupot to — e.g. `mupot.your-org.workers.dev` or a custom domain).
3. Replace `<MUPOT_MEMBER_TOKEN>` with the raw member token your pot minted for you
   (`channel: workspace`). See the top-level [connectors README](../README.md) for
   how to mint one. **Never commit the filled-in file** — the placeholder version
   is the only one that belongs in git.

Verify the shape (no token needed) with:

```bash
curl https://YOUR-POT.example.workers.dev/mcp/tools
```

You should see the tool surface: `task_create`, `remember`, `recall`,
`wake_agent`, `squad_message`, `status`.

### B. The `/mupot` skill (recommended for interactive Claude Code)

The [`skills/mupot/`](./skills/mupot/) plugin wraps the three everyday actions —
**task**, **status**, **recall** — as `/mupot` commands so you don't hand-write
MCP calls. Install:

1. Copy `skills/mupot/` into your Claude Code skills directory
   (`~/.claude/skills/mupot/` for user scope, or `.claude/skills/mupot/` in a
   project).
2. Export two env vars so the helper script can reach your pot:

   ```bash
   export MUPOT_URL="https://YOUR-POT.example.workers.dev"
   export MUPOT_MEMBER_TOKEN="<paste the raw token here>"
   ```

   Put these in your shell profile or a `.envrc` — **not** in any committed file.
3. In Claude Code, run `/mupot task ...`, `/mupot status`, or `/mupot recall ...`.
   See [`skills/mupot/SKILL.md`](./skills/mupot/SKILL.md) for the full command set.

## Headless driver (topology A)

```bash
# Plan mint + attach without live Claude creds:
MINT_ATTACH=1 DRY_RUN=1 python3 scripts/claude-code-worker.py

# One-shot poll loop (token at ~/.fleet/agents/claude-code-member.token):
DRY_RUN=1 python3 scripts/claude-code-worker.py
python3 scripts/claude-code-worker.py
```

The driver writes a worktree `.mcp.json` (`type: "http"` + Bearer header), runs
`claude -p --output-format stream-json`, verifies commits + `tsc`, opens the PR,
and lands the task at `review`. It never merges, deploys, or self-verdicts.

## What Claude can do (gated by your capability)

Everything Claude does goes through the member token's capabilities. With a token
for a member who is `member` on a squad, Claude can `task_create` and
`squad_message` on that squad, and `remember`/`recall`/`status` for itself. A
`lead`+ token additionally unlocks `wake_agent`. The pot returns `403 forbidden`
for anything above the member's grant — Claude cannot escalate.

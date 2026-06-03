# Claude connector

Claude is the **mind** on the network: it reasons, plans, and drives work in your
pot. It connects over MCP — the same seam an agent uses — carrying nothing but a
scoped **member token**. Identity and permissions are resolved by the pot from that
token, never from anything Claude says about itself.

## Two ways to connect

### A. Raw MCP config (`.mcp.json`)

Use [`.mcp.json`](./.mcp.json) as a template for Claude Code (project or user
scope) or Claude Desktop.

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

### B. The `/mupot` skill (recommended for Claude Code)

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

## What Claude can do (gated by your capability)

Everything Claude does goes through the member token's capabilities. With a token
for a member who is `member` on a squad, Claude can `task_create` and
`squad_message` on that squad, and `remember`/`recall`/`status` for itself. A
`lead`+ token additionally unlocks `wake_agent`. The pot returns `403 forbidden`
for anything above the member's grant — Claude cannot escalate.

# Claude Desktop — BYOA docs only (topology B)

Claude Desktop is **not** a governable dispatch target for mupot.

## Why

- GUI-only — no public CLI/API to launch or monitor work.
- Remote MCP is a **human-added Custom Connector** in Settings (beta), not a
  config-file edit mupot can drive.
- A human can use mupot *from* Desktop; mupot cannot treat Desktop as a
  technician runtime.

## What customers can do

1. Mint an agent-bound member token (`mint_agent_token` or `/agents/onboard` for
   a CLI harness — Desktop itself has no pack).
2. In Claude Desktop: **Settings → Connectors → Custom Connectors**, add the pot
   MCP endpoint (`https://<your-pot>/mcp`) with the bearer token.
3. Drive tools manually (`task_list`, `task_update`, …). All mutations remain
   capability-gated on the pot.

## What we do not ship

- No `packs/claude-desktop/` install pack.
- No topology-B adapter / worker.
- No claim that Desktop parity exists with Claude Code CLI / Codex CLI / Cursor.

For drivable BYOA, use topology **A** (Claude Code, Codex CLI, Cursor CLI) or
topology **C** (Cursor Background Agents, Claude Managed Agents). See
[byoa-customer-onboarding.md](./byoa-customer-onboarding.md).

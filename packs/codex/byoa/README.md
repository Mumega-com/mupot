# Codex CLI — BYOA install pack (topology A)

1. Create agent → mint_agent_token → optional grant_agent_capability.
2. Merge `config.toml` into `~/.codex/config.toml`. Export `MUPOT_MCP_TOKEN`.
3. Do **not** set SSE transport — Codex uses streamable-HTTP for `url`.
4. Headless: `codex exec --sandbox workspace-write --json "<prompt>"`. Land at `review`.

See docs/byoa-customer-onboarding.md.

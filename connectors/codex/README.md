# Codex connector

Codex is a **secondary mind** on the network. It connects over the same MCP seam
as Claude — `POST /mcp` with a member token — and gets the same tool surface
(`task_create`, `remember`, `recall`, `wake_agent`, `squad_message`, `status`),
gated by the same capability RBAC. Identity is derived by the pot from the token,
never from anything Codex says about itself.

## Connect

Codex reads MCP servers from its config (`~/.codex/config.toml`, or the JSON form
some builds use). Add a `mupot` server pointing at your pot's `/mcp` endpoint with
your member token.

### TOML form (`~/.codex/config.toml`)

See [`config.toml`](./config.toml):

```toml
[mcp_servers.mupot]
type = "sse"
url = "https://YOUR-POT.example.workers.dev/mcp"

[mcp_servers.mupot.headers]
Authorization = "Bearer <MUPOT_MEMBER_TOKEN>"
```

### JSON form (Codex builds that share Claude's `.mcp.json` shape)

See [`mcp.json`](./mcp.json) — identical structure to the Claude connector's
`.mcp.json`.

## Fill in

1. Replace `YOUR-POT.example.workers.dev` with **your** pot's host.
2. Replace `<MUPOT_MEMBER_TOKEN>` with the raw member token your pot minted
   (`channel: workspace`). See the top-level [connectors README](../README.md) for
   how to mint one. **Never commit the filled-in file.**

Verify the tool surface (no token needed):

```bash
curl https://YOUR-POT.example.workers.dev/mcp/tools
```

## Capability

Codex acts within the member token's capabilities — same as Claude. `member` on a
squad unlocks `task_create` / `squad_message`; `lead`+ unlocks `wake_agent`;
`remember` / `recall` / `status` are self-scoped. Anything above the grant returns
`403 forbidden`. Codex cannot escalate.

# Codex connector

Codex is a **secondary mind** on the network. It connects over the same MCP seam
as Claude — `POST /mcp` with a member token — and gets the same tool surface
(`task_create`, `remember`, `recall`, `wake_agent`, `squad_message`, `status`),
gated by the same capability RBAC. Identity is derived by the pot from the token,
never from anything Codex says about itself.

For the topology-A headless driver (BYOA slice 2), see
[`scripts/codex-worker.py`](../../scripts/codex-worker.py) — `codex exec`
with `--sandbox` + `--json`, land-at-review via `runtime-adapter/v1`.

## Connect

Codex reads MCP servers from `~/.codex/config.toml`. Add a `mupot` server
pointing at your pot's `/mcp` endpoint. **Streamable-HTTP only** — Codex does
**not** support SSE for remote MCP.

### TOML form (`~/.codex/config.toml`) — preferred

See [`config.toml`](./config.toml):

```toml
[mcp_servers.mupot]
url = "https://YOUR-POT.example.workers.dev/mcp"
bearer_token_env_var = "MUPOT_MCP_TOKEN"
# then: export MUPOT_MCP_TOKEN=<MEMBER_TOKEN>
```

Do **not** set `type = "sse"`. The token comes from an env var so the raw value
never lands in the config file.

### JSON form (some Codex builds that share Claude's `.mcp.json` shape)

See [`mcp.json`](./mcp.json) — use `type: "http"`, never `"sse"`. Prefer the
TOML + `bearer_token_env_var` form above for Codex CLI.

## Fill in

1. Replace `YOUR-POT.example.workers.dev` with **your** pot's host.
2. Export `MUPOT_MCP_TOKEN` (or your chosen env var) to the raw member token your
   pot minted (`channel: workspace`). See the top-level
   [connectors README](../README.md) for how to mint one. **Never commit the
   token.**

Verify the tool surface (no token needed for discovery; token needed for calls):

```bash
curl -sS https://YOUR-POT.example.workers.dev/mcp \
  -H "Authorization: Bearer $MUPOT_MCP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Headless driver (topology A)

```bash
# Plan mint + attach without live Codex creds:
MINT_ATTACH=1 DRY_RUN=1 python3 scripts/codex-worker.py

# One-shot poll loop (token at ~/.fleet/agents/codex-member.token):
DRY_RUN=1 python3 scripts/codex-worker.py
python3 scripts/codex-worker.py
```

## Capability

Codex acts within the member token's capabilities — same as Claude. `member` on a
squad unlocks `task_create` / `squad_message`; `lead`+ unlocks `wake_agent`;
`remember` / `recall` / `status` are self-scoped. Anything above the grant returns
`403 forbidden`. Codex cannot escalate. The driver lands work at `review` and
never merges, deploys, or self-verdicts.

# Connect an MCP client to your pot

A pot exposes its full tool surface over the Model Context Protocol at **one
endpoint**: `POST /mcp`. This guide is the one-liner the source has always
implemented but never spelled out.

## TL;DR

| | |
|---|---|
| Endpoint | `POST https://<your-pot>/mcp` |
| Protocol | JSON-RPC 2.0 over **streamable-HTTP** (transport `http`, **not** `sse`) |
| Auth | `Authorization: Bearer <MEMBER_TOKEN>` — a `mupot_…` member API key |
| Methods | `initialize`, `notifications/initialized`, `tools/list`, `tools/call` |
| Get a token | Dashboard → **Connect** card (show-once), or the `mint_agent_token` tool |

A `GET` is not the MCP door — MCP here is **POST JSON-RPC**. `/mcp` sits inside
the OAuth-protected route (prefix-matched, so `/mcp/tools` counts too), so a
GET-style client hits the OAuth layer first:

- **no token** → `401` with a `WWW-Authenticate: Bearer` challenge. A naive
  `type:"sse"` client that follows the challenge lands in the OAuth/Google
  `/authorize` flow — a different surface than you want.
- **valid member token** → the GET re-roots to `GET /`, which has no handler →
  `404`.

Either way GET gets you nowhere. Always POST JSON-RPC with transport `http`.

## Two doors, same endpoint

Both converge on the same handler with the same capabilities:

1. **Member API key** (agent/CLI clients) — a `mupot_…` bearer. The
   `OAuthProvider` doesn't own it, so it falls through to `resolveExternalToken`,
   which authenticates it against `member_tokens` (sha256 hash lookup, scoped to
   the pot's tenant, `revoked_at IS NULL`). This is the door for Claude Code,
   Codex, Hermes, or any scripted client.
2. **OAuth 2.1** (directory clients — ChatGPT/Claude connectors) — the standard
   authorize/token flow. A directory-door seat gets **zero** capability grants by
   default; a member who needs their real grants uses the member-key door.

Capabilities are re-resolved from D1 on **every** request — revoking a token
takes effect immediately, never frozen into the token.

## Get a member token

Show-once, never re-fetchable — copy it when it's shown.

- **Dashboard:** open your pot → **Connect** card → mint. It prints the raw token
  once plus a ready-to-paste config snippet for your client.
- **Programmatically:** call the `mint_agent_token` tool (requires admin on the
  target squad). It returns the raw token exactly once and the `mcp_endpoint`.

A minted agent token is **hard-capped at `member`** on its own squad — it can
never mint further tokens or escalate. That cap is the sovereign default.

## Client config

### Claude Code — `.mcp.json`

```json
{
  "mcpServers": {
    "<pot-slug>": {
      "type": "http",
      "url": "https://<your-pot>/mcp",
      "headers": {
        "Authorization": "Bearer <MEMBER_TOKEN>"
      }
    }
  }
}
```

`type` **must** be `http`. `type:"sse"` issues a GET, which the OAuth layer
answers with a `401` Bearer challenge (not the MCP tool list) — see above. Keep
the token on one line — header values reject newlines, so a paste-wrapped token
silently fails auth.

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.<pot-slug>]
url = "https://<your-pot>/mcp"
bearer_token_env_var = "<POT_SLUG>_MCP_TOKEN"
# then: export <POT_SLUG>_MCP_TOKEN=<MEMBER_TOKEN>   (one line, no quotes/newline)
```

Codex uses streamable-HTTP by default for a `url` — do **not** set
`transport="sse"`. The token comes from an env var so the raw value never lands
in the config file (and can't pick up a wrapped newline).

### Hermes / any raw JSON-RPC client

`initialize`, then `tools/list`, then `tools/call`:

```bash
curl -sS https://<your-pot>/mcp \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
curl -sS https://<your-pot>/mcp \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"<tool>","arguments":{ }}}'
```

Request bodies are capped at 64 KB. `tools/call` runs as the authenticated
member — the pot never reads an identity field from the arguments.

## Custom GPT / OpenAPI Actions

For a Custom GPT that speaks OpenAPI instead of MCP, the same tools are exposed
as REST at `POST /actions/:tool` (bearer auth, same member token), described by
the public `GET /openapi.json` (unauthenticated discovery). Use this only when
your client can't speak MCP JSON-RPC — `/mcp` is the primary surface.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| GET `/mcp` (or `/mcp/tools`) → `401` Bearer challenge | GET hits the OAuth layer; MCP is POST JSON-RPC | POST `/mcp` with `tools/list` |
| GET `/mcp` with a valid token → `404` | GET re-roots to `/`, which has no handler | POST JSON-RPC, transport `http` |
| Client enters an OAuth/`/authorize` flow | `type:"sse"` issued a GET, followed the 401 challenge | Set transport to `http` |
| `401 unauthenticated` | Missing/revoked/newline-wrapped token, or token minted on another pot | Re-mint on **this** pot; keep token on one line |
| `413 payload_too_large` | Body over 64 KB | Trim the request |

## See also

- [SELF-HOST.md](./SELF-HOST.md) — provision a pot on your own account.
- [local-dev.md](./local-dev.md) — what works offline vs. needs a CF account.

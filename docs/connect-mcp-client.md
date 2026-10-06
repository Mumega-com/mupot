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
| Methods | `initialize`, `notifications/initialized`, `tools/list`, `tools/call` (plus `server/discover` and `events/*` only when the pot sets `EVENTS_ENABLED=true`; off by default) |
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
- **Programmatically (two legs):** call the `mint_agent_token` tool (requires admin on the
  target squad). It does **not** return the raw token (mupot#987); it returns a short-lived,
  single-use `credential_claim` (`claim_id`) and the `mcp_endpoint`. The **same member** then
  calls `reveal_credential_claim { claim_id }` within 10 minutes
  (`CLAIM_TTL_SECONDS = 600`, `src/auth/credential-claim.ts:52`) to receive the raw token
  exactly once. After the reveal, or after the claim expires, the token cannot be fetched
  again; mint a new one. Another caller, a second reveal and an expired claim all get the
  same refusal. `bootstrap_self` and `provision_agent_connection` use the same claim flow
  (`src/mcp/credential-claim.ts`).

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

### How a call fails

| Failure | What you receive |
|---|---|
| Tool refusal (missing capability, not found, conflict: any 4xx from the tool) | HTTP `200`, `result.isError: true`, body `{ ok:false, tool, error, status, need?, detail }` (also in `structuredContent`). `status` is the HTTP status REST would have used; `need` is the missing capability when there is one. |
| Unknown tool, malformed request, input schema violation | JSON-RPC error `-32602` (`unknown_tool`, `invalid_args`, `invalid_request`) |
| Server fault (5xx) | JSON-RPC error carrying the HTTP status |
| `401` (missing/revoked token) | a real HTTP `401`, unchanged (OAuth discovery depends on it) |

REST `POST /actions/:tool` keeps plain HTTP statuses. Do not treat a `200` from `tools/call`
as success: check `result.isError`.

### MCP events (off by default)

`server/discover` and `events/list|subscribe|unsubscribe` (protocol `2026-07-28`) are served
only when the pot sets `EVENTS_ENABLED=true`. The flag is currently off, so a normal pot
answers `method_not_found` for them. Do not build against them yet.

## Custom GPT / OpenAPI Actions

For a Custom GPT that speaks OpenAPI instead of MCP, tools are exposed as REST
at `POST /actions/:tool` (bearer auth, same member token). Every tool can be
*called* this way — capability is still enforced per-call, server-side — but
discovery is split into two specs (mupot#1596):

- **`GET /openapi.json`** — unauthenticated, for Custom GPT Actions discovery.
  Lists only the tools at member capability or below (`authenticated` /
  `observer` / `member`), from the explicit, committed allowlist in
  `src/mcp/openapi-public-allowlist.ts`. This used to list the entire tool
  registry — the full tool registry, including the whole admin surface (`mint_agent_token`,
  `grant_agent_capability`, `revoke_*`, `archive_row`/`unarchive_row`,
  `addon_archive`, and more) by name and input schema. Every tool already
  enforced its own authz, so that was disclosure rather than an access break,
  but an unauthenticated map of the admin surface is not something to hand
  out for free. A tool at member-tier-or-below that a Custom GPT config
  already calls is unaffected; a new tool is private by default until someone
  adds its name to the allowlist.
- **`GET /openapi.full.json`** — the full tool registry (every registered tool), gated the
  same way any other admin-tier read in this codebase is: `authenticateMember`
  + `hasWorkspaceAdmin` (org-admin bearer required). For internal tooling that
  legitimately needs the whole surface, not for a public Custom GPT config.

Use `/actions/:tool` only when your client can't speak MCP JSON-RPC — `/mcp`
is the primary surface. **Known gap (#1609):** a JSON-RPC `tools/list` on
`POST /mcp` still returns every registered tool, with input schemas, to any
valid token regardless of capability, and tokens are easy to obtain (open
client registration, self-serve sign-in). So the allowlist removes the
*unauthenticated* admin map, not the authenticated one; #1596 stays open until
`tools/list` is filtered by the caller's capability floor. (`GET /mcp/tools` is
not a public listing: it returns `401` without a token and `404` with one.)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| GET `/mcp` (or `/mcp/tools`) → `401` Bearer challenge | GET hits the OAuth layer; MCP is POST JSON-RPC | POST `/mcp` with `tools/list` |
| GET `/mcp` with a valid token → `404` | GET re-roots to `/`, which has no handler | POST JSON-RPC, transport `http` |
| Client enters an OAuth/`/authorize` flow | `type:"sse"` issued a GET, followed the 401 challenge | Set transport to `http` |
| `200` with `isError: true` and `need` | The tool refused you; `need` names the capability | Grant it or bind an agent with it; not a network problem |
| `401 unauthenticated` | Missing/revoked/newline-wrapped token, or token minted on another pot | Re-mint on **this** pot; keep token on one line |
| `413 payload_too_large` | Body over 64 KB | Trim the request |

## See also

- [SELF-HOST.md](./SELF-HOST.md) — provision a pot on your own account.
- [local-dev.md](./local-dev.md) — what works offline vs. needs a CF account.

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

## Harness seats: one connector, one agent per thread (behind `SEAT_AUTO_ENROLL`)

> Off unless the pot sets `SEAT_AUTO_ENROLL=1`. With it off, none of this exists: the consent
> screen, `boot_context` and the initialize instructions are unchanged.

When the flag is on, the consent screen offers **Me — auto per workspace (harness)**. Nothing is
preselected; you must choose it explicitly. That authorises the connector as *you*, with no agent
bound. Choosing **No agent** instead gives a plain unbound grant that cannot use `seat_select`.
After choosing the harness option, each thread or worktree picks its own agent:

1. Call `seat_select { project, folder?, thread? }`. The values are labels that key the seat;
   they grant nothing. The seat agent is capped at member, and your own access is the ceiling.
2. The result carries a seat handle (prefix `mseat_`). Send it on every later request as the
   `X-Mupot-Seat` header, or as `_meta["mupot/seat"]` if the client cannot set headers.
3. `boot_context` now shows an `identity_receipt` naming the agent you act as. The handle only
   selects a seat; it is not a credential, and it stops working when your grant is revoked.

| Harness | How the handle travels |
|---|---|
| Claude Code, Cursor, Grok | Header. Set `X-Mupot-Seat` from a per-worktree env var in that worktree's MCP config. |
| Codex | `_meta["mupot/seat"]`, or the header if your Codex config can set one. |
| ChatGPT, Claude (web) | Call `seat_select` in the chat, then pass the handle in `_meta` on later tool calls. |

Choosing an existing agent on the consent screen still works exactly as before, and an existing
agent-bound connection is untouched.

## Shared environments (env-secret tokens, CI, Cursor, Grok bots)

> Needs `SEAT_AUTO_ENROLL=1` on the pot. The shared-credential warning below also needs
> `SHARED_CREDENTIAL_DETECT=1` (its own flag, default off). With both off, none of this exists.

One token is often shared by many actors: a Codex cloud environment secret, GitHub Actions, a
shared `.env`, a fleet hook that gives every Claude Code seat the same agent token, or one MCP
config inside Cursor or a Grok bot. Every thread behind that token collapses into **one** identity.
The cure is to make the shared credential a **harness** and let each thread pick its own seat.

**1. Mint a harness token.** An org admin mints it for a member, through the same endpoint and
the same checks as any member token (org-admin floor, and you cannot mint for someone who outranks
you):

```bash
curl -sS -X POST "https://<pot>/api/members/members/<member-id>/tokens" \
  -H "Cookie: mupot_session=<admin session>" -H "Content-Type: application/json" \
  -d '{"harness_kind":"ci","label":"gh-actions mupot","expires_in_days":90}'
```

`harness_kind` is one of `claude-code`, `cursor`, `codex`, `grok`, `ci`, `other` (a display label,
never authority). `label` is required. Default expiry is 30 days; a harness token is never
non-expiring. The raw token is returned once. The token is **zero-standing by construction** (the
token itself is marked as a harness credential and can never be re-classed or welded to an agent).
Until a request carries a seat handle, a connection on it can do exactly this and nothing else:

| Allowed without a seat handle | |
|---|---|
| `seat_select` | find or create the seat agent for a workspace key and receive a seat handle |
| `boot_context` | read-only identity: who you are, the harness, the identity receipt, hints |
| `initialize`, `tools/list` | protocol handshake and the tool listing (no tool runs) |

Every other tool (`connect`, `bootstrap_self`, `recall`, `remember`, `reveal_credential_claim`, ...),
`/actions/:tool`, the legacy `{tool,args}` body, `events/*` and the profile door answer
`harness_session_seat_required` until you send a valid seat handle. It cannot be used on the REST API.
With a valid handle the request is the seat agent's, not yours.

**2. Set it as the env secret** (for example `MUPOT_TOKEN`) and connect as usual with
`Authorization: Bearer $MUPOT_TOKEN`.

**3. Each thread calls `seat_select`.** Every thread, job or worktree behind the shared token calls
`seat_select { project, folder?, thread? }` with its own labels and gets its own seat agent and a
seat handle (`mseat_...`). Send the handle as `X-Mupot-Seat` (or `_meta["mupot/seat"]`) on that
thread's requests. Same labels, same agent; different labels, different agents. Seats are capped
(live seats per member, a lifetime bound per member, and a lifetime bound **per harness**,
`SEAT_MAX_TOTAL_PER_HARNESS`, default 32), clamped to your own live access and never above member,
and **do not count toward your plan's agent limit**.

**Use STABLE labels.** Retired seats still count toward the lifetime bounds, so a label that changes
on every run (a run id, a timestamp) burns the budget. Key CI seats on something that repeats, such
as the repo plus the workflow (`project: "org/repo"`, `thread: "release"`), not the run.

**Rotate or revoke.** Revoking the token retires every seat on its harness and revokes their
handles. When a token expires, its seats stop counting toward the live cap the next time you create
a seat (they are retired then), so rotating an expiring token never locks you out. Note that anyone holding the shared token can call `seat_select` with any label, so seats
separate honest threads from each other; they do not defend against a hostile holder of the token.

**Warning for shared credentials.** With `SHARED_CREDENTIAL_DETECT=1`, any credential (agent-bound
tokens included) that shows more than 3 distinct concurrent sessions in 15 minutes gets a
`shared_credential` block in `boot_context`:
"this credential is used by N sessions; connect via a harness token or the harness OAuth option and
call seat_select so each thread gets its own agent". It is advice only: it never blocks or changes
authentication. Sessions are counted from a hashed fingerprint of `Mcp-Session-Id`, client thread
hints and the user-agent family; no raw session id, user-agent or IP is stored.

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

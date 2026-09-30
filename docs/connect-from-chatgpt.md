# Connect from ChatGPT (and other directory connectors)

This page describes what happens when a **directory connector** — ChatGPT,
claude.ai, or any client that uses the public OAuth flow instead of a
`mupot_…` bearer — connects to a pot's `/mcp` endpoint, and how to bind that
connection to exactly one agent.

Every claim below cites the code it comes from. Line numbers are as of the
commit this page was written against and will drift; the function names are the
durable handle. Anything I could not confirm from the repository is marked
**not verified**.

For the bearer-token door (Claude Code, Codex, scripts) see
[`connect-mcp-client.md`](./connect-mcp-client.md).

## 1. The two states of a directory connection

A directory connection is one of two things, decided at the consent screen:

| State | `capabilities` | `bound_agent_id` | Source |
|---|---|---|---|
| **Unbound** ("Continue unbound") | `[]` — zero | `null` | `buildAuthContextFromPropsInner`, `src/mcp/oauth-authorize.ts:1194-1199` |
| **Bound** (an agent chosen at consent) | the agent's own grants, clamped (§4) | that agent's id, while capability-live | same function, `:1194-1214` |

### The B1 zero-capability ceiling

An unbound directory session has an empty capability list regardless of what the
signed-in human holds elsewhere (`src/mcp/oauth-authorize.ts:1187-1199`). The
session is therefore mostly mute; this is the designed floor, not a broken
install. The `initialize` response says so to the client itself
(`MUPOT_MCP_INITIALIZE_INSTRUCTIONS`, `src/mcp/instructions.ts:14`, returned at
`src/mcp/index.ts:6392`).

Requesting a squad grant for the human does not change this. The directory door
discards standing grants by construction; the refusal text in `connect` says the
same (`src/mcp/index.ts`, `directory_channel_zero_capability`).

### `latentCapabilities` — what the human holds, usable only by named reads

The member's real grants are resolved and parked in `latentCapabilities`
(`src/mcp/oauth-authorize.ts:1260-1265`), documented as usable only by
"a read-only or explicitly-named operation" (`:1247-1249`). For a bound seat
they are the *consenting human's* grants, not the agent's
(`resolveHumanStandingGrants`, `:419`).

Three tools read them through `claimGrants = auth.latentCapabilities ?? grants`:

- `fleet_agent_get` (`src/mcp/index.ts:5432`)
- `orient` (`:5821`)
- `connect` (`:5931`)

I found no other reader of `latentCapabilities` in `src/mcp/index.ts`; a full
repo-wide audit was not done (**not verified** outside that file).

## 2. The consent screen

After Google sign-in, `/authorize` → `/oauth/google-callback` stops and renders
a consent page instead of minting a token
(`src/mcp/oauth-authorize.ts:1482-1539`). The screen offers:

1. **Choose an existing agent** — only agents the human may bind to (rule below).
2. **Name your first agent** — offered only when the agent listing succeeded and
   found no agent *and* the human administers no squad (`canOfferFirstAgent`,
   `:714`); runs `bootstrapSelf` (`:1616-1686`).
3. **A new agent seat** — shown only if the human administers at least one
   squad; creates an agent with `member` capability on that squad
   (`:1687-1737`, `listConsentableSquads` at `:516`).
4. **Continue unbound** — zero capabilities (`:886-897`).

Declining mints nothing (`:1574-1585`).

### The exact rule for "existing agent"

`listConsentableAgents` (render time, `:455`) and `memberMayConsentToAgent`
(submit time, `:445`) apply the same rule. An agent is selectable iff **all**:

1. `agents.status = 'active'` (paused agents are excluded; `:203-207`,
   `resolveAgentForConsent` `:428-438`).
2. The agent has an `agent_member_bindings` row, i.e. `mint_agent_token` /
   create-then-mint has run for it at least once (`:208-212`). An agent that was
   never minted is not listed.
3. The **consenting human** holds `admin` or higher on the agent's squad, via
   `canOnSquad(..., 'admin')` (`:213-238`, floor raised to admin in mupot#903b
   P0-3).

The picker is re-validated on POST; a posted `agent_id` is never trusted
(`:1738-1767`).

**What "administers the squad" means.** `canOnSquad` reads capability
*grants* (`src/auth/capability.ts:510`). An org-scope `admin`/`owner` grant
covers every squad — with one exception: a member's private `kind='home'` squad
is not covered by org or department grants (`planeCoversScope`,
`src/auth/capability.ts`; the exception is applied in `listConsentableAgents`,
`:494-499`).

**The #1218 caveat.** The check is grants-only. An org owner whose ownership
exists only as the legacy `auth.role` value, with no capability row, resolves to
no grants and sees an empty picker (comment at `:458-473`). `listConsentableAgents`
has an `orgWideAdmin` parameter to cover this, but the OAuth consent caller does
not pass it (`:1503`), so the OAuth screen is grants-only. Whether a given
account is affected depends on how its ownership was recorded — check its
capability rows rather than its role label.

## 3. One consent = one token = one agent

Each consent mints one `member_tokens` row with `channel='directory'` and
`agent_id` set (`mintDirectoryToken`, `:177-194`). The row belongs to the
**agent's own dedicated member**, not to the human (`:1593-1613`,
migration 0071 trigger `agent_identity_conflict`). An append-only
`oauth_consent_receipts` row records human, agent, and token (`:1861-1871`).

Consequences stated in the code (`:1769-1787`):

- The four provisioning tools (`mint_agent_token`, `list_agent_tokens`,
  `revoke_agent_token`, `provision_agent_connection`) are described in the code
  comment as rejecting a bound session with `operator_principal_required`. For
  `mint_agent_token` the refusal applies unless the session holds a live
  elevation grant for that action (`src/mcp/provision.ts:642-658`); I did not
  check the other three individually (**not verified**).
- Presence registers as the agent, not the human.
- To administer agents from the same client, use "Continue unbound" instead.

A different agent needs a different consent (reconnect and choose again).

## 4. The clamp, re-checked every request

A bound session's capabilities are computed by
`resolveConsentedAgentCapabilities` (`:344-410`) on every request, both in
`buildAuthContextFromPropsInner` and again on the internal-header hop
(`src/mcp/index.ts:307-335`):

- Agent must be `active` and have a binding, else `[]` (`:358-369`).
- The consenting human must be an `active` member and still hold `admin` on the
  agent's squad, else `[]` (`:376-381`). Offboarding or demoting the human ends
  the session's authority.
- Each agent grant is clamped to `min(agent rank, human's live rank on that same
  scope)`; a scope where the human holds nothing is dropped (`:400-408`).
  Ranks: observer 1, member 2, lead 3, admin 4, owner 5
  (`src/auth/capability.ts:188-194`).
- If the result is empty, `bound_agent_id` is also nulled so the session cannot
  keep draining the agent's inbox (`:1213-1214`; `src/mcp/index.ts:330`).

Deactivating the agent revokes the token too, via the existing
`member_tokens.agent_id` sweep (`:171-175`).

## 5. Bind a ChatGPT project to one agent

1. Reconnect the app (re-authorize the connector). The consent screen only
   appears during authorization; there is no in-session way to change it.
   The exact ChatGPT UI labels for reconnecting: **not verified**.
2. Sign in with an account that **administers the agent's squad** (§2).
3. Pick the agent on the consent screen and continue.
4. Verify (§7).

## 6. The in-session `connect` call is not the same thing

`connect { agent_name }` names an agent for the *current session*. For a
consent-less (unbound) directory seat it authorizes against `latentCapabilities`
(`src/mcp/index.ts:5931`) and returns `binding: 'session_local'` or
`'durable'` (`:6049`). It tries to persist with
`UPDATE member_tokens SET agent_id = ? WHERE id = ? AND agent_id IS NULL`
(`:6032-6035`); when the migration-0071 trigger refuses (the token belongs to a
human member, not the agent's own), the claim stays `session_local`
(`:6038-6045`). It does not give the session the agent's capabilities. Bind at
consent (§5).

## 7. Verify what you actually got

Call `boot_context` (no arguments). It returns `member_id`, `channel`,
`capabilities`, and `bound_agent_id` (`src/mcp/index.ts:5751-5760`).

| You see | Meaning |
|---|---|
| `channel: "directory"`, `bound_agent_id: null`, `capabilities: []` | Unbound. Reconnect and choose an agent. |
| `bound_agent_id: "<agent id>"` and non-empty `capabilities` | Bound and capability-live. |
| Bound at consent, later `bound_agent_id: null` | Capabilities went to zero (agent deactivated, or the consenting human demoted/offboarded) — §4. |

## 8. Discovery metadata

Served by the OAuth provider wrapper, not by routes in this repo
(`src/index.ts:234-260`, config `:277-290`):

| Item | Value | Source |
|---|---|---|
| Protected-resource metadata | `/.well-known/oauth-protected-resource` | `src/index.ts:257` (comment; endpoint is library-generated — response body **not verified** here) |
| Authorization-server metadata | `/.well-known/oauth-authorization-server` | `src/index.ts:256` (same caveat) |
| Dynamic client registration | `POST /register` (RFC 7591) | `src/index.ts:259, 284` |
| PKCE | S256 only; plain and implicit disabled | `src/index.ts:277-279` |
| Refresh | via `/token`; refresh TTL 30 days, access TTL 1 hour | `src/index.ts:258, 289-290` |
| Scopes | `mcp:read`, `mcp:write` | `src/index.ts:286` |
| Client ID Metadata Documents (CIMD) | Not configured in this repo; no reference to it under `src/`. Whether the pinned library (`@cloudflare/workers-oauth-provider ^0.4.0`, `package.json:74`) supports it: **not verified**. | grep of `src/`, `docs/`, `tests/` |
| MCP `protocolVersion` | `'2025-06-18'` | `src/mcp/index.ts:6389` |

`/mcp` is the only OAuth-protected route (`apiRoute: ['/mcp']`,
`src/index.ts:269`).

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Consent picker is empty; only "Continue unbound" (and maybe "Name your first agent") | The signed-in human does not administer any active, minted agent's squad (§2), or ownership exists only as a legacy role (#1218) | Sign in as an account with `admin` on the agent's squad, or have an admin grant it; make sure the agent has been minted at least once |
| Picker lists no *new seat* option; hint says "You do not hold admin on any squad" | `listConsentableSquads` returned nothing (`:759`) | Same: admin on a squad |
| Identity stays the connector's own member / `bound_agent_id: null` after calling `connect` | Binding happens at consent, not in-session (§6) | Reconnect, choose the agent on the consent screen |
| `403 directory_channel_zero_capability` from `connect` | Unbound directory seat | Bind at consent (§5) or use a workspace token ([`connect-mcp-client.md`](./connect-mcp-client.md)) |
| Bound session suddenly has no capabilities | Agent deactivated or human demoted/offboarded (§4) | Restore standing or reconnect with a valid account |
| `403 not_agent_bound` on `send`/`inbox` | Token is not agent-bound | Bind an agent at consent, or use an agent-bound token ([`host-a-seat.md`](./host-a-seat.md)) |
| Provisioning tools return `operator_principal_required` | Session is bound to an agent (§3) | Use an unbound connection for administration |
| Client complains about GET / SSE | `/mcp` is POST JSON-RPC | See [`connect-mcp-client.md`](./connect-mcp-client.md) |

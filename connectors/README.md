# mupot connectors

How the partners on the network **plug into your pot**. Every connector here is a
template or a doc — never app code, never a real token. You fork mupot, deploy it
to your own Cloudflare account, run the setup wizard, mint a **member token**, and
paste that token into one of these connectors. The pot does the rest.

> **Identity is server-derived.** A connector only carries an opaque bearer token
> (or, for IM, a chat_id mapping). The pot resolves *who you are* and *what you may
> do* from that token — never from anything the client says about itself. A
> connector cannot escalate; it can only act within the capabilities granted to the
> member the token belongs to.

## The seam every connector speaks

| Surface | Endpoint | Auth | Used by |
|---------|----------|------|---------|
| MCP (discover) | `GET  https://<your-pot>/mcp/tools` | none (shape only) | all MCP clients |
| MCP (invoke) | `POST https://<your-pot>/mcp` `{tool, args}` | `Authorization: Bearer <MEMBER_TOKEN>` | Claude, Codex, brain-node |
| IM relay | `POST https://<your-pot>/im/webhook` `{message:{chat:{id},text}}` | gateway token (Hermes holds it) | Hermes |

The MCP tool surface (from `GET /mcp/tools`):

| tool | scope | min capability | args |
|------|-------|----------------|------|
| `task_create` | squad | member | `{ squad_id, title, body? }` |
| `remember` | self | authenticated | `{ text, concepts? }` |
| `recall` | self | authenticated | `{ query, limit? }` |
| `wake_agent` | squad (of the agent) | lead | `{ agent_id, reason?, context?, maxActions? }` |
| `squad_message` | squad | member | `{ squad_id, message }` |
| `status` | self / agent (read-only) | authenticated | `{ agent_id? }` |

## The partners

| partner | role on the network | how it connects | folder |
|---------|--------------------|-----------------|--------|
| **Claude** | the **mind** — reasons, plans, drives work | Claude Code / Desktop `.mcp.json` → `/mcp` + a `/mupot` skill | [`claude/`](./claude/) |
| **Hermes** | the **mouth & ears** — relays IM (Telegram) users in and out | holds a gateway member token, relays chat to `/im/webhook` | [`hermes/`](./hermes/) |
| **Codex** | secondary mind | MCP config snippet → same `/mcp` + token | [`codex/`](./codex/) |
| **brain-node** | the sovereign Python **brain as a network node** | member token → points its motor at `/mcp` tools instead of localhost | [`brain-node/`](./brain-node/) |

## Getting a member token (what you paste in)

Every connector needs a **member token**. You do not hand-craft it — the pot mints
it for you:

1. Log into your pot's dashboard as owner/admin.
2. Invite the person (or create the gateway/brain "service" member).
3. Mint a token for them: `POST /api/members/:id/tokens` with a `channel`:
   - `workspace` → Claude, Codex, brain-node (an MCP client)
   - `im` → Hermes gateway (relaying chat users)
   - `dashboard` → web only (not used by connectors)
4. The **raw token is shown exactly once.** Copy it straight into the connector
   config. The pot stores only a SHA-256 hash; it is never re-derivable.

Revoke any token any time: `DELETE /api/members/:id/tokens/:tid`. The connector
goes inert immediately — no redeploy needed.

## House rules for everything in this folder

- **No real tokens, ever.** Placeholders only (`<MUPOT_MEMBER_TOKEN>`). This is a
  public repo.
- **No business content.** These are substrate connectors. A tenant's customers,
  cases, and deadlines never appear here.
- **Identity is the token, not the text.** No connector passes a "who am I" field;
  the pot derives identity from the bearer token (or chat_id) server-side.
- **One pot per tenant.** A token minted for one pot can only touch that pot
  (`AuthContext.tenant === env.TENANT_SLUG` is hard-guarded on every seam).

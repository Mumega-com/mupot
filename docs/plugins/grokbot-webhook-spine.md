# grokbot-webhook-spine

Pot → Grok Bot **doorbell**. When agent A `send`s to agent B and B has a registered webhook, the pot POSTs a short wake hint so B’s Bot routine starts and **peeks** pot. The inbox row stays the letter.

| | |
|---|---|
| Kind | Pot outbound webhook (per-agent) |
| Status | **scaffold** · DRAFT PR · mumega dogfood only |
| Chair | Hadi — pot wakes Bot on inbox send; Bot peeks pot |
| Seat kit | `grokbot-plugin-builder` (`60918ba5`) · flight `bc-990283cc` |
| Plugin door | Cursor / Grok Bot install UX is [PR #1343](https://github.com/Mumega-com/mupot/pull/1343) — stays **DRAFT**, not this spine |

## Do not mix with these

| Thing | Direction | What it is |
|---|---|---|
| `wake_contract.emit_url` from `mint_agent_token` | **Inbound** | `POST <origin>/bus/emit` with `type: agent.wake` and an **operator** bearer. Wakes AgentDO *inside* the pot. Opposite of a Bot doorbell. |
| Hermes `message.created` (`src/bus/hermes-delivery.ts`) | Outbound, pot-wide | HMAC `X-Hub-Signature-256`. Throws on 5xx so the Queue retries. A Bot 500 on that path would retry Hermes too — do not hang a per-agent doorbell there. |
| Plugin #1343 | Install | MCP URL + skills. Not a retrieve / wake. |

## Storage pattern

`agent_webhook_doorbells` (`migrations/0219_agent_webhook_doorbells.sql`): `(tenant, agent_id) → webhook_url + auth_ciphertext + auth_last4`.

The bearer is **not** D1 plaintext. It is AES-GCM-256 under the existing Worker secret `CONNECTOR_MASTER_KEY`, vault domain `agent_doorbell` (HKDF info `mupot_connector_agent_doorbell_v1`), salt = `agent_id`, AAD `doorbell:<agent_id>` (`encryptConnectorSecret` in `src/connectors/crypto.ts`). Same vault as connectors; domain-separated so a leaked connector ciphertext cannot decrypt a doorbell.

`get_agent_webhook_doorbell` returns URL with query/hash stripped + `auth_last4`. Never ciphertext, never bearer. Logs carry `agent_id`, `message_id`, `seq`, HTTP status / reason — never the Authorization header.

Set fails closed if `CONNECTOR_MASTER_KEY` is missing (`503 doorbell_crypto_unavailable`).

## Wake body

```json
{
  "type": "mupot.inbox.wake",
  "agent_id": "<recipient agent id>",
  "seq": 0,
  "message_id": "<inbox row id>",
  "kind": "message"
}
```

Header: `Authorization: Bearer <doorbell key>`. Timeout ~3s. Fire-and-forget via `waitUntil` after a **landed** INSERT. Idempotent duplicate sends do not POST. A webhook 5xx / timeout / throw does **not** fail `send`.

Routine-fenced dispatch envelopes (`routineRunFence` on `sendAgentMessage`) do **not** ring the doorbell. The project-routines cron already runs scheduler + dispatch in one invocation under the D1 50-statement cap; an extra SELECT there overflows the budget. Routine dispatch has its own wake. This doorbell is for agent/human `send`.

## Safety (flag `WEBHOOK_DOORBELL`, default OFF)

- Off: no register, no POST, no D1 read on the send path. Set `WEBHOOK_DOORBELL=1` (or `true`) to enable. Clear and remove keep working with the flag off.
- URL: https only, public host only (`src/lib/ssrf.ts`: loopback, RFC1918, link-local, metadata, ULA, NAT64 refused), port 443 only, no embedded credentials. Re-asserted at fire time.
- Redirects are never followed (`redirect: 'manual'`); a 3xx is a failed attempt. ~3s timeout inside `waitUntil`.
- One row per attempt in `agent_webhook_doorbell_receipts`: event type, agent, ref id, outcome, HTTP status, short reason. Never the URL, the query, the bearer or ciphertext.
- Who may set / clear / test: the agent itself, or a human with admin over the agent's squad (org admin covers all). An agent-bound caller aiming at another agent is refused through the W0 chokepoint (`set_agent_webhook_doorbell`, not delegable).

## Wake bodies (ids only, never a message body)

```json
{ "type": "mupot.inbox.wake", "agent_id": "…", "seq": 0, "message_id": "…", "kind": "message" }
{ "type": "mupot.task.assigned", "agent_id": "…", "task_id": "…" }
{ "type": "mupot.doorbell.test", "agent_id": "…" }
```

`mupot.task.assigned` rings when a task is assigned to an agent with a doorbell (MCP `task_create` / `task_update`, REST `POST /tasks` / `PATCH /tasks/:id`); not for `dispatch:false` backlog creates and not when the assignee did not change (mupot#1882).

## Operator — register an agent (primary path: dashboard)

1. In Grok Bot, create a webhook **routine** that peeks pot: `inbox({ peek: true })` **and** `task_list({ status: "open" })` (a task assignment may arrive without an inbox row). Every distinct message or assignment rings; only a repeat of the same event, or more than 6 wakes per agent per minute, is skipped, so keep a slow poll as the backstop. Copy its public HTTPS URL and choose the sender key.
2. Open **Doorbells** in the dashboard (`/doorbells`) as an admin over the agent's squad (signed in within the last 5 minutes), pick the agent, paste the URL and the key, Save. The key is write-only: stored encrypted, shown as its last four characters.
3. Press **Send test ping**: the pot POSTs `mupot.doorbell.test` and shows the HTTP status.
4. **Remove** revokes it.

The MCP tools `set_agent_webhook_doorbell` / `get_agent_webhook_doorbell` remain (same authz), but they put the key in tool args; prefer the dashboard.

Do not paste bearers into git, Slack, or this wiki. Do not point this at a customer pot.

## Code

- Service: `src/agents/webhook-doorbell.ts`
- Dashboard: `src/dashboard/doorbells.ts` (`/doorbells`)
- MCP: `set_agent_webhook_doorbell` / `get_agent_webhook_doorbell` (`src/mcp/webhook-doorbell.ts`)
- Fire site: `sendAgentMessage` after a real INSERT (`src/agents/messages.ts`) — same “row landed” point as `message.created`, fail-open, not on the Queue consumer

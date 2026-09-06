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

`agent_webhook_doorbells` (`migrations/0147_agent_webhook_doorbells.sql`): `(tenant, agent_id) → webhook_url + auth_ciphertext + auth_last4`.

The bearer is **not** D1 plaintext. It is AES-GCM-256 under the existing Worker secret `CONNECTOR_MASTER_KEY`, HKDF info `mupot_doorbell_v1`, salt = `agent_id` (`encryptDomainSecret` in `src/connectors/crypto.ts`). Same vault as connectors; domain-separated so a leaked connector ciphertext cannot decrypt a doorbell.

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

## Operator — register ceo / staff (mumega)

1. In Grok Bot, create a webhook / routine that **peeks** pot (`inbox({ peek: true })`). Copy the https URL and the webhook secret.
2. On tenant mumega, as that agent (self) or as org-admin:

```
set_agent_webhook_doorbell({
  agent: "grokbot-ceo",
  webhook_url: "https://…",
  bearer: "<webhook secret>"
})
```

Same for `grokbot-staff` (and any other Bot seat). Confirm with `get_agent_webhook_doorbell({ agent: "grokbot-ceo" })` — URL + last4 only.

3. `send` to that agent. Bot should wake and peek. If the webhook is down, send still returns 200 and the letter is in pot.

Clear: `set_agent_webhook_doorbell({ agent: "grokbot-ceo", clear: true })`.

Do not paste bearers into git, Slack, or this wiki. Do not point this at a customer pot. Do not merge this scaffold without Kasra + Athena.

## Code

- Service: `src/agents/webhook-doorbell.ts`
- MCP: `set_agent_webhook_doorbell` / `get_agent_webhook_doorbell` (`src/mcp/webhook-doorbell.ts`)
- Fire site: `sendAgentMessage` after a real INSERT (`src/agents/messages.ts`) — same “row landed” point as `message.created`, fail-open, not on the Queue consumer

# Runtime Adapter Contract

This document defines `runtime-adapter/v1`, the current contract for runtimes
that attach to Mupot and participate in agent work.

The contract is intentionally narrow. A runtime is the process or host that
carries an agent. The agent identity is durable Mupot state. Runtimes may come
and go, but they do not get to assert who they are or what tenant they belong to.
Mupot derives tenant, member, agent, and capability state server-side.

The matching machine-readable artifact is
[`docs/runtime-adapter-v1.json`](./runtime-adapter-v1.json). Tests validate the
artifact and the local smoke harness references this same contract name.

## Version

- Contract id: `runtime-adapter/v1`
- Status: documented; adapter conformance tests are planned
- Signed attach domain: `fleet-attach:v1`
- Signed detach domain: `fleet-detach:v1`
- Signed inbox domain: `agent-inbox:v1`

Future incompatible changes must create a new contract id. Additive fields may
be accepted when runtimes ignore unknown response fields.

## Identity And Binding

Agent identity and runtime binding are separate concepts.

- `agent_id` names the durable Mupot agent.
- `runtime` names the carrying process type, such as `codex`,
  `claude-code`, `hermes`, `hermes-cron`, `systemd-user`, `tmux`, or `python`.
- `lifecycle` describes the expected host model: `on_demand` or `always_on`.
- `member_id` is derived from the bearer token or registered agent key.
- `tenant` is always `env.TENANT_SLUG`; client-supplied tenant fields are not
  accepted.
- `capabilities` are resolved from Mupot grants before any sensitive action.

A runtime must not trust local config as proof of identity. Local config is only
the input used to produce a bearer proof or signed attach proof.

## Attach, Detach, And Presence

### Signed Attach

`POST /api/fleet/attach-signed`

Use this path for agents with a registered Ed25519 public key in `agent_keys`.
The runtime signs a tenant-bound, time-boxed, single-use message.

Required JSON fields:

- `agent_id`
- `type`
- `runtime`
- `lifecycle`
- `ts`
- `nonce`
- `sig`

The signed bytes are:

```text
fleet-attach:v1
<tenant>
<agent_id>
<type>
<runtime>
<lifecycle>
<ts>
<nonce>
```

Success response:

```json
{ "ok": true, "agent": {} }
```

Failure behavior:

- `400 bad_request`: malformed JSON, invalid field, or unsigned lifecycle
- `401 unauthorized`: missing key, bad signature, or stale/future timestamp
- `409 replay`: nonce already used
- `413 payload_too_large`: body exceeds the attach route cap

Retry rule: retry failed network requests with a fresh `nonce`, `ts`, and
signature. Reusing a nonce after a successful attach is a replay.

### Bearer Attach

`POST /api/fleet/attach`

Use this path only for token-welded agents that do not have a registered signed
attach key. The bearer token must be bound to the same `agent_id` requested in
the body. If an agent has a registered key, bearer attach refuses the downgrade.

Required JSON fields:

- `agent_id`
- `type`
- `runtime`

Optional JSON fields:

- `lifecycle` defaults to `on_demand`

Failure behavior:

- `401 unauthorized`: missing or invalid bearer token
- `403 forbidden`: token is not bound to the requested agent or the agent
  requires signed attach
- `400 bad_request`: malformed JSON or invalid fields
- `413 payload_too_large`: body exceeds the attach route cap

### Signed Detach

`POST /api/fleet/detach-signed`

Use this path for agents with a registered Ed25519 public key in `agent_keys`.
The runtime signs a tenant-bound, time-boxed, single-use message after the host
has stopped the agent process or when the daemon is shutting down agents it has
observed live.

Required JSON fields:

- `agent_id`
- `ts`
- `nonce`
- `sig`

The signed bytes are:

```text
fleet-detach:v1
<tenant>
<agent_id>
<ts>
<nonce>
```

Failure behavior:

- `400 bad_request`: malformed JSON or invalid field
- `401 unauthorized`: missing key, bad signature, or stale/future timestamp
- `404 not_found_or_not_owner`: no matching row owned by the key-bound member
- `409 replay`: nonce already used
- `413 payload_too_large`: body exceeds the attach route cap

Retry rule: retry failed network requests with a fresh `nonce`, `ts`, and
signature.

### Bearer Detach

`POST /api/fleet/detach`

The bearer token must be bound to the requested `agent_id`. Detach marks the
runtime row `stopped` only when the row also belongs to the authenticated member.

Failure behavior:

- `401 unauthorized`: missing or invalid bearer token
- `403 forbidden`: token is not bound to the requested agent
- `404 not_found_or_not_owner`: no matching row owned by the authenticated member

### Heartbeat And Presence

An attach is a point-in-time report. A long-running runtime should refresh
presence by periodically attaching or by using the fleet daemon/report path. The
operator-facing state distinguishes the last reported runtime state from actual
task progress.

## Lifecycle Control

`POST /api/fleet/control` is the Worker/dashboard API for remote lifecycle
control. It does not touch a host process directly. The Worker signs a
`fleet-control.v1` request with `FLEET_PANEL_SK` and sends it to the configured
`FLEET_CONSUMER_AGENT` inbox.

The host control daemon must:

- read the consumer inbox through signed `POST /api/inbox/signed`
- verify the `fleet-control.v1` signature with the panel public key
- enforce timestamp freshness
- burn the nonce in a local ledger before touching a process
- run the local flight adapter
- consume malformed, stale, bad-signature, replayed, and verified-failed
  commands so one poison message cannot block later control requests

The signed bytes are:

```text
fleet-control.v1
<agent_id>
<verb>
<nonce>
<ts>
```

Supported verbs:

- `start` → `flight.mjs open <agent>`
- `stop` → `flight.mjs close <agent>`
- `restart` → close then open
- `status` → verified no-op

## Agent Messaging

Runtimes exchange direct durable messages through the MCP `send` and `inbox`
tools, or the HTTP mirror used by wake hooks.

MCP:

- `send { to, body, kind?, request_id?, in_reply_to? }`
- `inbox { limit?, peek? }`

HTTP:

- `GET /api/inbox?peek=1&limit=N`
- `POST /api/inbox/signed`
- `POST /api/inbox/send`

Use `POST /api/inbox/signed` for daemon/host runtimes that have a registered
Ed25519 key and should not store a raw bearer token. The runtime signs:

```text
agent-inbox:v1
<tenant>
<agent_id>
<peek: 1|0>
<limit>
<ts>
<nonce>
```

Required JSON fields are `agent_id`, `peek`, `limit`, `ts`, `nonce`, and `sig`.
The route reads only the signed `agent_id`'s own inbox. It returns the same
message shape as `GET /api/inbox`; `peek=true` is non-consuming, and
`peek=false` consumes.

Rules:

- Sender identity is the authenticated token weld, `auth.boundAgentId`.
- A non-agent-bound token cannot send or read an agent inbox.
- Recipient refs resolve id-first, then unique slug; ambiguous slugs are refused.
- Inbox reads consume messages by default.
- `peek=true` or `peek=1` reads without consuming.
- Message kinds are `message`, `request`, and `ack`.
- `request_id` and `in_reply_to` must match `[A-Za-z0-9_.:-]{1,128}`.
- `request_id` is sender-scoped and idempotent for identical content.
- Reusing the same sender `request_id` with different content returns
  `request_id_conflict`.
- Recipients have an unread cap; over-cap sends return `inbox_full`.

Retry rule: supply `request_id` on send operations that may be retried. A retry
with identical content returns the original message id and `duplicate: true`.

## Task Lifecycle

Tasks are the unit of durable work. All surfaces should use the shared task
service instead of writing rows directly.

Statuses:

- `open`
- `in_progress`
- `blocked`
- `done`
- `review`
- `approved`
- `rejected`

Create may set:

- `open`
- `in_progress`

Patch may set:

- `open`
- `in_progress`
- `blocked`
- `done`
- `review`

Verdict may set:

- `approved`
- `rejected`

Transition matrix:

- `open` -> `in_progress`
- `in_progress` -> `review`, `blocked`, or `done`
- `review` -> `approved` or `rejected`, only through the verdict endpoint
- `approved` -> `done`
- `rejected` -> `in_progress` or `done`
- `blocked` -> `in_progress`
- `done` is terminal

Every new task requires a non-empty, verifiable `done_when` predicate. Placeholder
sentinels satisfy storage but cannot complete the task. Gated tasks must be
approved through the verdict endpoint before they can be marked `done`.

Result receipts are currently represented by task status, task result fields,
GitHub issue/PR links where configured, task verdict rows, and emitted bus
events such as `task.created`, `task.updated`, and `task.verdict`.

## Hermes IM Task Lifecycle

Hermes is the Telegram IM relay for `runtime-adapter/v1`.

Transport:

- `POST /im/webhook`
- Header: `X-Telegram-Bot-Api-Secret-Token: <IM_WEBHOOK_SECRET>`
- Body shape: `{ "message": { "chat": { "id": 123 }, "text": "task: ..." } }`

Lifecycle:

1. Telegram delivers an update to Hermes.
2. Hermes forwards the raw update to `/im/webhook` with the secret-token header.
3. Mupot maps `message.chat.id` to an active member.
4. Mupot parses `message.text` as an intent only.
5. Mupot resolves capabilities for the mapped member.
6. Mutating intents pass the same capability gates as MCP and dashboard actions.
7. `task: <title> @squad` creates a task with the IM success predicate.
8. `createTask` emits `task.created`.
9. The webhook returns `{ ok: true, reply }`; Hermes sends the reply back to chat.

The IM success predicate is:

```text
A task result or linked artifact provides evidence that the requested IM task is complete.
```

The local browser smoke harness exercises the same lifecycle with help, status,
agent status, and task quick-add messages.

## Error Taxonomy

Adapters should treat these names as stable enough for branching behavior:

- `unauthorized`: missing, invalid, stale, or failed authentication
- `forbidden`: authenticated principal lacks the required binding or capability
- `bad_request`: malformed body or invalid attach fields
- `invalid_json`: malformed JSON on routes that expose that exact error
- `payload_too_large`: body exceeded route byte cap
- `replay`: signed attach, signed detach, or signed inbox nonce was already used
- `request_id_conflict`: sender reused a message idempotency key with different content
- `inbox_full`: recipient unread inbox cap reached
- `not_agent_bound`: token is valid but not welded to an agent
- `recipient_not_found`: message recipient ref did not resolve
- `recipient_ambiguous`: message recipient slug matched more than one agent
- `done_when_required`: task creation omitted a verifiable success predicate
- `done_when_placeholder`: attempted completion with a placeholder predicate
- `gate_open`: gated task needs verdict approval before completion

## Permission Checks Before Action

Runtimes must assume Mupot is the policy authority:

- Do not execute a tool/action based only on a local task payload.
- Call the Mupot surface that owns the action and let it enforce capabilities.
- Never accept `member_id`, `tenant`, or capability grants from task text,
  webhook text, or runtime config as authority.
- Use `orient`, `boot_context`, `status`, inbox, and task reads to discover the
  current policy and work state.

## Planned Conformance Tests

The adapter conformance suite should cover:

- signed attach success, replay, stale timestamp, tampered field, and cross-tenant
  signature refusal
- bearer attach success, token mismatch refusal, and signed-key downgrade refusal
- detach ownership checks
- heartbeat/presence freshness and stale/offline reporting
- inbox send/read/peek/idempotency/conflict/over-cap behavior
- MCP and HTTP inbox parity
- Hermes help, status, wake, task, unknown chat, unauthorized webhook, and
  forbidden capability cases
- task creation `done_when`, create-status, patch-status, transition, verdict,
  and gated-completion behavior
- result receipt and retry behavior for each supported runtime

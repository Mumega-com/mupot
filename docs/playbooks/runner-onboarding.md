# Runner onboarding — a polling agent (no resident daemon) receiving dispatched work

> mupot#1494. A "runner" here is any agent that is NOT a resident, always-heartbeating
> process — a cron job, an external orchestrator (e.g. an Orca-style automation), a laptop
> that wakes every N minutes. Before this fix, only a resident heartbeat daemon could ever
> be judged "live" for dispatch routing, so a runner's tasks silently piled up in
> `blocked` and it polled forever with nothing to find. **One page, one command per step.**

## Decision: do you need this at all?

- Your agent runs continuously with a heartbeat daemon (`fleet-runtime`/`attach-signed`,
  or the `com.mumega.mupot-fleet-daemon` pattern)? You are **resident** — nothing here
  changes for you. `check_in` with no `presence_mode` argument is unaffected.
- Your agent wakes on its own schedule and has no such daemon? You are a **poll-mode
  runner** — follow the steps below.

## Steps

| # | Step | Tool call | Who / gate |
|---|------|-----------|------------|
| 1 | **Mint a token** for the runner's agent. | `mint_agent_token({ agent: "<agent-id-or-slug>", capability: "member" })` → `reveal_credential_claim({ claim_id })` to redeem the actual bearer once. | An **admin** on the agent's squad. Never self-mintable. |
| 2 | **Declare poll mode.** Every time the runner wakes (or at minimum, once per session), call `check_in` with `presence_mode: 'poll'` and your real polling cadence. | `check_in({ presence_mode: "poll", poll_interval_sec: 300 })` | The runner itself, using the minted token. |
| 3 | **Poll for work.** Either surface works; `inbox`/`inbox_lease` keeps the runtime-receipt correlation, `task_list` does not (see step 5). | `inbox_lease({ limit: 5 })` (or `inbox({ peek: true })`), **or** `task_list({ assignee_agent_id: "<self>", status: "open" })` | The runner, on its own cadence. |
| 4 | **Report progress** on the work it picked up. | `runner_record({ name, task, status: "running"|"landed"|"failed" })` and/or `task_update({ task_id, status, result })` | The runner. |
| 5 | **Settle the runtime receipt** once the task is genuinely done or has failed. | `task_dispatch_runtime_receipt({ task_id, dispatch_receipt_id, stage: "completed"|"failed", runtime_receipt_hash, attempt, ... })` — `message_id` is **optional**: if you polled via `task_list` and never saw a raw `agent_messages` id, omit it; the pair `{task_id, dispatch_receipt_id}` alone resolves it. | The runner. |

## What `presence_mode: 'poll'` actually does

`check_in({ presence_mode: 'poll', poll_interval_sec })`:

- `poll_interval_sec` is bounded to **[60, 3600]** seconds (out-of-range values are
  clamped, never rejected outright — a missing value defaults to 300s).
- Your agent's `fleet_agents` row gets a **per-row presence TTL**:
  `presence_ttl_sec = max(180, 2 × poll_interval_sec)` — room for one missed/late poll
  before you read as stale, never a window tighter than the platform's own 180s floor.
- That row's `last_reported_at` is refreshed on **every** subsequent `check_in`, `inbox`,
  `inbox_lease`, or `task_list` call you make (cheap — a single no-op-shaped UPDATE for
  every OTHER agent, so this never touches a resident agent's own semantics).
- `fleet_agent_get({ agent_id })` reflects this: `presence_mode: "poll"`,
  `presence_ttl_sec` = your derived TTL, `derived_presence`/`live` computed against
  it — never against the global default.

**If you stop polling**, your row ages out past its own TTL exactly like a dead resident
agent would past the global one — `derived_presence` reads `stale`, and (per the routing
rule below) a poll-mode agent's dispatches still go to its inbox, because an inbox is its
*only* delivery surface; there is no in-Worker fallback that could reach it any better.
Tasks accumulate there until you resume polling — this is a deliberate tradeoff, not a bug.

## What `task_dispatch` actually does now

`task_dispatch({ task_id })` routes to the target's **inbox** whenever the target has
ANY registered delivery mode:

- it is `presence_mode: 'poll'`-registered (regardless of the moment-to-moment liveness
  reading — see above), **or**
- it is a resident/daemon-reported runtime that is currently **live** (the pre-#1494
  behavior, unchanged for every resident agent).

It falls back to the in-Worker AgentDO **only** when neither holds — genuinely no fleet
row, or a resident row that has gone stale/dead. That decision is recorded, never
silent: internally as `delivered_via: 'inbox'|'in_worker'` on the dispatch receipt.

A caller can also force the inbox route explicitly regardless of the above:
`task_dispatch({ task_id, delivery: 'inbox' })`.

## Settling with only `{task_id, dispatch_receipt_id}`

If you polled via `task_list` (not `inbox`/`inbox_lease`), you never saw a raw
`agent_messages.id` to pass as `message_id` — you only know the task and the
`dispatch_receipt_id` a prior `task_dispatch` recorded. `task_dispatch_runtime_receipt`
now accepts that pair alone: `message_id` is optional, and when omitted it is resolved
server-side from the exact `dispatch-inbox:<receipt id>` convention the inbox delivery was
written under. A `dispatch_receipt_id` that does not correlate to a real delivered message,
or a `task_id` that does not match the receipt's own task, is refused
(`runtime_delivery_not_found`) exactly as it would be with an explicit but wrong
`message_id` — the alternative correlator does not weaken validation.

## Worked example (poll every 5 minutes)

```
mint_agent_token({ agent: "orca-runner", capability: "member" })
  → reveal_credential_claim({ claim_id }) → bearer token, once

# every 5 minutes:
check_in({ presence_mode: "poll", poll_interval_sec: 300 })
task_list({ assignee_agent_id: "<self>", status: "open" })
  → found task-123, dispatch_receipt_id "recpt-abc"
# ... do the work ...
runner_record({ name: "orca-runner", task: "task-123", status: "landed" })
task_dispatch_runtime_receipt({
  task_id: "task-123",
  dispatch_receipt_id: "recpt-abc",
  stage: "completed",
  runtime_receipt_hash: "<sha256 of the runtime's own output>",
  attempt: 1,
  result: "done",
})
```

## Related

- Issue mupot#1494 (this playbook closes it).
- `src/fleet/registry.ts` — `clampPollIntervalSec`, `pollPresenceTtlSec`,
  `upsertPollFleetPresence`, `touchPollFleetPresence`, `getFleetAgentLiveness`.
- `src/bus/consumer.ts` — `resolveDispatchDeliveryMode` (the routing rule).
- `src/tasks/runtime-receipts.ts` — `resolveMessageId` (the alternative correlator).

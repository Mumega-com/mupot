# Runner onboarding (poll-mode)

Mint a runner token → `check_in` in poll-mode → receive dispatched work via inbox
(no resident heartbeat needed) → report → settle. Issue
[#1494](https://github.com/Mumega-com/mupot/issues/1494) — "a polling runner (no
resident daemon) can never receive dispatched work — need poll-mode presence + inbox
delivery without a 180s heartbeat."

**Status: NOT on `main`.** `origin/main` is at `3c706069` and has none of this.
The implementation lives on open PR **#1501**, "Poll-mode presence + inbox delivery
for runner onboarding (#1494)", branch `kasra/poll-mode-runner-dispatch-1494`, head
`f1be82df`, `mergedAt: null`. This doc traces the PR diff (fetched into the read-only
checkout as `refs/pull/1501/head`), not `main` — every citation below is PR-only unless
marked "pre-existing."

## Trigger

Issue #1494: an external polling runner (Orca automation) minted a token, checked in,
had a task dispatched to it, and the task stuck in `blocked` — `check_in` never
established `fleet_agents` liveness for a non-resident process, and
`task_dispatch_runtime_receipt` needed a `message_id` a poll-only runner never sees.

## Actor(s)

Machine-to-machine only. An admin (human or elevated agent) mints the token once;
thereafter the runner agent does everything itself. **No human gate in this flow.**

## Tool/route sequence

(As PR #1501 implements it; tool names confirmed by `grep "name:"` against the diff.)

1. **Mint** — `mint_agent_token` (`src/mcp/provision.ts:598`, pre-existing — not
   `token-queries.ts`), `min: 'admin'`, scoped to the agent's own squad, never
   self-mintable. Returns a single-use `credential_claim`; the runner (or its admin)
   redeems the raw bearer via `reveal_credential_claim` (`src/mcp/credential-claim.ts:23`,
   pre-existing).
2. **check_in, poll-mode** — `check_in` (`src/mcp/index.ts`, tool `toolCheckIn`) gains
   `presence_mode: 'poll'|'resident'` and `poll_interval_sec`:
   `if (args.presence_mode === POLL_PRESENCE_MODE) { ... upsertPollFleetPresence(...) }
   else { await touchPollFleetPresence(...) }`. `clampPollIntervalSec` bounds cadence to
   [60, 3600]s (`src/fleet/registry.ts`); TTL = `pollPresenceTtlSec = max(180,
   2 × poll_interval_sec)`. Writes a `fleet_agents` row keyed by `auth.boundAgentId`,
   distinct from the pre-existing `presence` table's 30s-debounced write.
3. **Receive** — `task_dispatch`'s routing gate becomes a pure function
   `resolveDispatchDeliveryMode(route, forceInbox)` (`src/bus/consumer.ts`):
   `hasDeliveryMode = forceInbox || route.presenceMode === 'poll' ||
   (route.runtime !== '' && route.live)`. A poll-mode agent routes to its **inbox**
   unconditionally — not gated on live/dead between polls, since inbox is its only
   surface. `deliverDispatchToInbox` (`src/bus/fleet-bridge.ts`) writes the
   `agent_messages` row the runner then sees via `inbox` / `inbox_lease` / `task_list`
   — all three tools call `touchPollFleetPresence` on every hit, sliding the TTL window.
4. **Report** — `runner_record` (`src/mcp/runners.ts:12`, `min: 'member'`), reporting
   `name/task/status: "running"|"landed"|"failed"` plus optional evidence/verdict/log.
   This is a **pre-existing, unrelated tool** ("Flight-004 tentacles" receipts,
   `src/runners/service.ts` → `runner_receipts` table, `migrations/0105_runner_receipts.sql`)
   — not part of PR #1501's diff. The new playbook
   (`docs/playbooks/runner-onboarding.md`, step 4) simply reuses it alongside
   `task_update`.
5. **Settle** — `task_dispatch_runtime_receipt` (`src/mcp/index.ts`) — its required-args
   list drops `message_id` (now optional). `src/tasks/runtime-receipts.ts`'s new
   `resolveMessageId()` recovers it from `{task_id, dispatch_receipt_id}` via the fixed
   convention `from_agent='mupot-dispatch', request_id='dispatch-inbox:<receipt id>'`.
   Writes to `task_dispatch_runtime_receipts` (`migrations/0138`, pre-existing table).

## Human gate

None. This is a machine-to-machine flow end to end; the only human involvement is the
one-time token mint by an admin.

## Receipt(s) written

- `fleet_agents.presence_mode` / `presence_ttl_sec` — new columns,
  `migrations/0163_fleet_agents_presence_mode.sql`.
- `task_dispatch_receipts.delivered_via` (`'inbox'|'in_worker'`, same migration) —
  written by new `recordDispatchDeliveryMode()`, "never silent" per the issue's own
  demand.
- `task_dispatch_runtime_receipts` row (settle step, pre-existing table).
- `runner_receipts` row (report step, pre-existing table, unrelated to this PR).

## What the person sees

`fleet_agent_get` surfaces the new `presence_mode` and a per-row `presence_ttl_sec` /
`derived_presence`, replacing the one global 180s window for poll-mode agents.
`task_dispatch_receipts.delivered_via` is queryable directly. No new dashboard surface
was built — the PR explicitly scopes that out.

## Tests that pin it

All on PR #1501's branch only — **absent from `main`**:
`tests/dispatch-delivery-mode.test.ts` (new, 9 pure unit cases),
`tests/fleet-agent-liveness.test.ts`, `tests/mcp-check-in.test.ts`,
`tests/mcp-fleet-agent-get.test.ts`, `tests/bus-consumer.test.ts`,
`tests/task-dispatch-runtime-receipts.test.ts` (new describe block),
`tests/mcp-task-runtime-receipts.test.ts`, `tests/mcp-task-tools.test.ts`.
No test file is named for the issue itself (`*1494*` matches nothing).

## Known gaps

- **The whole workflow is unmerged.** `src/mcp/runners.ts` — the file a first guess
  would expect to carry this logic — holds none of it; the actual change lives in
  `index.ts` / `registry.ts` / `consumer.ts` / `runtime-receipts.ts`. Until PR #1501
  merges, `main` behaves exactly as #1494 describes: a poll-mode runner cannot receive
  dispatched work.
- From the PR body (self-reported, not independently re-verified beyond the text): no
  new "read delivery status" tool; `listFleetAgentRuntimeView` / `getAgentView` (the
  dashboard's fleet views) are not updated to show `presence_mode`.

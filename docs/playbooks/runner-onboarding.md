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
| 3 | **Poll for work.** Either surface works; both now carry the `dispatch_receipt_id` you need for step 5 — **but only on a row assigned to you**: `task_list`/`task_board` attach `dispatch_receipt_id`/`delivered_via` ONLY when that row's `assignee_agent_id` is your own bound agent id, never on a task assigned to someone else you happen to be able to list (mupot#1494 round 3, P0). `inbox`/`inbox_lease` additionally give you a raw `message_id`; `task_list`/`task_board` do not — that's fine, see "Settling" below. | `inbox_lease({ limit: 5 })` (or `inbox({ peek: true })`), **or** `task_list({ assignee_agent_id: "<self>", status: "open" })` | The runner, on its own cadence. |
| 4 | **Report progress** on the work it picked up. | `runner_record({ name, task, status: "running"|"landed"|"failed" })` and/or `task_update({ task_id, status, result })` | The runner. |
| 5 | **Settle the runtime receipt** once the task is genuinely done or has failed. | `task_dispatch_runtime_receipt({ task_id, dispatch_receipt_id, stage: "completed"|"failed", runtime_receipt_hash, attempt: 1, ... })` — `message_id` is **optional**: if you polled via `task_list`/`task_board` and never saw a raw `agent_messages` id, omit it; the pair `{task_id, dispatch_receipt_id}` alone resolves and settles it. | The runner. |

## What `presence_mode: 'poll'` actually does

`check_in({ presence_mode: 'poll', poll_interval_sec })`:

- `poll_interval_sec` is bounded to **[60, 3600]** seconds (out-of-range values are
  clamped, never rejected outright — a missing value defaults to 300s).
- Your agent's `fleet_agents` row gets a **per-row presence TTL**:
  `presence_ttl_sec = max(180, 2 × poll_interval_sec)` — room for one missed/late poll
  before you read as stale, never a window tighter than the platform's own 180s floor.
- `squads` on that row is populated from your agent's **real home squad** (re-resolved on
  every call, so a later reassignment is picked up automatically) — you show up correctly
  in a squad-scoped fleet view without ever calling the daemon-report path.
- `runtime` is deliberately left **unset** — that column names a harness/engine
  (`codex`, `claude-code`, …), not a delivery cadence. If you separately know and want to
  report your own real runtime, that's a different, additive call (the daemon-report path);
  it does not conflict with poll registration.
- That row's `last_reported_at` is refreshed on **every** subsequent `check_in`, `inbox`,
  `inbox_lease`, or `task_list` call you make **that succeeds** — a refused (400/403/404)
  call never refreshes it, so a probe you know will be rejected teaches you nothing about
  your own liveness window.
- `fleet_agent_get({ agent_id })` reflects all of this: `presence_mode: "poll"`,
  `presence_ttl_sec` = your derived TTL, `derived_presence`/`live` computed against
  it — never against the global default.

**If an operator (or you, via a prior self-detach) has stopped your fleet row**
(`status: 'stopped'`), a `check_in({ presence_mode: 'poll' })` call does **not** resurrect
it — the detach wins. You get back `{ presence_stopped_by_operator: true }` instead of the
usual `presence_mode`/`poll_interval_sec`/`presence_ttl_sec` echo, and nothing is refreshed.
Get re-attached through whatever put you in that state before resuming.

**To de-register** (switching to a resident daemon, or simply stopping poll-mode
treatment), call `check_in({ presence_mode: 'resident' })` — this clears your row's
`presence_mode`/`presence_ttl_sec` back to unset, and dispatch/liveness for you falls back
to ordinary resident rules (the global TTL, `runtime && live`) from that point on.

**If you stop polling** (without de-registering), your row ages out past its own TTL
exactly like a dead resident agent would past the global one — `derived_presence` reads
`stale`, and (per the routing rule below) a poll-mode agent's dispatches still go to its
inbox, because an inbox is its *only* delivery surface; there is no in-Worker fallback that
could reach it any better. Tasks accumulate there until you resume polling — this is a
deliberate tradeoff, not a bug.

## What `task_dispatch` actually does now

`task_dispatch({ task_id })` routes to the target's **inbox** whenever the target has
ANY registered delivery mode:

- it is `presence_mode: 'poll'`-registered (regardless of the moment-to-moment liveness
  reading — see above), **or**
- it is a resident/daemon-reported runtime that is currently **live** (the pre-#1494
  behavior, unchanged for every resident agent).

It falls back to the in-Worker AgentDO **only** when neither holds — genuinely no fleet
row, or a resident row that has gone stale/dead. That decision is recorded, never
silent: on the dispatch receipt as `delivered_via: 'inbox'|'in_worker'`, and readable
directly off every `task_list`/`task_board` row for the assignee (see step 3).

A caller can also force the inbox route explicitly: `task_dispatch({ task_id, delivery:
'inbox' })` — but **only when the target has SOME registered delivery surface** (poll-mode,
or a runtime ever declared, even if currently stale). Forcing against a target with no
fleet row at all is refused (it would strand the task in an inbox nobody is known to
poll): the dispatch still happens, routed normally (in-Worker in that case), and the
tool's own result carries `delivery_forced_predicted: 'no_delivery_mode'` so you know the
force did not take effect.

## Settling with only `{task_id, dispatch_receipt_id}`

If you polled via `task_list`/`task_board` (not `inbox`/`inbox_lease`), you never saw a
raw `agent_messages.id` to pass as `message_id` — you only know the task and the
`dispatch_receipt_id` that row carries (see step 3). `task_dispatch_runtime_receipt` accepts
that pair alone: `message_id` is optional, and when omitted it is resolved server-side from
the exact `dispatch-inbox:<receipt id>` convention the inbox delivery was written under.

This genuinely works even though your message was never leased: settling performs the
same hand-out a real `inbox_lease` call would (bumping its delivery-attempt count and
stamping a live lease), atomically, the first time you settle it — **always pass
`attempt: 1`** on this path (there is nothing to have retried yet). A `dispatch_receipt_id`
that does not correlate to a real delivered message, or a `task_id` that does not match the
receipt's own task, is refused (`runtime_delivery_not_found`) exactly as it would be with an
explicit but wrong `message_id` — the alternative correlator does not weaken validation, and
an explicit `message_id` for the wrong receipt is refused the same way.

If your task needs two stages (`runtime_consumed` then `completed`/`failed`), settle both
with `message_id` omitted and `attempt: 1` — the first call's claim covers both.

**This is not a pre-authorization write (mupot#1494 round 3, P0).** The pair-settlement
claim's ownership check — the message must belong to a dispatch whose `agent_id` AND the
task's `assignee_agent_id` both equal YOUR OWN bound agent id — lives inside the same atomic
UPDATE that claims it, not a check performed before or after. Settling someone else's pair
(even a real one, even with a live workspace token) changes zero rows and is refused; it
never touches the other agent's message, lease, or attempt count. Combined with the step-3
rule above (you can never even READ another agent's `dispatch_receipt_id` off `task_list`/
`task_board`), there is no way to reach another agent's dispatch through this path at all.

**If a lease looks permanently stuck** (an `attempt: 1` settle keeps returning
`runtime_delivery_stale` even though you never successfully settled it before), that is an
operator-repair situation, not something a runner can self-heal — ask an org admin to run
`task_dispatch_lease_reset({ task_id, dispatch_receipt_id, reason })`, which resets the
message back to the same pristine state a fresh, never-delivered dispatch starts in. This
call is org-admin ONLY (an explicit `org`-scope `admin`+ capability grant — a squad admin is
refused, and so is any agent-bound token, even one whose member holds real org:admin
standing: this repair must always trace to a human operator). It refuses — receipted, never
a silent no-op — if the message was already consumed or dead-lettered (this is a repair,
never an un-delete), if `task_id` does not match the dispatch's own task, and if the lease is
genuinely LIVE and unexpired (a real resident is mid-flight, not stuck) — that last refusal
names the current holder and its expiry, and only proceeds if the operator confirms the
holder is actually gone and passes `override: true`, in which case the prior lease state is
preserved in the audit receipt, never silently discarded. Your next `attempt: 1` settle then
proceeds normally. Liveness here is compared via `julianday()` on both sides
(`LEASE_LIVE_PREDICATE`, `src/agents/messages.ts`), never a plain string compare — the two
timestamp formats this table has seen (`agent_messages.lease_expires_at` written as ISO;
this tool's own "now" as `'YYYY-MM-DD HH:MM:SS'`) sort in the WRONG order for a plain `>`
on any same-UTC-day value, which once made a same-day expired lease read as still live.

**Reassigning a task while its dispatch is still mid-flight is refused**
(`task_update({ task_id, assignee_agent_id })` → `409 task_dispatch_in_flight`) rather than
silently orphaning it — wait for the dispatch to settle (or fail) first, or have an operator
resolve it via the repair above before reassigning. **A fresh `task_dispatch` on the same
task is refused the same way** (`409 task_not_dispatchable`) while an earlier dispatch is
still unsettled — dispatching again is not a way around the reassignment guard.

**For a genuinely dead runner (the exact scenario the repair tool exists for), a lease
reset alone is not enough** — resetting the lease does not, by itself, make the guards
above let go, because they check for a settled (`completed`/`failed`) runtime receipt and a
reset writes neither. Pass `terminate: true` on the SAME repair call:
`task_dispatch_lease_reset({ task_id, dispatch_receipt_id, reason, override: true, terminate: true })`.
This additionally writes a real terminal marker (`reset_terminated`) for the dispatch, so
the reassignment guard and `task_dispatch`'s own guard both see it as settled. The full
dead-runner recovery is then: **reset(terminate) → reassign (or unassign) → a fresh
`task_dispatch` to the new/no assignee → that new dispatch settles normally.** `terminate`
is idempotent (a second call on an already-terminal dispatch writes no duplicate row) and
refuses (`409`, receipted, zero side effects) if your session has no live bearer credential
to anchor the new receipt to — a directory-OAuth org-admin session can still reset without
`terminate`, just not terminate in the same call. It also refuses outright
(`reset_refused_already_terminal`) — even with `override: true` — if the dispatch already
has a genuine `completed`/`failed` receipt: there is nothing left to repair.

**Once a dispatch is terminated, it is terminated everywhere, permanently.** The underlying
message is marked consumed in the SAME atomic write that clears its lease — it can never
again be leased, pair-settled, or redelivered via `inbox`/`inbox_lease` — and
`task_dispatch_runtime_receipt` refuses (`dispatch_terminated`, 409, no write) any further
settle attempt on that dispatch, from any runner, through any correlator. A runner that was
declared dead but was not actually dead simply gets refused when it resurfaces; it does not
corrupt task state.

## Worked example (poll every 5 minutes)

```
mint_agent_token({ agent: "orca-runner", capability: "member" })
  → reveal_credential_claim({ claim_id }) → bearer token, once

# every 5 minutes:
check_in({ presence_mode: "poll", poll_interval_sec: 300 })
task_list({ assignee_agent_id: "<self>", status: "open" })
  → tasks: [{ id: "task-123", ..., dispatch_receipt_id: "recpt-abc", delivered_via: "inbox" }]
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

- Issue mupot#1494 (this playbook closes it); #1502 (delivered_via readability, closed by the
  `task_list`/`task_board` fields above).
- `docs/workflows/05-runner-onboarding.md` — the audit-schema catalog entry for this same
  workflow (Trigger/Actor(s)/Tool-route sequence/Human gate/Receipts/What the person
  sees/Tests/Known gaps against the actual PR diff). This playbook is the operational
  how-to; that doc is the code-cited record of what shipped and what didn't.
- `src/fleet/registry.ts` — `clampPollIntervalSec`, `pollPresenceTtlSec`,
  `upsertPollFleetPresence`, `touchPollFleetPresence`, `clearPollFleetPresence`,
  `resolveFleetPresenceTtlSec`, `getFleetAgentLiveness`, `isActivePollPresenceMode`,
  `resolveFleetWriteAgentId` (v4 — the slug→`agents.id` resolution every `fleet_agents`
  writer now goes through before its upsert).
- `src/tasks/runtime-receipts.ts` — `claimUnleasedForPairSettlement`,
  `loadLatestDispatchReceiptsForTasks`, `adminResetDispatchLease`, `hasInFlightDispatchReceipt`,
  `TERMINAL_RUNTIME_RECEIPT_STAGES` (v4).
- `src/agents/messages.ts` — `leaseAvailableClause`, `bearerFencePredicate`,
  `LEASE_LIVE_PREDICATE` (v4 — the single `julianday()`-based lease-liveness check).
- `src/bus/consumer.ts` — `resolveDispatchDeliveryMode` + `hasRegisteredDeliverySurface`
  (the routing rule and the force-eligibility check).
- `src/tasks/runtime-receipts.ts` — `resolveMessageId` (the alternative correlator),
  `claimUnleasedForPairSettlement` (the lease-equivalent), `loadLatestDispatchReceiptsForTasks`
  (what `task_list`/`task_board` read).
- **mupot#1506 is CLOSED (v4):** a poll row keyed by an agent's uuid and a daemon/signed-
  attach row for the same agent keyed by its slug used to be two independent rows that
  never reconciled — `resolveFleetWriteAgentId` now converges every writer onto the
  canonical `agents.id`, and a `migrations/0171` addendum backfills any pre-existing
  duplicate pair. The home-squad exclusion (`listFleetAgentRuntimeView`) also no longer
  trusts a `fleet_agents` row's own self-reported `squads` array — it derives from the
  agent's REAL `agents.squad_id` membership instead, closing a separate self-report-honesty
  gap (a home agent could claim a non-home slug to become visible; any agent could claim a
  real home slug to vanish).
- Known residual, tracked separately, not fixed by this work: mupot#1505 (no `UNIQUE` on an
  unconsumed `(tenant, task_id)` receipt — two concurrent `task_dispatch` calls can produce
  two inbox envelopes).

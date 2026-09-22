# Runner onboarding (poll-mode)

Mint a runner token → `check_in` in poll-mode → receive dispatched work via inbox
(no resident heartbeat needed) → report → settle. Issue
[#1494](https://github.com/Mumega-com/mupot/issues/1494) — "a polling runner (no
resident daemon) can never receive dispatched work — need poll-mode presence + inbox
delivery without a 180s heartbeat."

**Status: NOT on `main`.** The implementation lives on open draft PR **#1514**,
"fix(s1494): round 3 — pair-settlement is not a pre-authorization write", branch
`kasra/poll-mode-runner-dispatch-v3`. **#1514 supersedes #1501** ("Poll-mode presence +
inbox delivery for runner onboarding (#1494)", branch `kasra/poll-mode-runner-dispatch-1494`,
head `f1c8c54f`) — #1501 is superseded, unmerged, and must not be merged; all further work
on #1494 continues on #1514. This doc traces #1514's diff against the `origin/main` it
rebases onto (`585f26cf`, which already carries workflow 8's #1509 and this catalog's own
#1503) — every citation below is PR-only unless marked "pre-existing."

Round-2 adversarial review of #1501 (pinned head `f1c8c54f`) found a NEW P0 introduced by
round 2's own fix: a task_list-only runner's settle path wrote to a message row *before*
checking who it belonged to, and `task_list`/`task_board` published the correlator a
non-owner needed to reach it. #1514 fixes that P0 plus every other finding from the same
review round (three P1s, three P2s, three P3s, and an operator repair path) — see "Known
gaps" and the PR body for the full ledger.

## Trigger

Issue #1494: an external polling runner (Orca automation) minted a token, checked in,
had a task dispatched to it, and the task stuck in `blocked` — `check_in` never
established `fleet_agents` liveness for a non-resident process, and
`task_dispatch_runtime_receipt` needed a `message_id` a poll-only runner never sees.

## Actor(s)

Machine-to-machine only for the happy path. An admin (human or elevated agent) mints the
token once; thereafter the runner agent does everything itself. **No human gate in the
happy path.** #1514 adds one admin-gated exception: `task_dispatch_lease_reset` (see
Receipts below), for an org admin repairing a wedged/desynchronised lease — that call is
human-gated (`min: 'admin'`) and always receipted.

## Tool/route sequence

(As #1514 implements it; tool names confirmed by `grep "name:"` against the diff.)

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
   `presence_mode: 'resident'` now confirms `poll_registration_cleared: true` in its
   reply (#1514 P3 — round 2 left this branch's response empty).
3. **Receive** — `task_dispatch`'s routing gate is a pure function
   `resolveDispatchDeliveryMode(route, forceInbox)` (`src/bus/consumer.ts`):
   `hasDeliveryMode = forceInbox || route.presenceMode === 'poll' ||
   (route.runtime !== '' && route.live)`. A poll-mode agent routes to its **inbox**
   unconditionally while genuinely poll-registered — but #1514 (P1-iii) makes
   `route.presenceMode` read `''` once the row is operator-stopped
   (`isActivePollPresenceMode`, `src/fleet/registry.ts`), so a detached row no longer
   routes there forever; `markStopped` (`/api/fleet/detach`) now clears
   `presence_mode`/`presence_ttl_sec` on the same call. `deliverDispatchToInbox`
   (`src/bus/fleet-bridge.ts`) writes the `agent_messages` row the runner then sees via
   `inbox` / `inbox_lease` / `task_list` — all three tools call `touchPollFleetPresence`,
   but #1514 (P2-c) moved that call to strictly AFTER the read/lease succeeds, for every
   one of the three tools — a refusal at any layer (tool or service) no longer refreshes
   liveness.
4. **Report** — `runner_record` (`src/mcp/runners.ts:12`, `min: 'member'`), reporting
   `name/task/status: "running"|"landed"|"failed"` plus optional evidence/verdict/log.
   This is a **pre-existing, unrelated tool** ("Flight-004 tentacles" receipts,
   `src/runners/service.ts` → `runner_receipts` table, `migrations/0105_runner_receipts.sql`)
   — not part of #1514's diff. The playbook (`docs/playbooks/runner-onboarding.md`, step 4)
   simply reuses it alongside `task_update`.
5. **Settle** — `task_dispatch_runtime_receipt` (`src/mcp/index.ts`) — its required-args
   list drops `message_id` (now optional). `src/tasks/runtime-receipts.ts`'s
   `resolveMessageId()` recovers it from `{task_id, dispatch_receipt_id}` via the fixed
   convention `from_agent='mupot-dispatch', request_id='dispatch-inbox:<receipt id>'`, and
   `claimUnleasedForPairSettlement()` performs the lease-equivalent hand-out atomically —
   **as of #1514, the ownership check (dispatch/task assignee == caller), the caller's
   `active` status, and the same bearer fence `inbox_lease` enforces are all INSIDE that
   one claim UPDATE's WHERE clause**, so a non-owner's settle attempt (cross-squad,
   deactivated, or fenced) changes zero rows — never a check-then-write. Writes to
   `task_dispatch_runtime_receipts` (`migrations/0138`, pre-existing table).
6. **Repair (org-admin, exceptional path)** — `task_dispatch_lease_reset`
   (`src/mcp/index.ts`, new in #1514): resets a wedged/desynchronised `agent_messages`
   row's `delivery_attempts`/`lease_expires_at`/`lease_attempt_id` back to pristine.
   Gated on an EXPLICIT `org`-scope `admin`+ capability grant (never the legacy `role`
   fallback `hasWorkspaceAdmin` uses elsewhere — a squad-scoped admin is refused, `403
   forbidden`), and refuses every agent-bound token outright (`403
   operator_principal_required`) — this repair must always be attributable to a human
   operator, never an agent acting on its own member's standing. Refuses on an
   already-consumed or dead-lettered row (`reset_refused_terminal`), on a `task_id` that
   does not match the dispatch's own task (`reset_refused_task_mismatch`), and — adversarial
   round 2's own finding — on a row whose lease is genuinely LIVE and unexpired
   (`reset_refused_lease_live`, naming the current holder + expiry) unless the caller
   passes `override: true`, in which case the prior holder's state is written into the
   audit receipt's `override_of` rather than silently discarded. See
   `adminResetDispatchLease` (`src/tasks/runtime-receipts.ts`) for the exact precedence.
7. **Reassignment guard** — `task_update` (`src/mcp/index.ts`) refuses changing a task's
   `assignee_agent_id` while its most recent dispatch has no terminal runtime receipt yet
   (`409 task_dispatch_in_flight`, `hasInFlightDispatchReceipt`,
   `src/tasks/runtime-receipts.ts`) — reassigning mid-flight would orphan the dispatch (the
   old assignee's eventual settle fails ownership; the new assignee has nothing of its own
   to settle). A same-value "reassignment" (no actual change) is never blocked.

## Human gate

None in the happy path — machine-to-machine end to end; the only human involvement there
is the one-time token mint by an admin. `task_dispatch_lease_reset` (step 6) is the one
exceptional, human-gated (org-admin capability, non-agent-bound) call #1514 adds, for
repairing a stuck lease — every call, successful or refused, is receipted (see below).

## Receipt(s) written

- `fleet_agents.presence_mode` / `presence_ttl_sec` — columns from `migrations/0168`.
- `fleet_agents.poll_home_squad_slug` — new nullable column, same migration 0168 (#1514,
  P2-a): tracks the poll writer's own last squad contribution separately from the
  daemon-report writer's, so the two merge (union) instead of clobbering each other.
- `task_dispatch_receipts.delivered_via` (`'inbox'|'in_worker'`, same migration) —
  written by `recordDispatchDeliveryMode()`, "never silent" per the issue's own demand.
- `task_dispatch_runtime_receipts` row (settle step, pre-existing table).
- `mutation_audit_entries` row for every `task_dispatch_lease_reset` call (#1514) —
  `operation` is `'reset'`, `'reset_override'`, `'reset_refused_terminal'`,
  `'reset_refused_lease_live'`, `'reset_refused_task_mismatch'`, or `'reset_not_found'`;
  `principal_kind`/`agent_id` reflect the ACTUAL calling principal (actor-faithful, not
  hardcoded to `'member'`); a reset is always an auditable fact, never a silent DB patch.
- `runner_receipts` row (report step, pre-existing table, unrelated to this PR).

## What the person sees

`fleet_agent_get` surfaces `presence_mode` and a per-row `presence_ttl_sec` /
`derived_presence`, replacing the one global 180s window for poll-mode agents.
`task_dispatch_receipts.delivered_via` is queryable directly off `task_list`/`task_board`
— but as of #1514 (P0, part b) ONLY on a row whose `assignee_agent_id` equals the caller's
own bound agent id; a squad member listing another agent's tasks sees neither field on
that other agent's row. Adversarial round 2 (P2-1) tightened this further:
`loadLatestDispatchReceiptsForTasks` now ALSO requires the dispatch's own `agent_id` to
still equal the task's CURRENT assignee — after a reassignment, the new assignee's
`task_list` shows no `dispatch_receipt_id` for the old agent's stale dispatch, for anyone,
until they get a dispatch of their own. `task_dispatch({ delivery: 'inbox' })`'s result carries
`delivery_forced_predicted: 'no_delivery_mode'` (renamed from `delivery_forced_ignored` in
#1514, P3 — it is a synchronous prediction of the consumer's later routing decision, not
the routed fact itself). No new dashboard surface was built — the PR explicitly scopes
that out.

## Tests that pin it

All on #1514's branch only — **absent from `main`**:
`tests/dispatch-delivery-mode.test.ts`, `tests/fleet-agent-liveness.test.ts`,
`tests/mcp-check-in.test.ts`, `tests/mcp-check-in-poll-presence.test.ts`,
`tests/mcp-fleet-agent-get.test.ts` (including the stopped-poll-row presence_mode pin),
`tests/bus-consumer.test.ts`,
`tests/task-dispatch-runtime-receipts.test.ts` (pair-settlement ownership conjuncts M4/M4b,
task_list/task_board reassignment leak closure, repair-path P1-A/P2-4 describe blocks,
task_update reassignment-in-flight guard, org-admin gate M9),
`tests/mcp-task-runtime-receipts.test.ts`, `tests/mcp-task-tools.test.ts`,
`tests/task-dispatch-force-inbox-eligibility.test.ts`, `tests/agent-inbox-lease-sqlite.test.ts`
(attempt-lease/inbox parity, P2-2/P2-3 carve-out scoping), `tests/inbox-fence-sqlite.test.ts`,
`tests/inbox-lease-attempt-ack.test.ts` (kept green — the pre-existing legacy reconciliation
property this PR's carve-out must not break), `tests/poll-mode-round3.test.ts`
(routing-stop, squads-merge, home-filter-scoping), `tests/poll-presence-touch-ordering.test.ts`.
No test file is named for the issue itself (`*1494*` matches nothing).

## Known gaps

- **The whole workflow is unmerged.** `src/mcp/runners.ts` — the file a first guess
  would expect to carry this logic — holds none of it; the actual change lives in
  `index.ts` / `registry.ts` / `attach-routes.ts` / `consumer.ts` / `runtime-receipts.ts`
  / `messages.ts`. Until #1514 merges, `main` behaves exactly as #1494 describes: a
  poll-mode runner cannot receive dispatched work.
- `listFleetAgentRuntimeView` / `getAgentView` (the dashboard's fleet views) are not
  updated to show `presence_mode` — unchanged from #1501's own stated scope.
- #1514's round-2-successor fixes were themselves adversarially reviewed against pinned
  head `f1c8c54f`; the finding→fix ledger (P0, three P1s, three P2s, three P3s, plus the
  `task_dispatch_lease_reset` repair path) is in the PR body and PR comments, not
  duplicated here — read them together with this doc rather than as a replacement for it.
- A SECOND adversarial round on #1514 itself found the repair tool could steal a
  genuinely LIVE lease (P1-A, fixed with the `override`-gated refusal above), an org-admin
  gate bypassable via a squad-scoped grant (P1-B, M9), a read-side receipt-id leak surviving
  reassignment (P2-1), the attempt-lease carve-out reaching both `leaseAgentInbox` itself
  (P2-2) and dispatch messages (P2-3), a non-actor-faithful/task-unvalidated repair receipt
  (P2-4), and a reassignment-mid-dispatch wedge with no repair path (P2-5, closed by
  `task_update`'s new `task_dispatch_in_flight` refusal) — all fixed on the same branch,
  same PR, before this doc was last updated.

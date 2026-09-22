# Runner onboarding (poll-mode)

Mint a runner token → `check_in` in poll-mode → receive dispatched work via inbox
(no resident heartbeat needed) → report → settle. Issue
[#1494](https://github.com/Mumega-com/mupot/issues/1494) — "a polling runner (no
resident daemon) can never receive dispatched work — need poll-mode presence + inbox
delivery without a 180s heartbeat."

**Status: NOT on `main`.** The implementation lives on open draft PR **#1522**,
branch `kasra/poll-mode-runner-dispatch-v4`, head `4cab640b` (base). **#1522 supersedes
#1514** ("fix(s1494): round 3 — pair-settlement is not a pre-authorization write", branch
`kasra/poll-mode-runner-dispatch-v3`), which itself superseded #1501 ("Poll-mode presence +
inbox delivery for runner onboarding (#1494)", branch `kasra/poll-mode-runner-dispatch-1494`,
head `f1c8c54f`) — both #1501 and #1514 are superseded, unmerged, and must not be merged;
all further work on #1494 continues on this branch. This doc traces the v4 branch's diff
against the `origin/main` it rebases onto (`585f26cf`, which already carries workflow 8's
#1509 and this catalog's own #1503) — every citation below is branch-only unless marked
"pre-existing."

Round-2 adversarial review of #1501 (pinned head `f1c8c54f`) found a NEW P0 introduced by
round 2's own fix: a task_list-only runner's settle path wrote to a message row *before*
checking who it belonged to, and `task_list`/`task_board` published the correlator a
non-owner needed to reach it. #1514 fixed that P0 plus every other finding from the same
review round (three P1s, three P2s, three P3s, and an operator repair path). A SECOND
adversarial round on #1514 itself (pinned head `c6b1d8d2`) found a NEW P0 introduced by
*that* round's own repair fix — see "v4: the P0 successor and the wedge's exit" below —
plus three P1s (two new) and three P2s, all fixed on this v4 branch.

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
   **v4: `terminate: true`** additionally writes a REAL terminal disposition
   (`task_dispatch_runtime_receipts.stage = 'reset_terminated'`) alongside a successful
   reset — see "v4: the P0 successor and the wedge's exit" below for why a lease reset
   alone was not enough, and refuses `reset_refused_credential_required` (409, receipted,
   zero side effects) if the calling session has no live bearer credential to anchor that
   receipt to (a directory-OAuth org-admin session can still reset without `terminate`).
7. **Reassignment guard** — `task_update` (`src/mcp/index.ts`) refuses changing a task's
   `assignee_agent_id` while its most recent dispatch has no terminal runtime receipt yet
   (`409 task_dispatch_in_flight`, `hasInFlightDispatchReceipt`,
   `src/tasks/runtime-receipts.ts`) — reassigning mid-flight would orphan the dispatch (the
   old assignee's eventual settle fails ownership; the new assignee has nothing of its own
   to settle). A same-value "reassignment" (no actual change) is never blocked. **v4:** the
   terminal set `hasInFlightDispatchReceipt` checks is now `completed`/`failed`/
   `reset_terminated` (`TERMINAL_RUNTIME_RECEIPT_STAGES`,
   `src/tasks/runtime-receipts.ts`) — before v4 a `task_dispatch_lease_reset` (even
   `override: true`) never satisfied this guard, so a dead runner's task could be reset
   but never reassigned, unassigned, or safely re-dispatched (see below).
8. **v4: `task_dispatch`'s own in-flight guard** — `task_dispatch` (`src/mcp/index.ts`)
   now refuses (`409 task_not_dispatchable`) while `hasInFlightDispatchReceipt` is true for
   the task, exactly the same predicate step 7's guard uses. Before v4 this guard did not
   exist: `hasInFlightDispatchReceipt`'s own doc comment claimed reassignment was "itself
   refused while the old one is still unsettled — see toolTaskDispatch's own
   task_not_dispatchable gate", but that gate had never actually been written — a fresh
   `task_dispatch` on a task with an unsettled dispatch SUCCEEDED, letting an operator
   dispatch again, settle the NEW receipt, then reassign while the OLD dispatch stayed
   unsettled forever (the exact orphaned-dispatch class step 7's guard exists to prevent,
   reached through a door that guard never covered).

## v4: the P0 successor and the wedge's exit

Adversarial round 2 on #1514 (pinned `c6b1d8d2`) found a NEW P0 introduced by round 2's own
P1-A repair fix: `adminResetDispatchLease`'s liveness check compared `agent_messages
.lease_expires_at` (written as ISO `new Date().toISOString()`, e.g.
`2026-09-22T05:37:04Z`) against `nowSqlUtc()` (`'YYYY-MM-DD HH:MM:SS'`, no `T`, no `Z`) as a
plain JS string. `'T'` (0x54) sorts above `' '` (0x20), so for ANY same-UTC-day value the
ISO string always compared greater than the space-shaped `now` — **every same-day EXPIRED
lease read as LIVE.** The repair tool refused the exact case it exists for
(`reset_refused_lease_live`, naming a holder that held nothing), and the only workaround
(`override: true`) wrote a FALSE `override_of` audit record. The same file (`src/tasks
/runtime-receipts.ts`) already documented this exact hazard 400 lines above
(`TOKEN_LIVE_PREDICATE`'s doc comment) — round 2 reintroduced the pattern that comment warns
against, in the same file. The same class, oriented fail-OPEN, was ALSO pre-existing in
`validateEnvelope` (base `585f26cf`): a settle on a lease that had genuinely expired 10
minutes earlier succeeded instead of raising `runtime_delivery_stale`.

**Fix:** `LEASE_LIVE_PREDICATE` (`src/agents/messages.ts`) — ONE SQL fragment,
`julianday()` on both sides (same discipline as `TOKEN_LIVE_PREDICATE`), format-agnostic —
now the sole liveness check consumed by `adminResetDispatchLease`, `validateEnvelope`, and
`leaseAvailableClause`. (`claimUnleasedForPairSettlement` needed no change: it gates on
`lease_expires_at IS NULL`, an exact-NULL pristine check no timestamp format can make
ambiguous.) The reset UPDATE's own `WHERE` also now re-evaluates liveness FRESH at write
time (two mutually-exclusive attempts — "not live" first, "live" only under `override`),
closing a related race where a legitimate consumer could lease the row between the
liveness check and the write.

**But a lease reset alone still left the wedge with no exit.** `hasInFlightDispatchReceipt`
keys only on a TERMINAL runtime receipt (`completed`/`failed`); `adminResetDispatchLease`
wrote neither. PROVED end to end: reset (even `override: true`) → `task_update`
reassignment still `409 task_dispatch_in_flight` → unassignment (`assignee_agent_id: null`)
also `409` → a FRESH `task_dispatch` **succeeded anyway** (item 8 above did not exist yet),
contradicting `hasInFlightDispatchReceipt`'s own doc comment and reopening the exact
orphaned-dispatch class the reassignment guard exists to prevent — an operator could
dispatch again, settle the new receipt, then reassign while the old dispatch stayed
unsettled forever. **Fix:** `adminResetDispatchLease`'s new `terminate: true` option writes
a real `task_dispatch_runtime_receipts` row (`stage: 'reset_terminated'`, carrying the
prior lease state + the acting principal, idempotent against a dispatch that already has
any terminal receipt), and `hasInFlightDispatchReceipt` / `task_dispatch`'s own new guard
(item 8) both recognize it. The full dead-runner recovery path is now: **dispatch → runner
dies → `task_dispatch_lease_reset({ ..., override: true, terminate: true })` → reassign →
fresh `task_dispatch` → settle** — every step receipted, no step a silent DB patch.

## Human gate

None in the happy path — machine-to-machine end to end; the only human involvement there
is the one-time token mint by an admin. `task_dispatch_lease_reset` (step 6) is the one
exceptional, human-gated (org-admin capability, non-agent-bound) call #1514 adds, for
repairing a stuck lease — every call, successful or refused, is receipted (see below).

## Receipt(s) written

- `fleet_agents.presence_mode` / `presence_ttl_sec` — columns from `migrations/0171`.
- `fleet_agents.poll_home_squad_slug` — new nullable column, same migration 0171 (#1514,
  P2-a): tracks the poll writer's own last squad contribution separately from the
  daemon-report writer's, so the two merge (union) instead of clobbering each other.
- `task_dispatch_receipts.delivered_via` (`'inbox'|'in_worker'`, same migration) —
  written by `recordDispatchDeliveryMode()`, "never silent" per the issue's own demand.
- `task_dispatch_runtime_receipts` row (settle step, pre-existing table). **v4:** the
  `stage` CHECK now also admits `'reset_terminated'` (table-rebuild migration, same
  `migrations/0171`, widen-don't-relabel — every existing row's `stage` is copied
  unchanged) — the row `adminResetDispatchLease({ terminate: true })` writes.
- `mutation_audit_entries` row for every `task_dispatch_lease_reset` call (#1514) —
  `operation` is `'reset'`, `'reset_override'`, `'reset_refused_terminal'`,
  `'reset_refused_lease_live'`, `'reset_refused_task_mismatch'`, `'reset_not_found'`, or
  (v4) `'reset_refused_credential_required'`; `principal_kind`/`agent_id` reflect the
  ACTUAL calling principal (actor-faithful, not hardcoded to `'member'`); a reset is
  always an auditable fact, never a silent DB patch.
- `fleet_agents` — **v4 (P1-b):** `resolveFleetWriteAgentId` (`src/fleet/registry.ts`)
  resolves a reported SLUG to its canonical `agents.id` before every write
  (`reportFleetAgents`, `/attach-signed`), so the daemon-report/signed-attach writers and
  the poll writer (`upsertPollFleetPresence`, already uuid-keyed) converge on ONE row per
  real agent instead of two. `migrations/0171`'s v4 addendum backfills any pre-existing
  duplicate pair (rename the lone slug-keyed row onto its uuid when no uuid row exists yet;
  delete the redundant slug-keyed row when both already exist) — an unmapped or
  tenant-wide-ambiguous slug is left untouched, never guessed through.
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

All on this v4 branch only — **absent from `main`**:
`tests/dispatch-delivery-mode.test.ts`, `tests/fleet-agent-liveness.test.ts`,
`tests/mcp-check-in.test.ts`, `tests/mcp-check-in-poll-presence.test.ts`,
`tests/mcp-fleet-agent-get.test.ts` (including the stopped-poll-row presence_mode pin),
`tests/bus-consumer.test.ts`,
`tests/task-dispatch-runtime-receipts.test.ts` (pair-settlement ownership conjuncts M4/M4b,
task_list/task_board reassignment leak closure, repair-path P1-A/P2-4 describe blocks,
task_update reassignment-in-flight guard, org-admin gate M9; **v4:** a new "P0 successor:
same-day timestamp format split" describe block — same-day expired-lease reset without
override, a live-lease CONTROL, and validateEnvelope's fail-closed settle refusal — plus a
new "terminate:true — the wedge now has an exit" describe block covering the pre-fix bypass
repro, the full dead-runner recovery path end to end via `invokeTool`, `terminate`'s
idempotency, and the no-credential refusal),
`tests/mcp-task-runtime-receipts.test.ts`, `tests/mcp-task-tools.test.ts`,
`tests/task-dispatch-force-inbox-eligibility.test.ts`, `tests/agent-inbox-lease-sqlite.test.ts`
(attempt-lease/inbox parity, P2-2/P2-3 carve-out scoping), `tests/inbox-fence-sqlite.test.ts`,
`tests/inbox-lease-attempt-ack.test.ts` (kept green — the pre-existing legacy reconciliation
property this branch's carve-out must not break), `tests/poll-mode-round3.test.ts`
(routing-stop, squads-merge, home-filter-scoping; **v4:** new describe blocks for P1-b
slug/uuid row convergence — both write orders, `getFleetAgentLiveness` parity, unrestricted-
view exclusion regardless of key — and P1-c membership-derived home exclusion — the EVASION
and FALSE-VANISH self-report attacks explicitly closed, `validReport`'s unknown-slug
rejection, and the honest case unchanged), `tests/poll-presence-touch-ordering.test.ts`,
`tests/dashboard-fleet-brain-agent-scope.test.ts` (the pinned #1472 isolation invariant,
re-verified against the v4 membership-derived exclusion), `tests/fleet-registry.test.ts` +
`tests/fleet-agent-view.test.ts` + `tests/fleet-attach-signed.test.ts` (mock-DB fixtures
extended for `resolveFleetWriteAgentId`'s new id/slug probes and `loadKnownSquadSlugs`).
No test file is named for the issue itself (`*1494*` matches nothing).

## Known gaps

- **The whole workflow is unmerged.** `src/mcp/runners.ts` — the file a first guess
  would expect to carry this logic — holds none of it; the actual change lives in
  `index.ts` / `registry.ts` / `attach-routes.ts` / `consumer.ts` / `runtime-receipts.ts`
  / `messages.ts`. Until this branch merges, `main` behaves exactly as #1494 describes: a
  poll-mode runner cannot receive dispatched work.
- `listFleetAgentRuntimeView` / `getAgentView` (the dashboard's fleet views) are not
  updated to show `presence_mode` — unchanged from #1501's own stated scope.
- #1514's round-2-successor fixes were themselves adversarially reviewed against pinned
  head `f1c8c54f`; the finding→fix ledger (P0, three P1s, three P2s, three P3s, plus the
  `task_dispatch_lease_reset` repair path) is in #1514's PR body/comments, not duplicated
  here — read them together with this doc rather than as a replacement for it.
- A SECOND adversarial round on #1514 itself found the repair tool could steal a
  genuinely LIVE lease (P1-A, fixed with the `override`-gated refusal above), an org-admin
  gate bypassable via a squad-scoped grant (P1-B, M9), a read-side receipt-id leak surviving
  reassignment (P2-1), the attempt-lease carve-out reaching both `leaseAgentInbox` itself
  (P2-2) and dispatch messages (P2-3), a non-actor-faithful/task-unvalidated repair receipt
  (P2-4), and a reassignment-mid-dispatch wedge with no repair path (P2-5, closed by
  `task_update`'s new `task_dispatch_in_flight` refusal) — all fixed on #1514.
- **A THIRD adversarial round, on #1514 itself (pinned `c6b1d8d2`), is what this v4 branch
  fixes** — see "v4: the P0 successor and the wedge's exit" above for the P0 and the two
  P1-a items (terminal disposition + `task_dispatch`'s own in-flight guard). It also found:
  P1-b, **one agent could carry two `fleet_agents` rows** (the poll writer keyed on the
  uuid, the daemon/signed-attach writers keyed on the slug) — closed by
  `resolveFleetWriteAgentId` plus a migration backfill (this ALSO closes the
  `mupot#1506` gap the playbook used to list as a known residual — see that doc's own
  "Related" section, now updated); P1-c, **the home-squad exclusion trusted the
  self-reported `fleet_agents.squads` array** — a home agent could claim a non-home slug to
  become visible, or any agent could claim a real home slug to vanish from operator
  observability — closed by deriving the exclusion from the agent's ACTUAL
  `agents.squad_id` membership, never from what the row itself claims (`validReport` also
  now rejects a claimed slug that names no real squad at all, independent hygiene). Plus
  three P2s (unconditional-exclusion defense-in-depth deliberately NOT taken further — see
  the code comment on `listFleetAgentRuntimeView` for why; the reset UPDATE's lease guard
  pinned fresh into its own `WHERE`; `reason` sanitized before `evidence_json`).

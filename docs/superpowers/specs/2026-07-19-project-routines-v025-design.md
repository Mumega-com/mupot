# Mupot v0.25 Project Routines and Needs You

**Status:** approved design
**Date:** 2026-07-19
**Target release:** `v0.25.0 Project Routines and Needs You`
**Depends on:** `v0.24.0 Project Operations`

## 1. Product Promise

Every active Project can maintain momentum through governed Routines that observe
the current Project Situation, propose or execute one accountable next action,
engage an authorized agent, collect durable evidence, and update the same Project
state seen through the dashboard, REST, and MCP.

A human sees every decision that requires attention in one truthful **Needs You**
queue. Mupot remains the control plane and system of record; an attached agent
runtime performs reasoning and execution through existing Task, Flight, inbox,
gate, receipt, and MCP contracts.

## 2. Existing Foundation

This release extends rather than replaces the current substrate:

- Project lifecycle, Situation, Team, Activity, Evidence, and dashboard/REST/MCP
  parity from v0.24;
- Tasks and bounded, metered Flights;
- welded agent identity, scoped capabilities, runtime presence, durable inbox, and
  correlated replies;
- approval gates, receipts, audit events, budget enforcement, and dispatch
  idempotency;
- the frozen Loop manifest v1 and its governed cycle runtime.

`Routine` and `Loop` remain different primitives:

- a **Routine** decides when saved Project work should run and records each attempt;
- a **Loop** decides whether another outcome-seeking cycle is worthwhile;
- a **Flight** is one bounded execution by an agent runtime.

The frozen Loop v1 manifest is not expanded with Project scheduling fields. Existing
Loops remain compatible. A Routine may invoke existing governed behavior through an
agent, but Routine scheduling and run history are owned by the new Project layer.

### 2.1 Control-plane boundary

Mupot does not become an agent harness in this release. Claude Code, Codex, Hermes,
DeerFlow, or another attached runtime remains responsible for model turns, context
compaction, subagent planning, tool execution, sandbox/worktree management, and any
runtime-local continuation loop.

The Mupot-owned contract ends at a narrow adapter boundary:

1. Mupot chooses the accountable Project, RoutineRun, identity, authority, budget,
   Situation digest, and required proposal schema.
2. The existing inbox/Flight path dispatches that envelope to one eligible runtime.
3. The runtime may organize its internal work however it supports, but returns only
   correlated progress and the governed `routine.proposal/v1` result.
4. Mupot validates, gates, records, and projects that result into authoritative
   Project state.

Runtime thread IDs, subagent traces, private memory, and provider-specific scheduler
state are never authoritative Mupot state. v0.25 always reconstructs a fresh runtime
session from durable Project records; adapters must not require a reusable model
thread. Adding another runtime is therefore an adapter/conformance task, not a Routine
schema or scheduler change.

## 3. Scope

### 3.1 Required in v0.25

1. First-class `Routine`, `RoutineRun`, run event, action, and artifact-reference
   records, each tenant-scoped and Project-attributed.
2. `manual`, `once`, and five-field `cron` triggers with an IANA timezone.
3. Explicit enablement, pause, cancellation, overlap policy, retry policy, per-run
   budget, and stop conditions.
4. A bounded Cloudflare scheduler with atomic occurrence creation, expiring leases,
   crash recovery, and deterministic idempotency.
5. Fresh agent sessions that read Project Situation through MCP and return a
   correlated `routine.proposal/v1` envelope.
6. `propose` and `execute_internal` modes with a narrow internal action vocabulary.
7. A derived Needs You queue over approvals, questions, reviews, blocked work,
   outputs, and budget decisions.
8. Routine events and outcomes in Project Situation, Activity, and Evidence.
9. Equivalent dashboard, REST, and MCP controls with bounded pagination and the
   same RBAC behavior.
10. Desktop/mobile browser, migration, scheduler, runtime, authorization, restart,
    and surface-parity evidence.

### 3.2 Explicitly excluded

- event, webhook, or Durable Object alarm triggers;
- reused or pinned model sessions;
- model routing or automatic model selection;
- per-flight sandbox provisioning;
- model turn loops, subagent orchestration, context compaction, worktrees, or runtime
  memory management;
- self-modifying Routines, prompts, skills, policies, or capabilities;
- raw connector credentials or model-selected credential profiles;
- general external writes without the existing approval path;
- a second task store, approval store, or agent runtime inside Mupot;
- rewriting or breaking the frozen Loop manifest contract.

Governed business tools and the Marketing/CRO pilot remain v0.26. Isolated Agent
Computers and recovery remain v0.27.

## 4. Governing Invariants

1. A Routine belongs to exactly one tenant and one Project.
2. A Routine is disabled until an authorized human enables it.
3. Scheduled Routines fire only while their Project status is `active`.
4. Every occurrence has one stable idempotency key. A duplicate scheduler, retry,
   or request cannot create a second run or repeat an action.
5. The scheduler never trusts a model to choose tenant, Project, identity,
   authority, schedule, budget, or credential binding.
6. An agent may submit a proposal only for the exact run and assignment in its
   signed/correlated envelope.
7. External writes stop at an approval gate. `execute_internal` does not widen the
   external tool boundary.
8. Every state transition, skip, retry, cancellation, proposal, action, cost, and
   outcome is auditable and attributable.
9. Needs You is a projection over authoritative records. It never becomes a second
   mutable workflow database.
10. No error path silently loses ownership: it either retries within policy,
    terminates with evidence, or identifies the next human action.
11. All list and projection reads are row-bounded and expose truthful truncation or
    continuation.
12. Dashboard, REST, and MCP apply one shared read rule and one shared mutation rule.

## 5. Domain Model

### 5.1 Routine

`routines` stores the current saved policy:

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `tenant` | pot tenant, immutable |
| `project_id` | required Project foreign key, immutable |
| `name` | trimmed operator name, 1-120 characters |
| `objective` | saved instruction, 1-4,000 characters |
| `status` | `draft`, `enabled`, `paused`, or `archived` |
| `trigger_kind` | `manual`, `once`, or `cron` |
| `run_once_at` | UTC instant, required only for `once` |
| `cron_expression` | five-field expression, required only for `cron` |
| `timezone` | valid IANA timezone; `UTC` by default |
| `next_run_at` | server-calculated UTC instant; null for manual/terminal schedules |
| `overlap_policy` | `skip` or `queue`; default `skip` |
| `execution_mode` | `propose` or `execute_internal`; default `propose` |
| `responsible_squad_id` | required writable Project squad edge |
| `preferred_agent_id` | optional eligible agent in the responsible squad |
| `budget_micro_usd` | hard non-negative per-run ceiling |
| `max_attempts` | integer 1-5; default 3 |
| `retry_backoff_seconds` | integer 30-86,400; default 300 |
| `max_occurrences` | optional positive lifetime occurrence cap |
| `stop_at` | optional UTC instant after which no new occurrence is created |
| `revision` | positive integer incremented on every policy edit |
| `enabled_by`, `enabled_at` | accountable enablement receipt fields |
| `created_by`, `created_at`, `updated_at` | audit fields |

Edits never rewrite an existing run. Each `RoutineRun` snapshots the Routine
revision and execution policy used for that occurrence.

Only a workspace administrator may create, edit, enable, pause, archive, or change
the budget of a Routine in the first stable release. An authorized member of the
responsible writable squad may request a manual run. Read access follows Project
readability.

### 5.2 RoutineRun

`routine_runs` stores one durable occurrence:

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `tenant`, `project_id`, `routine_id` | immutable ownership |
| `routine_revision` | immutable policy snapshot revision |
| `policy_json` | immutable sanitized execution-policy snapshot for this occurrence |
| `occurrence_key` | unique per tenant/Routine occurrence |
| `trigger_kind`, `scheduled_for` | immutable trigger snapshot |
| `status` | `queued`, `leased`, `observing`, `waiting`, `running`, `succeeded`, `failed`, `skipped`, or `cancelled` |
| `waiting_reason` | null or `agent`, `approval`, `answer`, `review`, or `budget` |
| `lease_owner`, `lease_expires_at` | scheduler lease; cleared after dispatch ownership transfers |
| `attempt` | current attempt, bounded by the snapshotted retry policy |
| `retry_at` | next eligible retry instant |
| `assigned_agent_id` | exact agent selected by server policy |
| `task_id`, `flight_id` | current correlated execution records |
| `situation_digest` | SHA-256 of the canonical Situation observed for the proposal |
| `proposal_json` | validated proposal envelope, never raw credentials |
| `result_summary` | sanitized terminal summary |
| `cost_micro_usd` | server-aggregated attributed cost |
| `started_at`, `finished_at`, `created_at`, `updated_at` | lifecycle times |

The unique key is `(tenant, routine_id, occurrence_key)`:

- cron/once: a canonical local schedule occurrence plus timezone;
- manual REST/MCP: caller `Idempotency-Key`, required for mutation requests;
- manual dashboard: a server-minted nonce bound to the CSRF-protected form.

### 5.3 Run events, actions, and references

`routine_run_events` is append-only and keyset-paginated. Event kinds include:

`created`, `leased`, `observed`, `dispatched`, `agent_waiting`, `proposal_received`,
`approval_requested`, `action_started`, `action_completed`, `retry_scheduled`,
`budget_blocked`, `skipped`, `cancelled`, `failed`, and `succeeded`.

Each event stores actor type/id, timestamp, sanitized metadata, and correlation ID.

`routine_run_actions` stores one row per proposed action with a unique
`(run_id, action_key)`. It records validation, gate, execution, source record, receipt,
and terminal result. Replaying the same action key returns the existing result.

`routine_run_refs` attributes Tasks, Flights, approvals, receipts, messages, outputs,
and evidence artifacts without adding Routine-specific columns to every existing
table. A unique `(run_id, ref_type, ref_id, relation)` prevents duplicate projection.

## 6. Trigger And Scheduler Semantics

### 6.1 Time model

- Cron expressions have exactly five fields and minute precision.
- Operators select an IANA timezone; `next_run_at` is always persisted as UTC.
- A nonexistent local minute during spring-forward is skipped.
- A repeated local minute during fall-back fires once at its first occurrence.
- Changing schedule or timezone increments the Routine revision and recalculates
  `next_run_at`; already-created runs retain their original occurrence.
- `once` schedules become exhausted after their one occurrence, regardless of its
  terminal outcome. Retrying occurs inside the same run.
- A Routine becomes exhausted before creating a new occurrence when `max_occurrences`
  has been reached or `stop_at` is earlier than that occurrence. Existing runs retain
  their snapshotted retry, budget, assignment, and execution policy.

### 6.2 Heartbeat

The Worker receives one `* * * * *` Cloudflare cron trigger. The scheduled handler:

1. runs the Routine scheduler every minute;
2. runs existing fifteen-minute maintenance heartbeats only in their canonical
   fifteen-minute bucket, protected by their existing idempotency;
3. reads due Routines in `(next_run_at, id)` order through a bounded indexed page;
4. creates each occurrence with an atomic unique insert;
5. advances `next_run_at` from the saved schedule, never from completion time;
6. claims queued work with an expiring conditional lease;
7. recovers expired pre-dispatch leases without duplicating a run.

The scheduler processes at most 100 due Routines and 100 queued/retryable runs per
minute. Excess work remains due for the next heartbeat. It never scans an unbounded
tenant table.

The v0.25 implementation uses a smaller operational batch of two recoveries, two
due Routines, and one claim candidate per non-maintenance heartbeat. Canonical
fifteen-minute maintenance heartbeats create and recover occurrences but do not
claim dispatch work. This keeps scheduler control work at or below 19 D1 statements
before dispatch, leaving headroom under the
Workers Free query limit. The public contract remains a hard maximum of 100; batch
sizes may increase only with an explicit invocation-budget calculation and tests.

Queued runs are leased only when the scheduler receives an attached dispatch
processor. Occurrence creation and recovery may run without one, but the scheduler
must never strand a lease when the runtime-neutral dispatch layer is unavailable.

### 6.3 Overlap

Only one non-terminal run per Routine executes at a time in v0.25.

- `skip`: create a terminal `skipped` run with reason `overlap` and evidence.
- `queue`: retain the new run in `queued` until the earlier run terminates.

A Routine may hold at most 10 queued occurrences. Additional occurrences become
terminal `skipped` runs with reason `queue_cap`, preventing an unbounded backlog.

## 7. Run Protocol

### 7.1 Preflight and observation

After lease acquisition, Mupot verifies the snapshotted policy against live state:

- tenant and Project still match;
- Project is `active`;
- Routine is still enabled at the expected revision;
- responsible squad retains `write` or `admin` Project access;
- preferred agent, when present, remains eligible and welded;
- budget is valid and available;
- overlap and queue rules still allow dispatch.

Mupot loads the shared Project Situation service and hashes its canonical, sanitized
representation. The dispatch envelope carries the Project ID, run ID, Routine
objective, MCP endpoint, and Situation digest. It does not copy credentials or grant
new capabilities.

### 7.2 Agent engagement

Mupot creates a Project-attributed Task and governed Flight, records their run
references, and sends a correlated `routine.run/v1` inbox envelope to the exact
assigned agent. Agent selection is server-side:

1. use the preferred agent if currently eligible;
2. otherwise select an eligible agent in the responsible squad using the existing
   capability-aware assignment policy;
3. if none exists, set the run to `waiting(agent)` and create a Needs You item.

The runtime starts a fresh session for every dispatch or retry. It reads the current
Project Situation through MCP, including the shared server-calculated Situation digest,
performs bounded work, and returns one correlated proposal. At proposal acceptance the
server recalculates the digest; a changed Situation returns `stale_situation` and queues
a fresh observation within the existing retry ceiling. Session state is not authoritative
and is not reused.

### 7.3 Proposal envelope

The agent returns exactly one `routine.proposal/v1` envelope:

```json
{
  "version": "routine.proposal/v1",
  "run_id": "uuid",
  "project_id": "uuid",
  "situation_digest": "sha256-hex",
  "summary": "why this is the next accountable action",
  "action": {
    "key": "agent-stable-idempotency-key",
    "kind": "create_task | dispatch_flight | request_review | ask_human | no_action",
    "input": {}
  }
}
```

The server rejects unknown keys, mismatched run/Project/digest values, oversized
strings, unsupported action kinds, out-of-scope IDs, ineligible squads/agents,
budgets above the remaining run ceiling, and references the actor cannot read.

Action inputs are narrow:

- `create_task`: title, description, and optional eligible assignee within the
  responsible squad;
- `dispatch_flight`: goal plus existing Project task/artifact references and a budget
  not exceeding remaining run budget;
- `request_review`: readable source type/id and sanitized review summary;
- `ask_human`: one question, optional 2-5 choices, and relevant readable references;
- `no_action`: reason and optional recommended next scheduled check.

### 7.4 Proposal and execution modes

- `propose`: every actionable proposal becomes `waiting(review)` and appears in Needs
  You. Approval executes the same stored action key; rejection cancels it with evidence.
- `execute_internal`: validated `create_task` and `dispatch_flight` actions may execute
  idempotently. `request_review` and `ask_human` naturally wait for a human.
- any action that resolves to an external write uses the existing approval service and
  becomes `waiting(approval)`. The Routine cannot bypass or weaken that gate.
- `no_action` succeeds with evidence and no fabricated work.

An answer or approval resumes the same RoutineRun in a new fresh agent session when
more reasoning is required. State and context are reconstructed from durable records.

## 8. State Transitions And Recovery

Allowed state transitions are enforced centrally:

```text
queued -> leased -> observing -> running
queued -> skipped | cancelled
leased | observing -> queued (expired pre-dispatch lease)
running -> queued (retry scheduled) | waiting | succeeded | failed | cancelled
waiting -> queued | running | succeeded | failed | cancelled
skipped | succeeded | failed | cancelled -> terminal
```

Terminal runs never re-enter execution. Cancellation is an explicit audited command;
disabling a Routine prevents new occurrences but does not silently cancel a running
Flight. An administrator may cancel the run, which uses the existing Flight/runtime
control path and records whether cancellation was confirmed or only requested.

Retryable failures are limited to transient dispatch, inbox, runtime, or lease errors.
Invalid proposals, authorization failures, exhausted budgets, rejected approvals, and
Project lifecycle changes do not burn automatic retries.

## 9. Needs You

Needs You is a bounded union projection over authoritative sources:

- pending approvals;
- RoutineRuns waiting for agent assignment, answer, review, approval, or budget;
- blocked Project tasks that identify a human owner;
- outputs awaiting review;
- reviewed changes requiring an accountable decision.

Each item has:

`kind`, `source_type`, `source_id`, `project_id`, title, reason, urgency, responsible
human or role, requested-by identity, created/deadline timestamps, safe action URL,
and the source-specific allowed actions.

The global queue includes all readable Projects; a Project panel filters the same
projection by `project_id`. Ordering is urgency, deadline, creation time, and stable
source ID. Keyset cursors and per-source scan caps expose truthful truncation.

Needs You rows cannot be directly edited or deleted. Resolving an item calls the
source service: approve/reject, answer, assign agent, accept/reject review, change
budget, or cancel. The item then disappears from the unresolved projection while its
history remains in Activity and Evidence.

## 10. Project Integration

Project Situation gains bounded Routine information:

- enabled/paused Routine counts;
- next scheduled Routine and UTC/local display time;
- active or waiting run with responsible teammate;
- latest terminal run outcome and cost;
- Needs You count and highest-priority item;
- truthful truncation metadata.

The Project next-action resolver includes Routine ownership without replacing existing
Task, blocker, review, or approval truth. Priority is:

1. urgent Needs You decision;
2. blocked/waiting active RoutineRun;
3. existing Project blocker or review;
4. active assigned work;
5. next enabled Routine occurrence;
6. explicit empty-state action.

Routine events project into Activity. Signed receipts, approvals, action outcomes,
Flight landings, cancellations, and terminal run summaries project into Evidence.

## 11. Product Surfaces

### 11.1 Dashboard

Each Project gains a `Routines` tab containing:

- enabled, paused, and draft Routines;
- next/previous run and timezone;
- responsible squad/agent;
- mode, budget, cost, retry, and overlap policy;
- current state and next accountable action;
- keyset-paginated run/event history with Activity/Evidence links;
- admin create/edit/enable/pause/archive controls;
- authorized Run now and Cancel run commands.

The global navigation adds `Needs You` near Work and Approvals. Project Overview shows
only a compact Routine/attention summary. No nested cards or competing dashboard home is
introduced. Desktop and mobile layouts preserve bounded tables and horizontal scroll
where needed.

### 11.2 REST

REST resources use the shared services:

- `GET/POST /api/projects/:projectId/routines`
- `GET/PATCH /api/projects/:projectId/routines/:routineId`
- `POST .../:routineId/enable|pause|archive|run`
- `GET /api/projects/:projectId/routine-runs`
- `GET /api/routine-runs/:runId`
- `POST /api/routine-runs/:runId/cancel`
- `POST /api/routine-runs/:runId/proposal` for the bound assigned agent
- `GET /api/needs-you` and `GET /api/projects/:projectId/needs-you`

Mutations require CSRF for browser sessions and `Idempotency-Key` for REST/MCP commands
that can create work. Tenant/RBAC failures return `404` where existence must remain
hidden and stable machine-readable errors otherwise.

### 11.3 MCP

MCP exposes equivalent bounded tools:

`routine_list`, `routine_get`, `routine_create`, `routine_update`, `routine_enable`,
`routine_pause`, `routine_archive`, `routine_run_now`, `routine_run_list`,
`routine_run_get`, `routine_run_cancel`, `routine_proposal_submit`, and
`needs_you_list`.

Needs You resolution uses existing source-specific tools rather than a generic
authority-bypassing `needs_you_resolve` command.

## 12. Authorization

- Project read access controls Routine, run, event, and Needs You visibility.
- Workspace administrators manage Routine policy and enablement.
- Members of the responsible writable squad may request a manual run.
- Only the exact welded assigned agent may submit that run's proposal.
- Agents cannot mutate schedule, revision, Project, responsible squad, preferred agent,
  budget, mode, overlap policy, or authorization.
- Existing source-specific capability checks govern Tasks, Flights, approvals, and
  external actions after proposal validation.
- All queries include tenant scope before ID lookup. Cross-tenant IDs fail closed.

## 13. Failure Behavior

| Failure | Durable result |
|---|---|
| no eligible agent | `waiting(agent)` plus Needs You assignment item |
| agent offline or inbox full | bounded retry with backoff; then `waiting(agent)` |
| invalid or mismatched proposal | terminal failure plus review evidence; no action |
| budget exhausted | `waiting(budget)` plus Needs You budget decision |
| external action | `waiting(approval)` through existing gate |
| expired pre-dispatch lease | same run returns to `queued` |
| duplicate occurrence/action | existing record returned; no repeated side effect |
| overlapping run with `skip` | terminal skipped run with overlap evidence |
| queue cap reached | terminal skipped run with queue-cap evidence |
| Project no longer active | terminal skipped run with lifecycle reason |
| Routine disabled/revised before dispatch | terminal skipped run with policy reason |
| runtime timeout/crash | bounded fresh-session retry; then terminal failure/Needs You |
| cancellation | audited request and confirmed/unconfirmed outcome |

## 14. Cost And Evidence

Run cost is server-aggregated from attributed Flights and metered actions. A run cannot
authorize a Flight above its remaining budget. Budget checks happen before dispatch or
tool spend, not after the bill is incurred.

Evidence includes the Routine revision, occurrence, Situation digest, assigned identity,
Task/Flight references, proposal validation, approval receipt, action idempotency key,
landing/result receipt, cost, terminal state, and relevant external proof. Raw prompts,
credentials, tokens, and unrestricted model output are not evidence payloads.

## 15. Migration And Compatibility

- Add new tables and indexes in forward-only migrations; never edit shipped migrations.
- Existing Projects, Loops, Tasks, Flights, approvals, and schedules retain behavior.
- No Routine is auto-enabled during migration.
- Existing Loop cron behavior remains compatible while Project Routines are introduced;
  operators may later replace a domain loop's cadence with a Project Routine through an
  explicit reviewed migration path, not an automatic data guess.
- The v0.24 Project API remains additive and backward compatible.

## 16. Verification And Release Gate

### 16.1 Required automated coverage

1. Migration from every supported prior schema, fresh migration, and repeated local
   migration application.
2. Routine validation, revision snapshots, enablement, authorization, tenant isolation,
   CSRF, and idempotency.
3. Manual, once, and cron scheduling in multiple IANA timezones, including DST gap and
   repeated-hour behavior.
4. Atomic occurrence creation, lease expiry, crash recovery, retry limits, overlap skip,
   queue ordering, and queue cap.
5. Active-only Project lifecycle behavior and disable/revision races.
6. Exact agent assignment, correlated proposal submission, invalid envelope rejection,
   stale Situation digest handling, and fresh-session retry.
7. Structural external-write gate and internal action idempotency.
8. Needs You source projection, source-specific resolution, ordering, cursoring, RBAC,
   and truthful truncation.
9. Project Situation, Activity, and Evidence attribution across dashboard, REST, MCP,
   restart, and pagination.
10. Cost aggregation and pre-dispatch budget enforcement.
11. Full unit/integration suite, typecheck, no-secrets, and migration integrity gates.

### 16.2 Browser/runtime evidence

One isolated local evidence run must prove, in desktop and mobile browsers:

1. create a Routine under an active Project;
2. configure manual/once/cron fields and enable it;
3. fire manually and observe one RoutineRun;
4. engage a conformance runtime through Task, Flight, and inbox;
5. receive a correlated proposal;
6. approve a propose-mode action through Needs You;
7. observe terminal outcome, cost, Activity, Evidence, and updated Project Situation;
8. prove a duplicate command does not repeat work;
9. prove unauthorized Project/agent variants fail closed;
10. restart the local Worker and confirm durable state and surface parity.

The browser loader, REST response, and MCP tool must structurally agree on the same
seeded RoutineRun and Project Situation.

### 16.3 Release decision

v0.25 is releasable only when:

- all required tests and local evidence pass from a clean final commit;
- no unresolved Critical or Important finding remains in independent review;
- one Mumega Project operates a real enabled Routine through the complete governed
  path without manual database intervention;
- GitHub CI is green for the exact reviewed commit;
- package, health, changelog, roadmap, tag, release, and deployed commit consistently
  identify `v0.25.0`;
- deployment and customer activation receive separate explicit owner approval.

No mandatory soak duration is imposed. Operators may continue active testing and fix
issues immediately; release confidence comes from current receipts and explicit gates.

## 17. Activation Sequence

1. Ship migrations and services with all Routines disabled.
2. Verify dashboard/REST/MCP parity and scheduler behavior locally.
3. Enable one manual propose-mode Routine on a Mumega Project.
4. Verify correlated agent proposal and Needs You resolution.
5. Enable one scheduled `execute_internal` Routine with a narrow internal action.
6. Complete independent security/product review and exact-commit CI.
7. Obtain owner approval for merge/deploy/version activation.
8. Activate DME or another customer pot only after the same conformance and permission
   gates pass in that sovereign pot.

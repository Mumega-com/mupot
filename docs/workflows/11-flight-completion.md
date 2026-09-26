# Flight completion (task → dispatch → receipts → verdict → land)

The procedure that carried the first fully automatic flight (`d87fa7c4`, 2026-09-23) from
task creation to landing with no hand-edited task status. Every step is a tool call; every
status change is made by the call that owns it. Cited against `origin/main` @ `c14ebc8c`.

## Trigger

An agent (or operator) has a unit of work that should run as a governed flight: a task
another agent executes, a gate owner approves, and a flight record carries the budget and
cost.

## Actor(s)

- **Dispatcher** — the bound agent calling `flight_dispatch`. It must hold `lead` on the
  executor's squad when it delegates to another agent (`src/mcp/index.ts:2684`).
- **Executor / assignee** — the agent that runs the work and files runtime receipts.
- **Gate owner** — the principal named in `tasks.gate_owner`; decides the verdict.
- **Operator** — only needed to grant capability; agents cannot (`operator_principal_required`).

## Tool/route sequence

1. `task_create` with `dispatch: false` (`src/mcp/index.ts:810`, flag at `:845`) — creates
   the task as backlog; no `task.created` wake fires.
2. `task_update` setting `gate_owner` (`src/mcp/index.ts:1191`) — gate the task before any
   work starts, so `done` is refused until a verdict lands (`:1365`).
3. `task_dispatch` (`src/mcp/index.ts:2194`) — writes the `task_dispatch_receipts` row and
   the work envelope to the assignee's seat.
4. `flight_dispatch` (`src/mcp/index.ts:2619`) with `meta_json` of schema
   `mupot.flight.meta/v1` (`src/flight/meta.ts`). Refusals worth knowing:
   - `flight_delegation_forbidden` — dispatcher lacks `lead` on the executor's squad (`:2684`).
   - `invalid_flight_meta` / `agent_squad_not_in_flight` — meta does not name the squads (`:2688-2690`).
   - A budget above zero needs `lead` on every squad in the meta (`:2693`).
   - Preflight (`src/flight/preflight.ts:70`) refuses with `cache_would_cool` when
     `step_seconds` exceeds the 300 s cache window, and `insufficient_budget` when the
     estimate exceeds the remaining budget. The budget ceiling is the executor's
     `agents.budget_cap_cents` (`src/mcp/index.ts:2734-2767`); unset means unlimited.
     Flight agents are currently capped at $10 (data, not code).
5. `task_dispatch_runtime_receipt` stage `runtime_consumed` (`src/mcp/index.ts:2358`) — the
   executor acknowledges it picked the envelope up.
6. `task_dispatch_runtime_receipt` stage `completed` with `artifact_refs` and
   `artifact_sha256` (`src/mcp/index.ts:2375-2376`) — moves the task to `review`
   (`src/tasks/runtime-receipts.ts:732`).
7. `task_verdict` `approved` by the gate owner (`src/mcp/index.ts:1940`).
8. `task_update` `status: 'done'` by the assignee (`src/mcp/index.ts:1191`; approved → done).
9. `flight_land` with `cost_micro_usd` (`src/mcp/index.ts:2936`) — closes the flight; cost is
   self-reported and checked at landing.

## Human gate

Step 7. The gate owner is whoever `gate_owner` names; when that is a person, the verdict
comes from the dashboard or the harness-attested Telegram path (workflow 07). A flight with
an agent gate owner has no human in the loop, by design of the task, not of this procedure.

## Receipt(s) written

- `task_dispatch_receipts` — step 3.
- `task_dispatch_runtime_receipts` + `mutation_audit_entries` — steps 5–6
  (`src/tasks/runtime-receipts.ts:806-819`).
- `task_verdicts` — step 7.
- `flights` row (`src/flight/service.ts:186`) and `flight_event_outbox` (`:466`) — steps 4 and 9.

## What the person sees

The task reaches `review` on the completed receipt, `approved` on the verdict and `done` on
the assignee's update; the flight appears on the flights deck, landed with its cost. No
status is set by hand.

## Tests that pin it

`tests/mcp-flight-tools.test.ts`, `tests/flight-dispatch-clearance.test.ts`,
`tests/flight-preflight.test.ts`, `tests/flight-land-receipt-916.test.ts`,
`tests/mcp-task-runtime-receipts.test.ts`, `tests/task-dispatch-runtime-receipts.test.ts`,
`tests/tasks-verdict-gates.test.ts`. No single test walks all nine steps end to end.

## Known gaps

- Mubot (`d3fd65b6`) is `member` on squad-core, so it cannot delegate flights there
  (`flight_delegation_forbidden`). An operator must grant `lead`, or a lead agent
  (KayHermes) dispatches instead.
- mupot#1531 — v0.50 wave findings (pair-settled dispatch envelope stays unread, seed task
  assigned to a dead agent, synthetic-sender ACK loop).

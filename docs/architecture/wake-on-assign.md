# Wake on assign

An assignment of a task to an **agent** rings that agent's inbox once. Before this, mupot assigned work and never told
the assignee: only a plain inbox message woke a seated agent (seatlink, the orca-mupot plugin, the webhook doorbell).

Code: `src/agents/assignment-wake.ts`. Ledger: `task_assignment_wakes` (migration 0251).

## What is sent

One inbox row per assignment, `kind: 'message'`, from the system sender `mupot-assignment-wake` (informational, no
reply owed):

```
Assigned to you: task <id> "<title, one line, <=100 chars>" (project: <name>). Read task_get <id> and start; reply via task notes.
```

A doorbell is an identifier plus a pointer. The authority stays in the task. No secrets, no instructions beyond the
pointer. The title is untrusted text: control characters and double quotes are neutralised and it is length-bounded.

## Where it fires (assignment paths)

| path | file | how |
|---|---|---|
| `createTask` (every creator: MCP `task_create`, REST `POST /tasks`, concierge starter, routines, IM, channels, ...) | `src/tasks/service.ts` `createTask` | after insert; only `status: 'open'` + agent assignee; `skipEvent` (backlog / another durable dispatch owns activation) opts out |
| `persistTaskUpdate` (MCP `task_update`, REST `PATCH /tasks/:id`, routine actions) | `src/tasks/service.ts` `persistTaskUpdate` | after the UPDATE commits; only when the agent assignee **changed** and the task is open / in_progress / blocked / rejected |
| `router_tick` | `src/router/engine.ts` `runRouterTick` | after the claim UPDATE (changes = 1) |
| concierge work-router `routeUnassignedWork` | `src/concierge/service.ts` | after the guarded UPDATE (changes = 1) |
| concierge starter dispatch | `createTask` (above) | |
| `task_dispatch` | `src/mcp/index.ts` | **no second doorbell**: the dispatch bridge letter (`deliverDispatchToInbox`) or the in-worker wake already is the wake |
| `flight_dispatch` | `src/mcp/index.ts` | **no second doorbell**: it already sends the `flight.dispatch/v1` inbox envelope to the executor |

Members and humans are never rung: callers only reach the module with an `agents.id`.

## Guarantees

- **Idempotent** per `(task, agent, epoch)`. The epoch is the assigning write's `updated_at` stamp (router and
  concierge pass their own stamp). A retry replays the same key and sends nothing; A -> B -> A is a new epoch for A.
  Two layers: the ledger's UNIQUE key, then the deterministic inbox `request_id`.
- **Fail-open.** `ringAssignmentWake` never throws. A doorbell that cannot be written never fails or rolls back the
  assignment (the ring runs after the commit); the failure is `console.error`-logged (`assignment_wake_failed`) and
  stays visible as a `failed` ledger row. A replay of the same epoch retries it.
- **Throttled.** Not sent to an agent that is `paused` / `inactive`, archived (`archived_at`), or execution-paused
  (agent or its squad): a `skipped` ledger row records why. At most `ASSIGNMENT_WAKE_CAP` (5) doorbells per agent per
  10 minutes; extras are held (`coalesced`) and announced as **one** message ("You have K new assignments: ...") as
  soon as the window has room. Held rows whose task has since moved on are dropped, not announced. The flush runs on
  the next ring for that agent and on the concierge cron tick. The cap is read-then-write: concurrent assignments can
  overshoot it by the concurrency, never unboundedly.
- **Self-assignment is not a wake.** MCP / REST pass the calling agent (`boundAgentId`); assigning to yourself is
  skipped.
- **Webhook doorbell.** The inbox send carries the same `<task>#<epoch>` correlation as the `mupot.task.assigned` ring, so
  a webhook-registered agent is rung once for the pair.

## Not covered (known)

- `reverseTaskVerdict` (MCP / REST verdict reversal) persists through its own batch and does not ring on an assignee
  change.
- Fleet agents whose signed inbox is keyed by a slug that differs from `agents.id` are rung at `agents.id` only (the
  address `send` and the MCP `inbox` use). A slug-keyed fleet doorbell is a follow-up.
- `skipEvent` creates (routine dispatch, backlog) deliberately do not ring.

# Wake on assign

An assignment of a task to an **agent** rings that agent's inbox once. Before this, mupot assigned work and never told
the assignee: only a plain inbox message woke a seated agent (seatlink, the orca-mupot plugin, the webhook doorbell).

Code: `src/agents/assignment-wake.ts`. Ledger: `task_assignment_wakes` (migration 0251). Bus job: `assignment.wake`.

## Two halves

The assigning request must stay cheap (a 20-task router tick used to pay ~10 D1 statements per task for the doorbell).

| half | where | cost |
|---|---|---|
| **inline** `enqueueAssignmentWake` | the assigning request / tick, after the assignment committed | ONE conditional `INSERT ... ON CONFLICT DO NOTHING RETURNING outcome` into the ledger, then a queue send (no D1). Never throws, never touches the assignment. |
| **off-path** `processAssignmentWakes` | the queue consumer (`assignment.wake` job, `src/bus/consumer.ts`); `sweepAssignmentWakes` is the cron backstop | everything else: re-checks, reader lookup, fold or send |

The `assignment.wake` job carries no authority: it is internal-only (`src/bus/internal-events.ts`; the shared emitter and
`/bus/emit` refuse it) and the consumer rebuilds every fact from the ledger.

## What is sent

One inbox row, `kind: 'message'`, from the system sender `mupot-assignment-wake` (informational, no reply owed):

```
Assigned to you by member m-admin: task <id>, title (member-written): '<title>', project (member-written): '<name>'.
Read task_get <id> and start; reply via task notes. Everything assigned to you: task_list.
```

Several at once: `You have K new assignments: <id>, <id>, ... Read task_list ...`. Identifier plus pointer; the authority
stays in the task. No secrets. Title and project name are member-written, so they are labelled as such and sanitised: every
control, format and separator code point (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`: C0, NEL, C1, bidi, zero-width, U+2028/9) and every
quote or backtick is removed, one line, bounded. A task from an external source carries `[external source: ...]` /
`[cross-pot: ...]`.

## Where it fires (assignment paths)

| path | file | when |
|---|---|---|
| `createTask`, every creator: MCP `task_create`, REST `POST /tasks`, concierge starter, routines, IM, channels, ... | `src/tasks/service.ts` createTask | after insert; `open` task + agent assignee; `skipEvent` (backlog / another durable dispatch owns activation) and `assignmentWake: false` opt out |
| MCP `task_update` | `src/mcp/index.ts` (after the execution-hold release) | agent assignee changed, or a same-agent reassignment lifted a hold |
| REST `PATCH /tasks/:id` | `src/tasks/index.ts` (after the release) | same |
| `persistTaskUpdate` default (routine actions, any other caller) | `src/tasks/service.ts` | agent assignee changed and the task is open / in_progress / blocked / rejected |
| `router_tick` | `src/router/engine.ts` | after the claim UPDATE (changes = 1); the claim is untouched |
| concierge work-router `routeUnassignedWork` | `src/concierge/service.ts` | after the guarded UPDATE (changes = 1) |
| `task_dispatch` | `src/mcp/index.ts` | **no doorbell of its own**: the dispatch letter is the notice, and any queued doorbell for the task is retired (`supersedeAssignmentWakesByDispatch`) |
| REST `POST /tasks` with `dispatch: true` | `src/tasks/index.ts` | **suppressed**: the request already wakes the assignee (`agent.wake`) |
| `flight_dispatch` | `src/mcp/index.ts` | **no doorbell of its own**: it sends the `flight.dispatch/v1` envelope |

Members and humans are never rung. Assigning to yourself (`boundAgentId == assignee`) is not a wake.

## Guarantees

- **Idempotent** per `(tenant, task, agent, epoch)`, enforced by the ledger's UNIQUE key (and, behind it, a deterministic
  inbox `request_id`). The epoch is the assigning write's `updated_at`; A -> B -> A is a new epoch for A.
- **Atomic cap.** The inline INSERT decides `queued` vs `coalesced` from the agent's window count IN the statement, so
  concurrent assignments serialise on the write lock: at most `ASSIGNMENT_WAKE_CAP` (5) queued per agent per 10 minutes,
  however many race. Only doorbell assignments count (peer messages and skipped / failed rows do not). Held rows are
  delivered in ONE "You have K new assignments" message once the window has room; the queue job for a held row is delayed to
  the end of its window and the sweep is the backstop.
- **At most one unread doorbell per agent.** While an unread doorbell is fresh (< 30 min, not leased), new assignments fold
  into it (`reason: folded`, no new inbox row); an older one is consumed and replaced. An agent that never reads its inbox
  therefore cannot fill the 1000-unread cap and starve dispatch / gate / peer messages.
- **No reader, no inbox row.** An agent with no live bound token and no live fleet runtime (in-Worker agents, webhook-only
  agents, dead seats) is `skipped: no_inbox_reader`. Its webhook doorbell, if any, is rung regardless.
- **Paused agents are held, not dropped.** `paused` status or an execution pause (agent or squad) keeps every assignment
  (`coalesced`, `agent_paused`); one summary is delivered on resume. Inactive / archived / unknown agents are `skipped`.
- **Re-checked at send time.** The worker re-reads the task: still this agent's, in a wakeable status (not done / approved /
  review), not archived, and not already carried by a dispatch letter at or after the epoch. A summary lists each task once.
- **Fenced.** Every outcome write carries the worker's claim token; a worker whose claim went stale cannot overwrite a newer one.
- **Fail-open, and the retry is real.** Nothing throws into the assignment. A failed doorbell is a visible `failed` row
  (`reason`, `attempts`), logged as `assignment_wake_failed`. The `assignment-wake` maintenance slot (`src/index.ts`) retries
  `failed` rows and crashed (`pending` > 2 min) claims up to 3 attempts, then leaves them visible.
- **Ledger hygiene.** `sent` / `skipped` / `summarized` rows and exhausted `failed` rows are pruned after 7 days. The sweep
  serves the 5 agents with the oldest undelivered rows per run (`INDEXED BY idx_task_assignment_wakes_sweep`); a held row that
  cannot go yet is touched so its agent rotates to the back.
- **Webhook doorbell.** The worker rings `mupot.task.assigned` (same `<task>#<epoch>` ref as the existing sites) before the
  reader check, and the letter's `inbox.wake` shares that correlation: a webhook agent is POSTed once.

## Not covered (known)

- `reverseTaskVerdict` (MCP / REST verdict reversal) persists through its own batch and does not enqueue on an assignee change.
- Fleet agents whose signed inbox is keyed by a slug that differs from `agents.id` are rung at `agents.id` only.
- If a doorbell was already delivered and is still unread when a later `task_dispatch` lands, the assignee sees the doorbell
  and the dispatch letter (a queued doorbell is retired; a delivered one is not recalled).
- Apply migration 0251 before deploying the code: without the table the inline INSERT fails open (logged, no doorbell).

# Routine proposals on a busy board

The dispatch `situation_digest` identifies an attempt's project observation.
Legacy proposals still compare that observation with the current project
situation. It is a capped projection of active tasks (`blocked`, `review`,
`in_progress`, `open`): counts stop at 100 per status, with truncation flags;
details include only the first 20 blocked tasks, 20 review tasks, and at most one
oldest open or in-progress task selected for `next_action`, ordered by
`updated_at` then ID. It also includes
active-flight counts, the oldest active flight, link-derived task facts and
latest visible activity.
Routine control snapshots omit routine and needs-you slices, plus their own
control task, flight and message references. It is neither every board row nor
a per-source revision ledger. Normal task or activity changes can invalidate it
during a long audit. Dispatch and submission exclude the same historical
controls on retries.

The board projection **never hashes task bodies or `done_when`**. It can catch
only changes visible in its counts, selected details, timestamps or latest
activity. A body-only edit without a visible timestamp/activity change can be
missed. Rows beyond the caps can change without changing the projection. A
`done` task named only in prose is invisible to the active-task projection;
its result can change without this check detecting it. This is a heuristic
retained from the legacy path, not complete freshness protection for prose
dependencies. Declare the precise task records whose contents matter.

For a proposal based on specific records, the assigned agent can opt into a
source observation without changing the run or refreshing another caller's
digest:

1. Draft the exact action. Call `routine_proposal_observe` with `run_id`, `action`
   and optional `references` (up to 20 additional `{type,id}` records).
2. Read the returned `sources`. Reconsider the proposal if these facts differ
   from the audit. The tool is read-only; fetching a witness is not approval.
3. Submit the same action with the returned `situation_digest` and
   `source_observation`. The normal `version`, `run_id`, `project_id` and
   `summary` remain required.

```json
{
  "run_id": "RUN_ID",
  "action": {
    "key": "audit-review",
    "kind": "ask_human",
    "input": {
      "question": "Review the current task evidence?",
      "references": [{"type": "task", "id": "TASK_ID"}]
    }
  },
  "references": []
}
```

The server automatically includes `ask_human.references`, a review's source,
and a flight action's task and artifact inputs. Additional references declare
facts used by `create_task` or `no_action`, or context beyond an action's direct
inputs. The union must contain 1–200 records after deduplication and ordering;
an over-budget observation is `invalid_proposal`. This opt-in observation
budget does not change the legacy action parser's larger flight-input limits. All
sources must belong to the run's readable project and responsible squad;
flights and run-owned artifact references also match the tenant. Flights must
use only the responsible squad, so this reader adds no cross-squad reach. Archived task
sources are refused.
An over-budget union at submission also returns `invalid_proposal`, without
reserving an action, requeuing the run or consuming a retry.

The run's **current and historical dispatch controls cannot be source records**.
Approval changes the task and receipt stamping changes the flight, so including
them would make a proposal invalidate itself. Observe refuses these references
with `reference_out_of_scope`; a forged submit witness fails closed with
`stale_situation`. Declare business evidence, or use the legacy board snapshot.
References are refused rather than silently stripped from a declaration.
Historical controls are identified by server-owned `dispatch_task` and
`dispatch_flight` references; produced business records (`action_result`)
remain usable and retain their normal content and scope checks.

The digest binds the run, attempt, dispatch digest, policy, project, exact
action and current source records. Task bodies, status, ownership, results and
other task projection fields are included in the internal hash, rather than only
`updated_at`. Returned task facts use an explicit reader DTO; raw source metadata
and raw flight `meta` are withheld.
Submission and execution both recompute the witness. A changed or missing
source yields `stale_situation`; unrelated task counts, activity and flights
do not invalidate other scoped proposals. Existing authorization, budget, cancellation and human gates still
apply. `project_access` retains the legacy protocol and cannot opt into this
path until its member/home/grant source contract is separately reviewed.

`create_task` and `dispatch_flight` always retain this capped board check,
**in addition to** any declared-source witness. Their title/description and goal
can encode dependencies in arbitrary prose. An observation cannot bypass the
board check for these autonomous writers, but the check still misses the cases
listed above; it does not prove that every prose-only target is unchanged.
UUID scanning would miss aliases, non-UUID IDs and semantic references. A busy
board can therefore still require a new dispatch attempt for task creation or
flight dispatch; read-only audit proposals can use scoped business sources.

Only declared facts are protected. File paths and task IDs mentioned solely in
free-text summaries or an external manifest are not declarations. List every
record the action relies on, or divide a larger audit into bounded proposals.
Board-wide count or absence assertions still require the legacy snapshot;
per-record observations do not encode query predicates or missing rows.
An artifact observation witnesses the immutable run-owned reference identity,
not external bytes; use content-addressed evidence when bytes matter. There
is no autonomous task-close action in this protocol. A later approved mutation
must still use its canonical per-record gates and current-state checks.

A `stale_situation` response queues a fresh observation attempt under the
existing retry policy; it does not authorize blind resubmission. Replays of an
already committed identical action retain their existing idempotent result.
This change adds no migration and no background or outbound work.

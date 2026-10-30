# Routine proposals on a busy board

The dispatch `situation_digest` identifies an attempt's project observation.
Legacy proposals still compare that observation with the current project
situation. It is a capped projection: task counts and truncation flags, selected
blockers/reviews and next task, active flights, link health and latest activity.
Routine control snapshots omit routine and needs-you slices, plus their own
control task, flight and message references. It is neither every board row nor
a per-source revision ledger. Normal task or activity changes can invalidate it
during a long audit. Dispatch and submission exclude the same historical
controls on retries.

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

The digest binds the run, attempt, dispatch digest, policy, project, exact
action and current source records. Task bodies, status, ownership, results and
other task projection fields are included in the internal hash, rather than only
`updated_at`. Returned task facts use an explicit reader DTO; raw source metadata
and raw flight `meta` are withheld.
Submission and execution both recompute the witness. A changed or missing
source yields `stale_situation`; unrelated task counts, activity and flights
do not. Existing authorization, budget, cancellation and human gates still
apply. `project_access` retains the legacy protocol and cannot opt into this
path until its member/home/grant source contract is separately reviewed.

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

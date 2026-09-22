# Verdict reversal

Corrects a mistakenly-approved or mistakenly-rejected task back to `review`. Order-by-design:
the gate that stops a routine from re-granting off a reversed verdict is closed **before**
anything else happens, so a partial failure can never leave the gate open. mupot#1181
(original P0), #1490 r2 gate (ordering fix). **#1492 is still open** — see Known gaps: the
ordering fix closes a plain repeated reversal, but a retry that also carries a field change
(e.g. `gate_owner`) still writes a receipt and fires a wake for a change that never landed
in `tasks`.

## Trigger

An org owner/admin calls `task_verdict_reverse`, or `task_update` with
`status: 'review'` on a task whose current status is `approved`/`rejected` (both routes
converge on the same reversal logic).

## Actor(s)

Org owner or admin only (`isOrgOwnerAdmin(auth)`) — never a plain member, never an agent.

## Tool/route sequence

1. `task_verdict_reverse` (`src/mcp/index.ts:2098`) — thin wrapper: requires a non-empty
   `reversal_reason` (falls back to `reason`), then calls `toolTaskUpdate.run(...)` with
   `status: 'review'` (`src/mcp/index.ts:2125-2131`).
2. `task_update` (MCP) / `PATCH /api/tasks/:id` (HTTP, `src/tasks/index.ts:836`) — both call
   `detectVerdictReversalRequest` (`src/tasks/service.ts:656`) to classify the request as
   `'fresh'`, `'retry_completion'`, or `'none'`.
   - `'fresh'`: `approved`/`rejected` → `review`.
   - `'retry_completion'`: `review` → `review`, but only when the task is already `review`
     **and** its latest verdict's `reversed_at` is already set — i.e. a retry of a reversal
     whose gate-closing step landed but a later step didn't. Any other `review → review`
     request is ordinary and untouched by this path.
3. On `reversalKind !== 'none'` (`src/mcp/index.ts:1275-1298` / `src/tasks/index.ts:~836`):
   `isOrgOwnerAdmin(auth)` gate, mandatory non-empty reversal reason, then
   `reverseTaskVerdict` (`src/tasks/service.ts:585`, shared by both write surfaces) —
   called from `src/mcp/index.ts:1589` and `src/tasks/index.ts:1168`.
4. `reverseTaskVerdict` runs three steps, **in this order, non-negotiably**:
   1. `markVerdictReversed` — stamps `task_verdicts.reversed_at` on the latest verdict row.
      This is the gate-closing write: `executeRoutineAction`'s `resolveProposalVerdict`
      filters on `reversed_at IS NULL`, so once this lands a routine can never replay a
      grant off this verdict again, regardless of what happens next.
   2. The task status flip to `review` (skipped entirely if the task is already `review` —
      the `retry_completion` case, meaning this already landed on an earlier attempt).
   3. An append-only receipt insert into `verdict_reversals`, with a **deterministic id**
      (`reversal:<verdict.id>`) so a retried insert of the same reversal is a no-op, not a
      duplicate or an error.

## Human gate

`isOrgOwnerAdmin(auth)` (`src/mcp/index.ts:1284`) — org owner or admin capability only.
A non-empty `reversal_reason` (or `reason`) is mandatory; missing it is
`400 verdict_reversal_reason_required`. There is no agent-authority path here at all —
unlike `task_verdict`'s `human_origin` fallback, reversal has no non-human branch.

## Receipt(s) written

Table `verdict_reversals` (migration `0118_verdict_reversals.sql`):

| column | notes |
|---|---|
| `seq` | autoincrement ordering key |
| `id` | deterministic: `reversal:<verdict_id>` |
| `tenant`, `task_id`, `squad_id` | |
| `from_status` | `approved` or `rejected` |
| `to_status` | always `review` |
| `prior_verdict` | the verdict being reversed |
| `reason` | mandatory, `CHECK (length(trim(reason)) > 0)` |
| `actor_id`, `actor_type` | who reversed it |
| `created_at` | |

Append-only: UPDATE/DELETE forbidden by trigger. Also stamps `task_verdicts.reversed_at`
(added by migration `0159_task_verdict_proposal_binding.sql`'s companion column set) via
`markVerdictReversed`, guarded by a widened append-only-exception trigger in
`0162_task_verdicts_reversal_update_exception.sql`.

## What the person sees

No chat-facing reply text — this is an org-owner/admin dashboard/API action, not an
IM-gated flow. The MCP/HTTP response is the patched `task` object (status now `review`)
plus, on `403`, `{ need: 'org_admin', detail: 'verdict reversal on an approved/rejected
task requires org owner/admin authority' }`.

## Tests that pin it

- `tests/task-verdict-reversal.test.ts`
- `tests/verdict-reversal-immutable.test.ts`
- `tests/mcp-task-tools.test.ts`
- `tests/routine-project-access-v2.test.ts` (reversed verdict must not re-trigger a grant)

## Known gaps

- **Migration `0162_task_verdicts_reversal_update_exception.sql` is schema/branch-only —
  "NOT applied by this build; a human applies it"** (per the migration's own header,
  matching this repo's manual-deploy discipline, `docs/operations/deploy-preflight.md`).
  Until it is applied in a given environment, `markVerdictReversed`'s UPDATE is rejected by
  the older append-only trigger (`0069_project_structural_completion.sql`) and
  `task_verdict_reverse` fails with a bare `internal_error`. Confirm migration state before
  relying on this workflow in any given deployment.
- **mupot#1492 is OPEN, not fixed** — the three-step ordering (`reversed_at` first,
  deterministic receipt id) only makes a *plain* repeated reversal safe; the original bug
  survives in a compound case. On `retry_completion` (`existing.status === 'review'`),
  `reverseTaskVerdict` skips `buildTaskUpdateStatement` entirely and returns
  `landed = existing` (`src/tasks/service.ts:604-625`) — nothing about a bundled field
  change (e.g. a new `gate_owner`) is persisted to `tasks`. But back in the caller
  (`src/mcp/index.ts:1589-1592`), only `next.status`/`next.updated_at` are reset from that
  outcome — `next.gate_owner` and other fields keep the caller's requested-but-never-written
  values, and `reassignsGatedReview` (computed independently of `reversesVerdict`,
  `src/mcp/index.ts:1502`) is not gated on whether the task row actually changed. The result:
  a second `task_verdict_reverse` call that also asks for a `gate_owner` change writes a real
  `gate_owner_reassignments` receipt and wakes the new "owner" (`src/mcp/index.ts:1629-1657`)
  for a reassignment that never landed in the `tasks` table. `tests/task-verdict-reversal.test.ts`'s
  idempotent-replay test only re-sends the same plain reversal reason, so this compound path
  has no test coverage. Confirmed unfixed on `origin/main` at `3c706069`.

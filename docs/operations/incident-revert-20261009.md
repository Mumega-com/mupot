# Runbook: revert the 2026-10-09 accidental `router_tick` (mupot#1780)

Tool: `task_incident_revert` (migration 0201, this PR). Incident record and snapshot:
mupot#1780 comment 6073776662 (the 25-row table) and comment 6073876029 (evidence, options).
Hadi approved option C on 2026-10-10. Nothing here is run by a builder or an arm: the operator
(org-admin, unbound operator bearer or dashboard session) runs it after the PR is gated, merged,
migrated and deployed.

No secrets appear in this document. Tokens are read by the operator from their own store and are
never placed in argv or in a message.

## What the tool does and does not do

- Per row, ONE guarded UPDATE sets `status='open'`, `assignee_agent_id=NULL`, `updated_at=now`, and
  only when `status`, `assignee_agent_id` (NULL-safe) and `updated_at` all equal the values you pass.
  Any other row is skipped and reported `drifted` with its actual values. Nothing is forced.
- It writes no other column. `result`, `completed_at`, `execution_receipt_id` and
  `execution_claim_expires_at` stay as they are. The full pre-revert row is saved, every column, in
  `task_incident_revert_receipts` (append-only) in the same D1 batch.
- It refuses archived tasks, and tasks with a live execution claim (`drifted`, reason
  `live_execution_claim`).
- It does NOT neutralise queued wakes. See "Stale wakes" below. Pausing mumcp first is mandatory.

## Preconditions

1. The PR is merged, migration `0201_task_incident_revert_receipts.sql` is applied, and the worker is
   deployed (migrate first, then deploy). Check `task_incident_revert` is in `tools/list`.
2. The execution-pause kill switch (the parallel PR, migration 0200) is deployed.

## Steps

### 1. Pause mumcp

Use the execution-pause control from the parallel PR for agent mumcp
(`3070ddc1-10c8-4ac7-881d-c8a3760b4024`). Confirm it took effect: `execution_meter` for
`mumega:3070ddc1…` stops advancing (it was count 89, window start 2026-10-09T03:23:48Z), and no
task row changes for one alarm interval (`ALARM_INTERVAL_MS` = 15 minutes, `src/agents/agent-do.ts`).
Do not continue until both hold.

### 2. D1 time-travel bookmark

Record the bookmark so the whole operation can be rolled back:

```bash
npx wrangler d1 time-travel info <D1_DATABASE_NAME>
```

Write the printed bookmark and timestamp in the #1780 thread before step 3. Do not run
`time-travel restore` as part of this runbook. A restore would also discard every legitimate write
since the bookmark, so it is a separate decision for Hadi.

### 3. Re-read the live rows and compare against the snapshot

Before the call, confirm the 23 rows below still match (read-only `task_get` or `task_list`). The
tool re-checks inside the write, so this is a courtesy to see drift before it happens.

### 4. Call the tool

`POST /actions/task_incident_revert` (or the MCP tool of the same name), unbound org-admin bearer:

```json
{
  "reason": "Undo the accidental live router_tick of 2026-10-09T03:23:50Z (mupot#1780). Tasks were open and unassigned before; mumcp re-claimed them and every attempt failed artifact verification.",
  "incident_ref": "mupot#1780 comment 6073776662",
  "rows": [
    { "task_id": "61b36118-ec0d-4a09-974d-196a40787c98", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:30:05.398Z" },
    { "task_id": "565a917f-d5d8-4d78-93a8-2da8c9fcb315", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:30:23.401Z" },
    { "task_id": "a90cd088-9022-4bc3-a591-066f490b5e34", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:30:51.496Z" },
    { "task_id": "0cb08e2d-c8c8-464a-adbe-c5a0e37927cd", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:11.574Z" },
    { "task_id": "18f4d03e-052e-47da-8f87-b7c04be545db", "expected_status": "in_progress", "expected_assignee_agent_id": null, "expected_updated_at": "2026-10-09T03:24:39.073Z" },
    { "task_id": "a19d36b3-8993-462f-8916-3495253d745b", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:25.259Z" },
    { "task_id": "534608fa-6063-4445-907e-d970a809967c", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:35.531Z" },
    { "task_id": "0f3bac57-e92e-49e7-92aa-38923aba7c5e", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:46.900Z" },
    { "task_id": "8cd47246-a60f-421b-ae34-ed94462a3042", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:56.408Z" },
    { "task_id": "3f197b19-e9c7-4c13-a926-909e3f7b5400", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:16.151Z" },
    { "task_id": "e354b9cb-0d0e-4dcb-9af8-c8dc4767fda8", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:36.506Z" },
    { "task_id": "fd837573-2dd7-4643-91b9-7876233db1cb", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:31:50.968Z" },
    { "task_id": "08bb3f0f-2b39-4c12-804e-d551f567fea6", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:02.725Z" },
    { "task_id": "5fda93c7-6f98-4739-b505-55cc291231ed", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:09.049Z" },
    { "task_id": "1005d7e9-3126-4e83-8ad8-c2a30c7f2906", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:22.583Z" },
    { "task_id": "39954f6d-2078-438c-941e-1b148f255c3d", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:36.439Z" },
    { "task_id": "9f95a6eb-dc00-4554-8d5f-0bef2f40fe74", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:48.127Z" },
    { "task_id": "1fe4aa00-adfa-460d-a90e-6a693f018b0c", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:32:57.788Z" },
    { "task_id": "ba20b8ac-0fd3-4fd8-ab93-1dd40f966c82", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:33:15.873Z" },
    { "task_id": "ffed61c0-cee4-4e08-a33f-83b6279f23f0", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:33:02.906Z" },
    { "task_id": "6aaf0a81-1aa8-44f7-a860-00571984816a", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:29:52.144Z" },
    { "task_id": "cc308832-1c94-4836-bf96-49776e50215f", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:29:56.606Z" },
    { "task_id": "944c6e07-25a6-4ebd-9a7a-804b67c99ff7", "expected_status": "blocked", "expected_assignee_agent_id": "3070ddc1-10c8-4ac7-881d-c8a3760b4024", "expected_updated_at": "2026-10-09T03:30:10.742Z" }
  ]
}
```

That is 23 rows: 22 blocked and assigned to mumcp, plus `18f4d03e` (in_progress, unassigned).
`5d24a00a-66fa-4d4f-b19c-fc9645a55d87` is already `open` and unassigned, so it is deliberately
excluded. The tool rejects a row that is already open and unassigned.

The comment's table lists 24 task ids. `5d24a00a-66fa-4d4f-b19c-fc9645a55d87` is already `open` and
unassigned there, so it is deliberately excluded (the tool also rejects a row that is already open and
unassigned), leaving the 23 rows above. The router's unrouted row `c2733636-0085-47da-90ff-540c668e2f2f`
was never assigned and is not in the table. The comment's prose says `61b36118` and `565a917f` were
already `blocked` by mumcp before Kasra's 03:27Z unassign, so their live `updated_at` may differ from
the table's: the compare-and-set reports them `drifted` instead of reverting them if it does. Re-check
all 23 at step 3.

### 5. Verify

- The response: `reverted: 23, drifted: 0, not_found: 0, archived: 0`, and 23 `receipt_ids`. Anything
  else: stop, do not retry blindly. Each `drifted` row carries its actual values; a human decides.
- Rows are `open` and unassigned (`task_list` for squad-core, or `task_get` per row).
- 23 receipts exist for the incident (read-only, from a D1 console or a debug query):

  ```sql
  SELECT task_id, expected_status, new_updated_at, length(pre_row_json)
    FROM task_incident_revert_receipts
   WHERE incident_ref = 'mupot#1780 comment 6073776662' ORDER BY created_at;
  ```

- Wait one alarm interval (15 minutes) with mumcp still paused and re-read: no row changed.
- Post the response (ids and counts only) in the #1780 thread.

### 6. Unpause mumcp

Only after step 5 is clean. Then watch the 23 rows for one alarm interval. If mumcp re-claims any of
them, re-pause immediately and see "Stale wakes".

## Rollback

Each receipt holds the full pre-revert row as JSON in two levels (`part1`..`part3`, each an object of
the task's columns; 25 columns in total, nested because D1 limits SQL functions to 32 arguments). To
restore one row by hand, apply the saved values back. The D1 time-travel bookmark from step 2 is the
whole-database rollback, with the cost described in step 2.

## Stale wakes: what the tool does NOT fence

Investigated against origin/main `bfbe8975`:

- `tasks.assignment_epoch` (migration 0121) is read and compared ONLY inside `src/flight-spine/*`
  (assignments, artifacts, receipts, dependencies). It is not read by `wakeAgent`, `AgentDO`,
  `runTaskExecution`, `claimTaskProgress`, `canAgentExecuteTask`, the bus consumer or the router.
- An `agent.wake` event carries `{type, tenant, squad_id, agent_id, payload, ts}`. It has no epoch
  and no assignment identity. A wake with a `task_id` makes `runTaskExecution` load the task and
  claim it if it is in a workable status (`open`, `blocked`, `rejected`).
- After the revert the task is `open` and unassigned, and `canAgentExecuteTask` lets any agent in the
  squad auto-pick an unassigned, locally sourced task. So a queued or retried wake for mumcp can
  re-claim a reverted task exactly as it did on 2026-10-09.

Consequences:

- The revert does NOT bump `assignment_epoch`. Bumping would fence nothing, and for a task that is part
  of a flight it would invalidate that flight's assignment rows (artifact and receipt queries join on
  `task.assignment_epoch = assignment.assignment_epoch`).
- What actually stops a stale wake is pausing the executing agent (step 1), not the tool. The tool's
  own safety is the live-execution-claim refusal plus the compare-and-set: it cannot revert a task a
  running executor holds, and it cannot revert a task that changed.
- A durable fix would thread the wake's `ts` (or an assignment epoch) through
  consumer → `wakeAgent` → AgentDO → `runTaskExecution` and refuse a claim whose wake predates the last
  `task_incident_revert_receipts.created_at` for that task. That touches the shared claim path and is
  not in this PR; file it as a follow-up.

## Snapshot fields NOT found in the comment (not guessed)

Comment 6073776662 records, per task: id, pre-incident status and assignee (open, unassigned),
current status, current assignee, and `updated_at`. It does NOT record, for any of the 23 rows:

- the full `assignee_agent_id` as a UUID for the "mumcp" column: the comment writes the word `mumcp`;
  the UUID `3070ddc1-10c8-4ac7-881d-c8a3760b4024` comes from the comment's own "Event" section
  (`assigned 24 to mumcp (3070ddc1-10c8-4ac7-881d-c8a3760b4024)`), not from the table. Verify it
  against a live row at step 3.
- the current `result` text of each row (the comment says only "a failed-completion result text");
- `completed_at` (the blocked path of `finishTask` sets it, so it is probably non-NULL on the 22
  blocked rows; not confirmed);
- `execution_receipt_id` and `execution_claim_expires_at` (the in_progress row `18f4d03e` may carry a
  claim; the tool refuses it with `live_execution_claim` if that claim has not expired);
- the PRE-incident values of `result`, `completed_at`, `execution_receipt_id`: not recorded anywhere
  (tasks have no history table). That is why the tool leaves them untouched and snapshots them
  instead of resetting them. After the revert an `open` task may therefore still show a failed
  `result` and a `completed_at`. Decide separately, per row, whether to clear them; the receipt has
  the exact values.
- the exact `updated_at` of `18f4d03e` after any later change: the value used above is the comment's
  03:38Z snapshot.

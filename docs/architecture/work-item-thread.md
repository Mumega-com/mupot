# Work-item = thread (Buzz pattern, borrowed)

**Status:** Adopted as a mupot UX pattern (2026-07-22). **Borrow only — no Buzz/Goose
dependency.** Feeds the operator surface on top of existing task + receipt primitives.

## Thesis

Buzz's forge insight is: *a work item and its discussion are the same object*. A branch
is a short-lived room; merge archives the room into a permanent record of *why* the code
exists. mupot already has the governance half of that idea (task + gate + append-only
receipt). This pattern maps Buzz's lifecycle onto those primitives without adopting
Buzz's Nostr/relay stack or Goose's runtime wrapper.

| Buzz | mupot |
|------|-------|
| Work item / branch channel | `tasks` row (the work item **is** the thread) |
| Channel opens with branch | Thread opens with `createTask` (`thread_status=open` + `opened` receipt) |
| Branch auto-creates channel | `git_branch` bind via `linkTaskBranch` / `executeTaskAsPR` (`branch_linked` receipt); PR url reuses `github_issue_url` |
| Discussion in channel | `task_thread_receipts` posts (`kind=post`) |
| Merge archives channel | `archiveTaskThreadsForMergedPr` on `pull_request.closed`+`merged` (`archived` receipt) |
| Signed events | Append-only receipts (same shape as `task_verdicts`) |

## What we deliberately do **not** take

- Buzz's Nostr relay, NIP-34 forge kinds, or desktop client
- Goose / goosed as a fleet runtime (recorded as non-adoption on main)
- A second chat product beside the pot — the thread lives *on the task*

## Operator surface

- Task list/detail include `thread_status` and `git_branch`
- `GET /api/tasks/:id/thread` — thread view + ordered receipts
- `POST /api/tasks/:id/thread` `{ body }` — append a discussion post (409 if archived)

## Lifecycle (code)

1. `createTask` → `openTaskThread` (best-effort receipt after the durable task INSERT;
   D1 has no wrapping transaction — see below)
2. `executeTaskAsPR` → `linkTaskBranch(branch, { prUrl })`
3. GitHub webhook `pull_request.closed` with `merged=true` → `archiveTaskThreadsForMergedPr(prNumber)`

## Intent: `thread_status` may diverge from `task.status`

**Yes, on purpose.** Merge archives the *discussion* (the branch channel is frozen into
the permanent why-record). It does **not** close the task.

A gated task commonly sits in `status=review` while Kasra-core (or another gate owner)
verdicts the PR — and the PR can merge before that verdict lands. After merge:

| Field | Typical value | Why |
|-------|---------------|-----|
| `tasks.thread_status` | `archived` | Branch channel closed; further `postTaskThread` → 409 |
| `tasks.status` | still `review` (or later `approved`/`rejected`/`done`) | Gate / lifecycle is independent of merge |

Operators continue gate work against the frozen receipt trail. Do not reopen the thread
on merge; do not auto-flip `task.status` from the archive path.

## Task status enum (backfill)

Full `tasks.status` enum (migration 0042 / `Task['status']`):

`open | in_progress | blocked | review | approved | rejected | done`

There is **no** `cancelled` (or other) status. Migration 0068 archives threads only for
gate-outcome / terminal rows: `approved`, `rejected`, `done`. Live and in-gate rows
(`open`, `in_progress`, `blocked`, `review`) keep `thread_status=open`. The TypeScript
constant `THREAD_ARCHIVE_BACKFILL_STATUSES` is exhaustively classified against the enum
so a future status cannot silently skip backfill.

## `createTask` ↔ opened receipt (accepted best-effort)

`createTask` commits the `tasks` row first, then calls `openTaskThread` (one retry on
throw). If the receipt write still fails, create returns the committed task and does
**not** roll back — the opened receipt is an accepted best-effort side effect.
`openTaskThread` is idempotent; a later reconcile call can attach the missing `opened`
receipt without duplicating it.

## Files

- `migrations/0068_task_work_thread.sql`
- `src/tasks/thread.ts`
- Wired from `src/tasks/service.ts`, `src/integrations/github-execute.ts`, `src/integrations/github-routes.ts`

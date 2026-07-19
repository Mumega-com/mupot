# Task 11 Report: Project Routines and Needs You Dashboard

## Implementation Commit

- Code commit: `7d58235320206a2925b4fe477b4ada1d4e1641d4`
- Commit message: `feat: add routine and attention workspace views`
- Base: `1edff8e`

## Scope Delivered

- Added a Project Routines route and tab with bounded routine, run, and event tables.
- Rendered draft, enabled, paused, waiting, failed, succeeded, empty, validation-error, and truncation states.
- Added workspace-admin create, edit, enable, pause, and archive forms using shared Routine services and PRG redirects.
- Added Run now for a responsible writable-squad member. The server mints and consumes a one-time, actor-bound nonce within the dashboard CSRF-protected form path before passing it as the shared service idempotency key.
- Added workspace-admin cancellation through the shared cancellation service.
- Added a read-only Needs You route beside Work and Approvals. Rows have urgency, Project, responsible party, source-specific dashboard links, opaque cursor continuation, and no generic resolution write.
- Added a compact Routine/attention summary to Project Overview.
- Preserved Project visibility by checking the shared Routine Project-read authority before loading dashboard data. Unreadable Projects return the existing 404 surface.
- Used `role="region"`, labelled tables, stable `min-width`, and horizontal overflow for mobile-safe bounded tables.

## Verification Evidence

Fresh command run from this worktree before the code commit:

```sh
npx vitest run tests/dashboard-routines.test.ts tests/dashboard-needs-you.test.ts tests/dashboard-projects.test.ts tests/dashboard-auth-shell.test.ts tests/dashboard-approvals.test.ts --reporter=dot && npm run typecheck && git diff --check
```

Result:

- 5 test files passed.
- 74 tests passed.
- `npm run typecheck` passed.
- `git diff --check` passed.

The focused new tests are `tests/dashboard-routines.test.ts` and `tests/dashboard-needs-you.test.ts`; together they cover rendering, authority, writes, nonce handling, source-specific links, absence of generic resolution, cursor/truncation state, exact state labels, and mobile table structure.

## Changed Paths

- `src/dashboard/routines.ts`
- `src/dashboard/needs-you.ts`
- `src/dashboard/projects.ts`
- `src/dashboard/index.ts`
- `tests/dashboard-routines.test.ts`
- `tests/dashboard-needs-you.test.ts`

## Concern

The requested `.superpowers/sdd/task-11-brief.md` was not present in this isolated worktree. Implementation followed the supplied design sections 9-13, Task 11 plan, existing dashboard patterns, and source-service contracts.

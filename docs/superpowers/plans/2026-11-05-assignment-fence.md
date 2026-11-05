# Assignment fence implementation plan

**Goal:** Use the same assignment eligibility rule at selection and commit time in the concierge and router.

**Architecture:** A shared SQL fragment checks that a candidate is active, is not covered by an execution pause, and has an independent eligible gate holder when the task requires one. Both assignment updates evaluate that fragment using the current task row. Each caller retains its current liveness, authority, project access, candidate ordering and squad-resolution contract.

**Stack:** TypeScript, Cloudflare D1, Vitest with the real migration-chain SQLite harness.

## Scope

- Add `src/tasks/assignment-eligibility.ts` for the predicate and its read-side wrapper.
- Use it from `src/router/engine.ts` and `src/concierge/service.ts`, including both claim updates.
- Keep a zero-row update as a skipped assignment without wake/assignment side effects.
- Preserve the router's existing 10-minute presence check and the concierge's online roster and cross-squad assignee resolution. Shared liveness is separate work.
- Preserve the existing independent gate contract, including independent human holders and null/self-completion gates.
- No schema or Worker configuration change.

## Steps

- [ ] Add real-schema tests for eligible assignments, pauses, gate independence and eligibility changes immediately before the update; verify meaningful failures on the base.
- [ ] Implement and integrate the shared SQL predicate without changing ordering or eligible-agent behavior; verify related router and concierge suites.
- [ ] Mutate every new guard, verify failing assertions, restore the source, regenerate build-info and run typecheck plus the full suite when time permits.
- [ ] Push the branch and open a draft PR with exact-head proof and explicit follow-ups; do not merge or deploy.

## Bounded follow-ups

Routine dispatch creates tasks/flights through a different transactional path and retains its current candidate contract in this slice. Starter-task gate configuration is changed only if an existing project/org setting makes it a one-line substitution.

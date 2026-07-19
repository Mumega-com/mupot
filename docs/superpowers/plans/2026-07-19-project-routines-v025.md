# Mupot v0.25 Project Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every active Project maintain governed momentum through durable Routines and expose every required human decision in one truthful Needs You queue.

**Architecture:** Add a Project-owned Routine control plane over the existing Task, Flight, inbox, gate, receipt, Project Situation, REST, dashboard, and MCP services. A bounded Cloudflare cron scheduler creates and leases durable RoutineRuns; attached agent runtimes remain replaceable executors and return one correlated proposal through the existing inbox/MCP boundary.

**Tech Stack:** TypeScript 5.6, Hono, Cloudflare Workers, D1/SQLite, `cron-schedule`, MCP SDK, Vitest, Playwright.

## Global Constraints

- Target release is exactly `v0.25.0 Project Routines and Needs You`.
- Mupot owns Project state, scheduling, authorization, budgets, gates, evidence, and attention; it does not implement model turns, subagents, sandboxes, worktrees, memory compaction, or provider-specific loops.
- v0.25 supports only `manual`, `once`, and five-field `cron` triggers with an IANA timezone.
- Every runtime dispatch starts a fresh session reconstructed from durable Project records.
- A Routine is disabled until a workspace administrator enables it.
- External writes always use the existing approval path.
- Needs You is a read projection over authoritative sources, never a second workflow store.
- Every list is bounded and reports a cursor or truthful truncation.
- Existing Loop manifest v1 and existing Project/Task/Flight behavior remain backward compatible.
- Use forward-only migrations and add no new production dependency.

---

## File Map

- `migrations/0061_project_routines.sql`: Routine, run, event, action, reference, lease, uniqueness, and query indexes.
- `src/routines/types.ts`: Routine domain records and discriminated status/action types.
- `src/routines/schedule.ts`: cron/once validation, timezone occurrence calculation, DST rules, and occurrence keys.
- `src/routines/access.ts`: shared Project readability, workspace-admin mutation, writable-squad, and exact-agent checks.
- `src/routines/service.ts`: policy CRUD, enable/pause/archive, run reads, revision snapshots, and manual occurrence creation.
- `src/routines/scheduler.ts`: due occurrence creation, leases, retry recovery, overlap handling, and bounded heartbeat.
- `src/routines/dispatch.ts`: Project observation, assignment, Task/Flight creation, and inbox envelope dispatch.
- `src/routines/proposal.ts`: strict `routine.proposal/v1` parser and Situation correlation.
- `src/routines/actions.ts`: idempotent internal actions, gate transitions, retry, cancellation, cost, and terminal evidence.
- `src/routines/routes.ts`: shared REST resources and commands.
- `src/attention/service.ts`: bounded Needs You union projection.
- `src/attention/routes.ts`: global and Project-filtered REST reads.
- `src/mcp/routines.ts`: MCP parity tools backed by the same services.
- `src/dashboard/routines.ts`: Project Routine management and history UI.
- `src/dashboard/needs-you.ts`: global attention inbox UI.
- `src/projects/situation.ts`, `src/projects/projections.ts`: Routine/attention integration.
- `src/index.ts`, `src/dashboard/index.ts`, `src/mcp/index.ts`: route, tool, and heartbeat registration only.

### Task 1: Durable Routine Schema

**Files:**
- Create: `migrations/0061_project_routines.sql`
- Create: `tests/routines-migration.test.ts`
- Modify: `tests/migration-d1-compat.test.ts`

**Interfaces:**
- Produces tables `routines`, `routine_runs`, `routine_run_events`, `routine_run_actions`, and `routine_run_refs` with the fields and enums from the approved design.
- Stores deterministic `max_occurrences`/`stop_at` limits on Routines and an immutable sanitized `policy_json` on every RoutineRun.
- Produces unique keys `(tenant, routine_id, occurrence_key)`, `(run_id, action_key)`, and `(run_id, ref_type, ref_id, relation)`.
- Produces due, lease-recovery, Project-history, Needs You, and terminal-cost indexes.

- [x] **Step 1: Write migration tests that apply migrations `0001` through `0060`, seed two tenants/Projects/squads, and assert schema shape, foreign keys, checks, and indexes.**

```ts
expect(columns('routine_runs')).toEqual(expect.arrayContaining([
  'id', 'tenant', 'project_id', 'routine_id', 'routine_revision',
  'policy_json', 'occurrence_key', 'status', 'waiting_reason', 'lease_owner',
  'lease_expires_at', 'attempt', 'retry_at', 'assigned_agent_id',
  'task_id', 'flight_id', 'situation_digest', 'proposal_json',
  'result_summary', 'cost_micro_usd', 'created_at', 'updated_at',
]))
expect(() => insertDuplicateOccurrence()).toThrow(/UNIQUE/)
expect(() => insertCrossProjectRun()).toThrow(/routine run project mismatch/)
```

- [x] **Step 2: Run `npx vitest run tests/routines-migration.test.ts tests/migration-d1-compat.test.ts` and verify the new test fails because migration `0061` does not exist.**
- [x] **Step 3: Add the five tables, immutable ownership triggers, append-only event triggers, enum checks, foreign keys, and bounded query indexes.**
- [x] **Step 4: Re-run the focused tests and verify both pass.**
- [x] **Step 5: Commit with `git commit -m "feat: add project routine persistence"`.**

### Task 2: Domain Types and Schedule Semantics

**Files:**
- Create: `src/routines/types.ts`
- Create: `src/routines/schedule.ts`
- Create: `tests/routine-schedule.test.ts`

**Interfaces:**
- Produces `Routine`, `RoutineRun`, `RoutineStatus`, `RoutineRunStatus`, `RoutineWaitingReason`, `RoutineExecutionMode`, and `RoutineAction`.
- Produces `validateRoutineSchedule(input): ScheduleValidationResult`.
- Produces `nextRoutineOccurrence(schedule, after): Date | null` and `routineOccurrenceKey(routine, scheduledFor): string`.

- [x] **Step 1: Write table-driven tests for manual, once, UTC cron, Toronto DST gap, Toronto repeated hour, invalid six-field cron, invalid timezone, and exhausted once schedules.**

```ts
expect(validateRoutineSchedule({ kind: 'cron', expression: '* * * * * *', timezone: 'UTC' }))
  .toEqual({ ok: false, error: 'invalid_cron_expression' })
expect(routineOccurrenceKey(routine, new Date('2026-11-01T05:30:00.000Z')))
  .toBe('cron:2026-11-01T01:30:00[America/Toronto]')
```

- [x] **Step 2: Run `npx vitest run tests/routine-schedule.test.ts` and verify import failure.**
- [x] **Step 3: Implement the domain discriminated unions and strict five-field cron validation using the installed `cron-schedule` package plus `Intl.DateTimeFormat` for IANA timezone validation.**
- [x] **Step 4: Implement first-occurrence DST deduplication and canonical occurrence keys without parsing natural-language schedules.**
- [x] **Step 5: Run the focused tests and `npm run typecheck`; verify both pass.**
- [x] **Step 6: Commit with `git commit -m "feat: define routine schedule semantics"`.**

### Task 3: Shared Routine Authorization and Policy Service

**Files:**
- Create: `src/routines/access.ts`
- Create: `src/routines/service.ts`
- Create: `tests/routines-service.test.ts`

**Interfaces:**
- Produces `RoutinePrincipal` from `AuthContext` and capability grants.
- Produces `createRoutine`, `updateRoutine`, `enableRoutine`, `pauseRoutine`, `archiveRoutine`, `getRoutine`, `listRoutines`, `createManualRoutineRun`, `getRoutineRun`, and `listRoutineRuns`.
- All mutation functions require an explicit principal and return a stable `RoutineMutationResult<T>` rather than throwing domain errors.

- [x] **Step 1: Write service tests for tenant isolation, hidden unreadable Projects, admin-only policy mutation, writable-squad manual runs, inactive Projects, revision increments, immutable run snapshots, pagination caps, and idempotent manual runs.**

```ts
const first = await createManualRoutineRun(env, principal, routineId, 'manual-key-1')
const replay = await createManualRoutineRun(env, principal, routineId, 'manual-key-1')
expect(replay).toEqual(first)
expect(await getRoutine(otherTenantEnv, principal, routineId)).toBeNull()
```

- [x] **Step 2: Run `npx vitest run tests/routines-service.test.ts` and verify import failure.**
- [x] **Step 3: Implement shared access checks using `projectReadAccessFromGrants`, `projectVisibilityClause`, `hasCapability`, and `project_squad_access`; do not duplicate runtime permission logic.**
- [x] **Step 4: Implement strict field validation, policy snapshots, state transitions, audit fields, and bounded keyset reads.**
- [x] **Step 5: Run the focused tests and typecheck.**
- [x] **Step 6: Commit with `git commit -m "feat: add governed routine policy service"`.**

### Task 4: Atomic Scheduler, Leases, and Recovery

**Files:**
- Create: `src/routines/scheduler.ts`
- Create: `tests/routine-scheduler.test.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.example.toml`

**Interfaces:**
- Produces `runRoutineScheduler(env, now, owner): Promise<RoutineSchedulerSummary>`.
- Produces `claimRoutineRun(env, runId, owner, now): Promise<boolean>` and `recoverExpiredRoutineLeases(env, now): Promise<number>`.
- The Worker cron changes to `* * * * *`; existing maintenance work executes only in canonical fifteen-minute buckets.

- [x] **Step 1: Write tests for duplicate scheduler ticks, 100-row due cap, lease races, lease expiry, active-Project guard, disable/revision race, once exhaustion, overlap `skip`, overlap `queue`, ten-item queue cap, and retry eligibility.**

```ts
await Promise.all([
  runRoutineScheduler(env, now, 'worker-a'),
  runRoutineScheduler(env, now, 'worker-b'),
])
expect(countRuns(routineId, occurrenceKey)).toBe(1)
expect(summary.scanned).toBeLessThanOrEqual(100)
```

- [x] **Step 2: Run `npx vitest run tests/routine-scheduler.test.ts` and verify import failure.**
- [x] **Step 3: Implement atomic occurrence insert, conditional lease update, schedule advancement from `scheduled_for`, bounded retry scans, and terminal skip evidence.**
- [x] **Step 4: Register the scheduler in `src/index.ts`, retain fail-soft isolation for every heartbeat, and change the tracked example cron to one-minute cadence.**
- [x] **Step 5: Run scheduler tests, existing loop/metabolism/cron tests, and typecheck.**
- [x] **Step 6: Commit with `git commit -m "feat: schedule and recover routine runs"`.**

### Task 5: Runtime-Neutral Dispatch

**Files:**
- Create: `src/routines/dispatch.ts`
- Create: `tests/routine-dispatch.test.ts`
- Modify: `src/agents/messages.ts`
- Modify: `src/flight/meta.ts`

**Interfaces:**
- Produces `dispatchRoutineRun(env, runId, now): Promise<RoutineDispatchResult>`.
- Dispatch envelope is exactly `routine.run/v1` with `run_id`, `project_id`, `routine_revision`, `objective`, `situation_digest`, `mcp_endpoint`, and `proposal_schema`.
- Existing agent inbox and Flight are the only runtime boundary; no Claude, Codex, Hermes, or DeerFlow scheduler/session API is imported.

- [x] **Step 1: Write tests for preferred-agent selection, capability-aware fallback, no eligible agent, offline/inbox-full retry, exact Project attribution, stable inbox request ID, Task/Flight references, and absence of credentials/runtime thread IDs.**

```ts
expect(JSON.parse(message.body)).toMatchObject({
  version: 'routine.run/v1', run_id: run.id, project_id: project.id,
  situation_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
})
expect(message.body).not.toMatch(/token|credential|thread_id/i)
```

- [x] **Step 2: Run `npx vitest run tests/routine-dispatch.test.ts` and verify import failure.**
- [x] **Step 3: Implement canonical Situation hashing, responsible-squad eligibility, Task creation through `createTask`, Flight creation through `createFlight`, and delivery through `sendAgentMessage`.**
- [x] **Step 4: Add only Routine correlation fields to the existing canonical Flight metadata contract and preserve all existing runtime adapter tests.**
- [x] **Step 5: Run dispatch, project attribution, inbox, Flight, runtime adapter, and typecheck suites.**
- [x] **Step 6: Commit with `git commit -m "feat: dispatch routine runs to attached agents"`.**

### Task 6: Proposal Validation and Governed Actions

**Files:**
- Create: `src/routines/proposal.ts`
- Create: `src/routines/actions.ts`
- Create: `tests/routine-proposal.test.ts`
- Create: `tests/routine-actions.test.ts`

**Interfaces:**
- Produces `parseRoutineProposal(value): ProposalParseResult` with exact-key rejection and per-action bounds.
- Produces `submitRoutineProposal(env, principal, proposal): Promise<RoutineProposalResult>`.
- Produces `executeRoutineAction(env, runId, actionKey): Promise<RoutineActionResult>`.

- [x] **Step 1: Write adversarial parser tests for unknown keys, oversized text, wrong run/Project/digest, out-of-scope references, ineligible assignees, budget overflow, duplicate action keys, and unsupported action kinds.**
- [x] **Step 2: Write execution tests proving `propose` waits for review, `execute_internal` can only create Project Tasks or Flights, external writes enter the existing gate, `no_action` succeeds, and replay returns the same action result.**

```ts
expect(await submitRoutineProposal(env, wrongAgent, proposal)).toEqual({
  ok: false, error: 'assigned_agent_mismatch',
})
expect(await executeRoutineAction(env, run.id, 'action-1')).toEqual(
  expect.objectContaining({ duplicate: true }),
)
```

- [x] **Step 3: Run both focused test files and verify imports fail.**
- [x] **Step 4: Implement strict parsing, live Situation digest recheck, action reservation, source-specific Task/Flight calls, waiting reasons, retry classification, cancellation, and server-side cost aggregation.**
- [x] **Step 5: Run focused tests plus existing task gate, Flight landing, receipt, and no-secrets suites.**
- [x] **Step 6: Commit with `git commit -m "feat: validate and execute routine proposals"`.**

### Task 7: Needs You Projection

**Files:**
- Create: `src/attention/service.ts`
- Create: `tests/needs-you.test.ts`

**Interfaces:**
- Produces `listNeedsYou(env, principal, options): Promise<NeedsYouPage>`.
- `NeedsYouItem` includes `kind`, source identity, Project identity, title, reason, urgency, responsible party, requester, timestamps, safe URL, and allowed source actions.
- Sources remain authoritative; this task creates no `needs_you` table.

- [x] **Step 1: Write tests covering pending approvals, Routine waits, blocked human-owned tasks, outputs awaiting review, Project filtering, unreadable rows, urgency ordering, keyset continuation, source caps, and truthful truncation.**
- [x] **Step 2: Run `npx vitest run tests/needs-you.test.ts` and verify import failure.**
- [x] **Step 3: Implement bounded per-source queries, normalize rows into one union, globally sort, and issue a signed/validated cursor containing source timestamp/type/id.**
- [x] **Step 4: Verify resolution is absent from this service and existing approval/verdict/answer/budget/cancel services remain the only mutation paths.**
- [x] **Step 5: Run focused tests, approval tests, Project RBAC tests, and typecheck.**
- [x] **Step 6: Commit with `git commit -m "feat: project human attention needs"`.**

### Task 8: Project Situation, Activity, and Evidence

**Files:**
- Modify: `src/projects/situation.ts`
- Modify: `src/projects/projections.ts`
- Modify: `tests/project-situation.test.ts`
- Modify: `tests/project-projections.test.ts`

**Interfaces:**
- Extends `ProjectSituation` with `routines` and `needs_you` summaries.
- Adds Routine events to Activity and terminal/gated Routine receipts to Evidence.
- Updates next-action priority to urgent attention, waiting Routine, blocker/review, active work, next Routine, then empty state.

- [ ] **Step 1: Add failing tests for bounded Routine counts, next occurrence, active/waiting run, latest cost/outcome, attention count, new next-action priority, visibility filtering, and keyset pagination.**
- [ ] **Step 2: Run the two focused suites and confirm failures show missing Routine fields/sources.**
- [ ] **Step 3: Extend the shared Situation loader and projection unions with bounded indexed queries and sanitized metadata.**
- [ ] **Step 4: Run focused suites plus REST/MCP/dashboard Project parity tests.**
- [ ] **Step 5: Commit with `git commit -m "feat: project routine situation and evidence"`.**

### Task 9: REST Surface

**Files:**
- Create: `src/routines/routes.ts`
- Create: `src/attention/routes.ts`
- Create: `tests/routine-routes.test.ts`
- Create: `tests/needs-you-routes.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Adds the REST paths from design sections 11.2 and 11.3.
- Browser mutations enforce CSRF; API mutations that create work require `Idempotency-Key`.
- Every handler delegates to Tasks 3, 6, and 7 rather than embedding SQL.

- [ ] **Step 1: Write route tests for JSON validation, tenant/RBAC hiding, admin mutation, writable-squad Run now, idempotency replay/conflict, exact-agent proposal submission, cancellation, pagination, and Needs You Project filtering.**
- [ ] **Step 2: Run both route test files and verify 404/import failures.**
- [ ] **Step 3: Implement thin Hono routes with common error mapping, request-size bounds, CSRF, stable machine errors, and no-store responses.**
- [ ] **Step 4: Mount both apps before the dashboard catch-all and run focused, OAuth dual-auth, CSRF, and typecheck suites.**
- [ ] **Step 5: Commit with `git commit -m "feat: expose routine and attention APIs"`.**

### Task 10: MCP Parity

**Files:**
- Create: `src/mcp/routines.ts`
- Create: `tests/mcp-routine-tools.test.ts`
- Modify: `src/mcp/index.ts`

**Interfaces:**
- Exports `ROUTINE_TOOLS: ToolSpec[]` containing the tools listed in design section 11.3.
- Uses the same access, service, proposal, action, and Needs You functions as REST.
- Does not expose a generic `needs_you_resolve` tool.

- [ ] **Step 1: Write tests that inspect JSON schemas and exercise every MCP command, including agent proposal binding, cursor bounds, admin floor, writable-squad Run now, and REST/MCP structural parity.**
- [ ] **Step 2: Run `npx vitest run tests/mcp-routine-tools.test.ts` and verify the tools are undiscoverable.**
- [ ] **Step 3: Implement strict tool schemas and handlers in `src/mcp/routines.ts`; append `ROUTINE_TOOLS` to the central registry.**
- [ ] **Step 4: Run focused tests, `tests/mcp-jsonrpc.test.ts`, capability-floor tests, and typecheck.**
- [ ] **Step 5: Commit with `git commit -m "feat: control project routines through MCP"`.**

### Task 11: Project Routines and Needs You Dashboard

**Files:**
- Create: `src/dashboard/routines.ts`
- Create: `src/dashboard/needs-you.ts`
- Create: `tests/dashboard-routines.test.ts`
- Create: `tests/dashboard-needs-you.test.ts`
- Modify: `src/dashboard/projects.ts`
- Modify: `src/dashboard/index.ts`

**Interfaces:**
- Adds a `Routines` Project tab and a global `Needs You` navigation item.
- Forms call the same services and preserve workspace-admin/writable-squad authority.
- Desktop tables use stable columns; mobile uses bounded horizontal scrolling without nested cards.

- [ ] **Step 1: Write HTML/route tests for empty, draft, enabled, paused, waiting, failed, terminal, truncated, unauthorized, validation-error, and mobile-safe states.**
- [ ] **Step 2: Run both focused suites and verify route/render failures.**
- [ ] **Step 3: Implement Project Routine list/detail/form/history views and admin lifecycle POST routes with redirect-after-write.**
- [ ] **Step 4: Implement the Needs You inbox with urgency, Project, responsible party, safe source action links, cursoring, and no direct generic resolution control.**
- [ ] **Step 5: Integrate compact Routine/attention summaries into Project Overview and add `Needs You` beside Work/Approvals in navigation.**
- [ ] **Step 6: Run focused dashboard suites, all Project dashboard tests, accessibility assertions, and typecheck.**
- [ ] **Step 7: Commit with `git commit -m "feat: add routine and attention workspace views"`.**

### Task 12: End-to-End Evidence and Release Integrity

**Files:**
- Create: `scripts/project-routine-lifecycle-receipt.mjs`
- Create: `tests/project-routine-lifecycle-receipt.test.ts`
- Modify: `scripts/local-browser-smoke.mjs`
- Modify: `scripts/local-test-seed.sql`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`
- Modify: `src/version.ts`

**Interfaces:**
- Produces `receipt:project-routine:plan` and `receipt:project-routine:check` commands.
- Evidence identifies the exact commit and proves browser, REST, MCP, scheduler, runtime, restart, authorization, idempotency, cost, Activity, Evidence, and Situation parity.

- [ ] **Step 1: Write receipt tests that reject missing screenshots, mismatched commit/version, incomplete surface parity, absent restart proof, or an unapproved external action.**
- [ ] **Step 2: Run the focused receipt test and verify failure because the script is absent.**
- [ ] **Step 3: Implement deterministic local seeding and receipt validation; add package scripts without changing the package version until release approval.**
- [ ] **Step 4: Start `wrangler dev --local --config wrangler-local-test.toml` on an unused port, run migrations/seed, and exercise the complete manual propose-mode path in desktop and mobile Playwright viewports.**
- [ ] **Step 5: Exercise one scheduled internal-only Routine through an attached conformance runtime, restart the Worker, and collect exact-commit evidence.**
- [ ] **Step 6: Run `npm test`, `npm run typecheck`, migration integrity, no-secrets, local browser smoke, runtime conformance, and the new receipt check.**
- [ ] **Step 7: Update README, roadmap, changelog, and version metadata to describe only verified behavior.**
- [ ] **Step 8: Request independent product/security review; resolve every Critical or Important finding and rerun the exact-commit gates.**
- [ ] **Step 9: Commit with `git commit -m "release: prepare v0.25 project routines"`; do not merge, deploy, tag, or activate a customer pot without separate owner approval.**

## Self-Review Results

- **Spec coverage:** Tasks 1-12 cover every required data, scheduler, runtime, action, attention, Project projection, REST, MCP, dashboard, migration, browser, and release gate. Runtime-harness capabilities are explicitly excluded.
- **Placeholder scan:** The plan contains no deferred implementation placeholders; every task names concrete files, interfaces, tests, commands, and expected outcomes.
- **Type consistency:** `Routine`, `RoutineRun`, `RoutineAction`, `RoutinePrincipal`, `RoutineProposalResult`, `NeedsYouItem`, and their service function names are introduced once and consumed consistently by later tasks.

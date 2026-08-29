# Router, Loop, and Meter Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent authenticated callers from routing tasks, driving loops, reserving execution, or reading spend outside their authorized squad/project/agent domain.

**Architecture:** Introduce one shared execution-authorization resolver that maps authenticated context to server-owned squad/project/agent scope. Router and loop mutation entry points call it before work; public meter tools expose self/observer reads only, while reservation remains an internal authorized execution seam with durable caps.

**Tech Stack:** TypeScript, D1 capability/project membership queries, MCP, scheduled Worker entry points, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start from the merged governance/2FA descendant after Loom Slice 4 GO.
- A valid bearer token is authentication, not authorization.
- Dry-run router reads require observer on the named squad; mutation requires lead/admin or internal scheduled authority.
- All-loop and tenant-wide sweeps are org-admin/internal only.
- Caller inputs cannot choose another agent's meter reservation or override durable caps/windows.

---

### Task 1: Create the Shared Execution Authorization Resolver

**Files:**
- Create: `src/auth/execution-authorization.ts`
- Test: `tests/execution-authorization.test.ts`
- Read: `src/auth/capability.ts`
- Read: `src/types.ts`

**Interfaces:**
- Consumes: `AuthContext`, target `squadId`, optional `projectId`/`agentId`, action, and internal-trigger proof.
- Produces: `authorizeExecutionScope(env, auth, request): Promise<ExecutionAuthorization>`.

- [ ] **Step 1: Define the closed action union**

```ts
export type ExecutionAction =
  | 'router:read'
  | 'router:mutate'
  | 'loop:mutate'
  | 'meter:read'
  | 'meter:reserve'

export type ExecutionAuthorization =
  | { ok: true; tenant: string; squadId: string; projectId: string | null; agentId: string | null; source: 'member' | 'agent' | 'internal' }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' }
```

- [ ] **Step 2: Write matrix tests**

Cover observer read/no mutation, lead/admin same-squad mutation, cross-squad denial, org-admin tenant sweep, internal scheduled success, arbitrary “internal” caller flag rejection, agent self-meter read, observer read of squad agent, and cross-squad spend denial.

- [ ] **Step 3: Confirm RED, implement joins, and mutation-check**

Run `npx vitest run tests/execution-authorization.test.ts`. Resolve squad/project/agent relationships before capability evaluation; derive internal authority from the server-owned scheduled entry point, never MCP args. Temporarily skip the squad equality predicate; cross-squad tests must fail. Restore.

- [ ] **Step 4: Commit**

```bash
git add src/auth/execution-authorization.ts tests/execution-authorization.test.ts
git commit -m "feat(auth): resolve execution scope"
```

### Task 2: Fence Router Reads and Mutations

**Files:**
- Create: `src/router/engine.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/index.ts`
- Test: `tests/router-authorization.test.ts`

**Interfaces:**
- Consumes: `RouterTickInput { squadId: string; dryRun: boolean; limit?: number }` and `ExecutionAuthorization`.
- Produces: `runRouterTick(env, authz, input): Promise<RouterTickResult>`; server-owned scheduled entry point for internal sweep.

- [ ] **Step 1: Write adversarial router tests**

Seed two squads, tasks, active/inactive agents, and memberships. Assert observer dry-run success; observer mutation denial; lead same-squad success; cross-squad task/agent denial; inactive/unauthorized assignee skipped; and no fallback crossing squad boundaries.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/router-authorization.test.ts`

- [ ] **Step 3: Implement scoped candidate selection**

All task and agent SQL includes `tenant = ? AND squad_id = ?`. Candidate agents must be active and hold live membership/capability for the task squad. Return an explicit unassigned decision when none match; never fall back globally.

- [ ] **Step 4: Wire MCP and scheduled paths**

`router_tick` accepts `squad_id`, `dry_run`, and `limit`; no tenant/internal/role fields. The scheduled handler constructs internal authority in code and may iterate squads. The REST route must use the same resolver.

- [ ] **Step 5: Verify, mutation-check, and commit**

Temporarily remove the candidate-agent squad predicate; the cross-squad assignment test must fail. Restore.

```bash
npx vitest run tests/router-authorization.test.ts tests/tasks-cross-squad-assignment.test.ts
git add src/router/engine.ts src/mcp/index.ts src/index.ts tests/router-authorization.test.ts
git commit -m "fix(router): enforce squad authority"
```

### Task 3: Fence Loop Driver Scope

**Files:**
- Modify: `src/loops/driver.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/loop-driver-authorization.test.ts`

**Interfaces:**
- Consumes: `LoopTickInput { loopId?: string }`, resolved loop/project/squad, and `ExecutionAuthorization`.
- Produces: `runAuthorizedLoopTick(env, authz, loopId)` and internal-only `runLoopsTick(env, internalAuthz)`.

- [ ] **Step 1: Write loop authorization tests**

Assert explicit loop resolution occurs before authorization, owner/admin same-squad succeeds, another squad fails, missing loop returns the same `404` for otherwise authorized callers, ordinary authenticated all-loop sweep fails, and scheduled internal sweep succeeds.

- [ ] **Step 2: Confirm RED and implement**

Run: `npx vitest run tests/loop-driver-authorization.test.ts`.

Resolve `loopId -> projectId -> squadId`, authorize that domain, then execute. When `loopId` is absent, require org-admin or internal authority before enumerating loops.

- [ ] **Step 3: Mutation-check and commit**

Temporarily authorize before resolving the loop; the existence-oracle test must fail. Restore.

```bash
npx vitest run tests/loop-driver-authorization.test.ts tests/loop-driver.test.ts
git add src/loops/driver.ts src/mcp/index.ts tests/loop-driver-authorization.test.ts
git commit -m "fix(loops): fence driver scope"
```

### Task 4: Separate Meter Read From Reservation Authority

**Files:**
- Modify: `src/agents/meter.ts`
- Modify: `src/agents/execute.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/meter-authorization.test.ts`

**Interfaces:**
- Consumes: authenticated context for status; internal `AuthorizedExecution { tenant, agentId, squadId, projectId, policy }` for reservation.
- Produces: `getAuthorizedMeterStatus` and internal `checkAndReserve(env, authorizedExecution)`.

- [ ] **Step 1: Write adversarial meter tests**

Assert self-status succeeds only for `auth.boundAgentId`; another agent requires observer on that agent's squad; spend details do not leak cross-squad; public reservation tool is absent; and caller-provided cap/window/agent inputs are ignored or rejected.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/meter-authorization.test.ts`

- [ ] **Step 3: Refactor reservation input**

```ts
export interface AuthorizedExecution {
  tenant: string
  agentId: string
  squadId: string
  projectId: string
  maxDispatchDay: number
  maxTokensDay: number
  maxCostMicroUsdWeek: number
}
```

Construct it only after task/agent/squad authorization inside `src/agents/execute.ts`. Read caps from durable agent/project policy and environment defaults; no MCP argument can override them.

- [ ] **Step 4: Mutation-check and commit**

Temporarily accept `args.agent_id` for self-status; the cross-agent test must fail. Restore.

```bash
npx vitest run tests/meter-authorization.test.ts tests/execution-meter.test.ts
git add src/agents/meter.ts src/agents/execute.ts src/mcp/index.ts tests/meter-authorization.test.ts
git commit -m "fix(meter): bind execution authority"
```

### Task 5: Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/router-loop-meter-exact-head.md`

**Interfaces:**
- Produces: authorization matrix, mutation witnesses, full-suite, Lumen, Athena, and Loom evidence.

- [ ] **Step 1: Run focused and full gates**

```bash
npx vitest run tests/execution-authorization.test.ts tests/router-authorization.test.ts tests/loop-driver-authorization.test.ts tests/meter-authorization.test.ts
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Gate and stop**

Commit receipt, push, open draft PR, obtain green required checks, Lumen review, Athena exact-head Artifact+SHA256, and Loom composition. Stop for Hadi.

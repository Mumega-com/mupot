# Router, Loop, and Meter Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add squad/project-fenced task routing and scoped meter status/reservation while keeping loop execution internal-only.

**Architecture:** A narrow resolver maps authenticated server context to router or meter scope. The router selects candidates only inside the authorized squad/project and conditionally claims tasks before waking. Meter reads are self/lead/admin scoped, reservation accepts only server-built policy, and no public loop-driver or arbitrary-agent reservation tool exists.

**Tech Stack:** TypeScript, Hono, MCP ToolSpec, D1/SQLite, existing capability/project access services, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-router-loop-meter-authorization-design.md`

## Global Constraints

- Start from freshly fetched current `origin/main`; do not stack on unmerged work.
- PR #1236 is read-only donor evidence; cherry-pick no donor commit or migration.
- Public router requests require one explicit `squad_id`; no public tenant sweep exists.
- Dry-run requires squad observer; mutation requires squad lead; REST mutation requires org-admin.
- Router candidates and tasks remain inside the authorized squad and writable active project.
- Emit wake and increment assigned count only after a conditional task claim reports `changes === 1`.
- Register no public `loop_driver_tick` and no arbitrary-agent meter reservation tool.
- Meter status is bound-agent self, same-squad lead, or org-admin; durable server policy owns caps/windows.
- No migration, merge, deploy, credential action, production mutation, or branch-protection change without separate Hadi approval.

---

### Task 1: Resolve Router and Meter Scope

**Files:**
- Create: `src/auth/execution-scope.ts`
- Test: `tests/execution-scope.test.ts`
- Read: `src/auth/capability.ts`
- Read: `src/mcp/index.ts`
- Read: `src/projects/access.ts`

**Interfaces:**
- Consumes: `Env`, `AuthContext`, and `ExecutionScopeRequest`.
- Produces: `authorizeExecutionScope(env, auth, request): Promise<ExecutionScopeDecision>`.

- [ ] **Step 1: Write the closed request and decision types plus failing matrix tests**

```ts
export type ExecutionScopeRequest =
  | { action: 'router:read'; squadId: string }
  | { action: 'router:mutate'; squadId: string }
  | { action: 'meter:read'; agentId: string }

export type ExecutionScopeDecision =
  | { ok: true; tenant: string; squadId: string; agentId: string | null; source: 'principal' }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' }
```

Seed two squads and agents through `createSqliteD1()` plus `applyAllMigrations()`. Test observer router read, member mutation denial, same-squad lead mutation, cross-squad lead denial, bound-agent self meter read, same-squad lead meter read, cross-squad meter denial, and org-admin success.

- [ ] **Step 2: Run the matrix and confirm RED for missing resolver**

```bash
npx vitest run tests/execution-scope.test.ts
```

Expected: import/function-not-found failure before implementation.

- [ ] **Step 3: Implement server-derived relationships and capability checks**

Resolve squad/agent rows from D1 before capability evaluation. Reuse the existing capability ladder and active membership rules. Never accept `tenant`, role, internal authority, project authority, or bound agent from request JSON.

- [ ] **Step 4: Mutation-check cross-squad confinement**

Temporarily remove agent/squad equality from `meter:read`. The cross-squad lead test must fail by exposing status. Restore the predicate and rerun:

```bash
npx vitest run tests/execution-scope.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/auth/execution-scope.ts tests/execution-scope.test.ts
git commit -m "feat(auth): resolve execution scope"
```

### Task 2: Implement the Squad-Fenced Router

**Files:**
- Create: `src/router/engine.ts`
- Create: `src/router/routes.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/index.ts`
- Test: `tests/router-authorization.test.ts`

**Interfaces:**
- Consumes: authorized squad scope and `RouterTickInput`.
- Produces: `runRouterTick(env, decision, input): Promise<RouterTickResult>`; MCP `router_tick`; org-admin REST `POST /api/router/tick`.

- [ ] **Step 1: Write failing adversarial router tests**

Use migration-backed SQLite to seed two squads, active/inactive projects, project access, tasks, active agents, and presence. Add these exact cases:

```ts
it('rejects member mutation before reading candidates')
it('rejects lead of another squad')
it('requires squad_id and never performs a tenant sweep')
it('leaves inaccessible project tasks unrouted')
it('never chooses a candidate from another squad')
it('lost concurrent claim neither wakes nor increments assigned')
it('dry-run performs zero writes and wakes')
```

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run tests/router-authorization.test.ts
```

- [ ] **Step 3: Implement bounded input and candidate query**

```ts
export interface RouterTickInput {
  squadId: string
  dryRun: boolean
  limit?: number
}
```

Clamp limit to `1..50`. Select only open, unassigned tasks for the authorized squad. For project tasks, require active project plus write/admin access by the task squad. Select only active same-squad agents with active presence. Ranking may use continuum/model but cannot widen candidates.

- [ ] **Step 4: Implement conditional claim and wake ordering**

```sql
UPDATE tasks
   SET assignee_agent_id = ?1, updated_at = ?2
 WHERE id = ?3 AND squad_id = ?4
   AND status = 'open' AND assignee_agent_id IS NULL
```

When `changes !== 1`, record `lost_claim`; do not wake and do not increment assigned. Dry-run records `would_assign` and executes neither update nor wake.

- [ ] **Step 5: Wire public MCP and REST boundaries**

MCP schema accepts only `squad_id`, `dry_run`, and `limit`; `squad_id` is required. MCP resolves observer for dry-run and lead for mutation. REST route runs `requireAuth` and `isOrgAdmin`, requires `squad_id`, then calls the same engine. Mount the child route as `/tick` under `/api/router`, never `/api/router/tick` under that parent.

- [ ] **Step 6: Mutation-check and commit**

Remove the task-squad predicate once; the cross-squad test must fail. Restore and run:

```bash
npx vitest run tests/router-authorization.test.ts tests/tasks-cross-squad-assignment.test.ts
git add src/router/engine.ts src/router/routes.ts src/mcp/index.ts src/index.ts tests/router-authorization.test.ts
git commit -m "feat(router): fence task routing"
```

### Task 3: Keep Loop Execution Internal-Only

**Files:**
- Modify: `src/mcp/index.ts`
- Modify: `src/index.ts`
- Test: `tests/loop-driver-public-boundary.test.ts`

**Interfaces:**
- Consumes: existing scheduled `runLoopsTick` integration.
- Produces: explicit absence proof for public loop-driver surfaces.

- [ ] **Step 1: Write public-absence and scheduled-presence tests**

```ts
it('does not register loop_driver_tick in MCP tools')
it('does not mount a loop-driver REST tick route')
it('scheduled execution still invokes runLoopsTick internally')
```

Drive actual tool discovery and route registration rather than searching strings alone.

- [ ] **Step 2: Confirm the donor-shaped mutation would fail**

Temporarily register a dummy authenticated `loop_driver_tick`; the public-absence test must fail. Remove it.

- [ ] **Step 3: Make only required boundary edits**

Do not rewrite the loop driver. Remove or refuse any donor-shaped public registration encountered during manual porting. Preserve current scheduled dispatch and existing loop lifecycle/control authorization.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/loop-driver-public-boundary.test.ts tests/loop-driver.test.ts tests/loop-control-tool.test.ts
git add src/mcp/index.ts src/index.ts tests/loop-driver-public-boundary.test.ts
git commit -m "test(loops): keep driver internal"
```

### Task 4: Separate Meter Read From Reservation

**Files:**
- Modify: `src/agents/meter.ts`
- Modify: `src/agents/execute.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/meter-authorization.test.ts`

**Interfaces:**
- Consumes: `AuthContext` for public status; `AuthorizedExecution` for internal reservation.
- Produces: scoped `execution_meter_status`; server-only `checkAndReserve(env, authorizedExecution)`.

- [ ] **Step 1: Write failing status and reservation boundary tests**

```ts
it('bound agent reads only its own meter status')
it('unbound member cannot choose an arbitrary agent')
it('same-squad lead reads a target agent')
it('cross-squad lead cannot read spend or counts')
it('org-admin reads a tenant agent')
it('does not register a public execution_meter_check tool')
it('caller cap and window fields cannot reach reservation')
```

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run tests/meter-authorization.test.ts
```

- [ ] **Step 3: Implement status confinement**

An omitted target uses `auth.boundAgentId`; missing binding is `403`. A supplied target is permitted only for same-squad lead-or-higher or org-admin. Resolve authorization before querying `execution_meter` rows.

- [ ] **Step 4: Refactor internal reservation input**

```ts
export interface AuthorizedExecution {
  tenant: string
  agentId: string
  squadId: string
  projectId: string | null
  maxDispatchDay: number
  maxTokensDay: number
  maxCostMicroUsdWeek: number
}
```

Construct it in the authorized execution orchestrator from persisted policy and server defaults. Accept no MCP/REST JSON object of this type. Preserve the meter's existing atomic check-and-reserve statement.

- [ ] **Step 5: Mutation-check and commit**

Temporarily use caller `agent_id` for an unbound member; the arbitrary-agent test must fail. Restore and run:

```bash
npx vitest run tests/meter-authorization.test.ts tests/execution-meter.test.ts
git add src/agents/meter.ts src/agents/execute.ts src/mcp/index.ts tests/meter-authorization.test.ts
git commit -m "feat(meter): bind status and reservation"
```

### Task 5: Verify and Package the Exact Head

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/router-loop-meter-exact-head.md`

**Interfaces:**
- Produces: one exact-head evidence packet for internal review and Athena.

- [ ] **Step 1: Run focused security evidence**

```bash
npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/loop-driver-public-boundary.test.ts tests/meter-authorization.test.ts
```

- [ ] **Step 2: Run repository-wide gates**

```bash
npm run typecheck
npm test
node scripts/no-secrets.mjs
node --test tests/test-schema-source.test.mjs
node scripts/check-test-schema-source.mjs
node --test tests/migration-numbering.test.mjs
BASE_REF=main node scripts/check-migration-numbering.mjs
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

Every command must exit 0. Focused green does not override a red repository command.

- [ ] **Step 3: Record mutation evidence and review**

Write exact base/head SHAs, test names, mutation witnesses, command exits, and caveats in the receipt. Commit it, obtain internal review with no unresolved Critical/Important finding, and request Athena `GREEN`, `BLOCK`, or `RESHAPE` bound to Artifact+SHA256.

- [ ] **Step 4: Stop for Hadi**

Open or update only the bounded draft PR. Do not merge, deploy, use credentials, mutate production, or begin the next slice without separate authorization.

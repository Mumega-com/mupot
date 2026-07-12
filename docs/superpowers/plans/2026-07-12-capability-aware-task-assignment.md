# Capability-Aware Cross-Squad Task Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an active agent to own tasks in any squad where its one active bound member identity holds effective `member` authority, while preserving home-squad compatibility and current runtime authorization.

**Architecture:** Add one shared assignment-policy module under `src/tasks/` and make both HTTP and MCP task surfaces delegate to it. Home-squad agents remain token-independent; cross-squad agents resolve through the existing active member weld and capability inheritance. Extend MCP task creation with optional assignment and prove the complete grant, bearer reload, assignment, and governed-flight lifecycle.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/D1, Vitest, Node 22 `node:sqlite`, existing Mupot member/capability services.

## Global Constraints

- Tenant scope comes only from `env.TENANT_SLUG`.
- Cross-squad identity requires exactly one active member identity, not one token.
- Assignment never changes `agents.squad_id` or creates a second membership plane.
- Home-squad assignment accepts active agents without requiring a token.
- Cross-squad assignment requires effective `member` or higher on the target squad.
- Public failures remain `invalid_assignee` or `assignee_not_in_squad`; do not disclose identity cardinality.
- No migration, raw credential response, credential mutation, or unrelated refactor.
- Capability revocation prevents future assignment but does not rewrite historical tasks.

---

### Task 1: Shared Capability-Aware Assignee Policy

**Files:**
- Create: `src/tasks/assignee.ts`
- Create: `tests/task-assignee-sqlite.test.ts`
- Create: `tests/tasks-cross-squad-assignment.test.ts`
- Modify: `src/tasks/index.ts`
- Modify: `tests/tasks-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveActiveAgentMember(env, agentId)`, `resolveCapabilities(env, memberId)`, and `hasCapability(grants, 'squad', squadId, 'member', departmentId)`.
- Produces: `resolveTaskAssignee(env: Env, raw: unknown, squadId: string): Promise<AssigneeResult>` and compatibility re-export `resolveAssignee` from `src/tasks/index.ts`.

- [ ] **Step 1: Write real SQLite tests for the assignment matrix**

Create `tests/task-assignee-sqlite.test.ts` with the existing `createSqliteD1()` helper. Build minimal `squads`, `agents`, `members`, `member_tokens`, `capabilities`, and `channel_capability_grants` tables and seed helpers. Test:

```ts
expect(await resolveTaskAssignee(env, HOME_AGENT_ID, HOME_SQUAD_ID))
  .toEqual({ value: HOME_AGENT_ID })

expect(await resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID))
  .toEqual({ value: CROSS_AGENT_ID })
```

Cover exact-squad, department, org, and channel `member` grants; duplicate tokens for one member; inactive agent; no token; ambiguous members; suspended member; revoked-only token; wrong token/member tenant; observer-only grant; no grant; and revocation of the last effective grant. Assert failures equal:

```ts
{ value: null, error: 'assignee_not_in_squad' }
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npx vitest run tests/task-assignee-sqlite.test.ts
```

Expected: FAIL because `src/tasks/assignee.ts` and `resolveTaskAssignee` do not exist.

- [ ] **Step 3: Implement the shared resolver**

Create `src/tasks/assignee.ts` with this contract:

```ts
export interface AssigneeResult {
  value: string | null
  error?: 'invalid_assignee' | 'assignee_not_in_squad'
}

export async function resolveTaskAssignee(
  env: Env,
  raw: unknown,
  squadId: string,
): Promise<AssigneeResult>
```

Implementation order:

```ts
if (raw === undefined || raw === null) return { value: null }
if (typeof raw !== 'string' || raw.length === 0) return invalid

const agent = await env.DB.prepare(
  'SELECT id, squad_id, status FROM agents WHERE id = ?1 LIMIT 1',
).bind(raw).first<Pick<Agent, 'id' | 'squad_id' | 'status'>>()

if (!agent) return invalid
if (agent.status !== 'active') return outside
if (agent.squad_id === squadId) return { value: agent.id }

const memberId = await resolveActiveAgentMember(env, agent.id)
if (memberId === 'unminted' || memberId === 'ambiguous') return outside

const squad = await env.DB.prepare(
  'SELECT department_id FROM squads WHERE id = ?1 LIMIT 1',
).bind(squadId).first<{ department_id: string }>()
if (!squad) return outside

const grants = await resolveCapabilities(env, memberId)
return hasCapability(grants, 'squad', squadId, 'member', squad.department_id)
  ? { value: agent.id }
  : outside
```

Use constants for the two failure objects only if they remain immutable and type-safe.

- [ ] **Step 4: Run SQLite tests and verify GREEN**

Run:

```bash
npx vitest run tests/task-assignee-sqlite.test.ts
```

Expected: all assignment matrix tests pass.

- [ ] **Step 5: Replace the HTTP-local policy and preserve its public export**

In `src/tasks/index.ts`:

```ts
import { resolveTaskAssignee } from './assignee'
export { resolveTaskAssignee as resolveAssignee } from './assignee'
```

Replace both create and update calls to the local `resolveAssignee` with `resolveTaskAssignee`, then delete the local `AssigneeResult` and resolver. Update comments from “same squad” to “assignable on the task squad.”

Update `tests/tasks-dispatch.test.ts` so the home-squad mock includes `status: 'active'`, add inactive home-squad rejection, and change the different-squad test into a fail-closed unminted cross-squad test. SQLite tests own the positive cross-squad matrix.

Create `tests/tasks-cross-squad-assignment.test.ts` with `createSqliteD1()`, an owner session KV stub,
and the minimal task schema. Drive `tasksApp.fetch()` to prove both:

```ts
POST / // body includes assignee_agent_id for a capability-granted agent
PATCH /:id // body changes assignee_agent_id to that agent
```

Assert both responses contain the cross-squad agent ID and the persisted task rows match. Add an
observer-only route case that returns `400 assignee_not_in_squad` without changing the task.

- [ ] **Step 6: Run HTTP and assignment suites**

Run:

```bash
npx vitest run tests/task-assignee-sqlite.test.ts tests/tasks-dispatch.test.ts tests/tasks-cross-squad-assignment.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/tasks/assignee.ts src/tasks/index.ts tests/task-assignee-sqlite.test.ts tests/tasks-dispatch.test.ts tests/tasks-cross-squad-assignment.test.ts
git commit -m "feat(tasks): authorize cross-squad assignees"
```

---

### Task 2: MCP Assignment and Governed Flight Acceptance

**Files:**
- Modify: `src/mcp/index.ts`
- Modify: `tests/mcp-task-tools.test.ts`
- Modify: `tests/mcp-flight-tools.test.ts`
- Modify: `docs/runtime-adapter-contract.md`

**Interfaces:**
- Consumes: `resolveTaskAssignee` from Task 1.
- Produces: MCP `task_create` optional `assignee_agent_id: string`; both MCP task mutations use the shared policy.

- [ ] **Step 1: Write failing MCP schema and behavior tests**

In `tests/mcp-task-tools.test.ts`, assert `task_create.inputSchema.properties` includes:

```ts
assignee_agent_id: { type: 'string' }
```

Add tests proving `task_create` passes a resolved assignee into `createTask`, and `task_update` accepts a cross-squad agent only after the DB seam exposes one active bound member and a target-squad `member` grant. Add fail-closed tests for no active member and observer-only authority.

- [ ] **Step 2: Write the failing bearer-authenticated flight assertion**

In the SQLite-backed lifecycle test in `tests/mcp-flight-tools.test.ts`, remove the pre-seeded cross-squad assignment. After `grant_agent_capability`, call through `mcpApp.request()` with the same Product bearer:

```ts
const assigned = await authenticatedTool(env, 'task_update', {
  task_id: 'task-m000',
  assignee_agent_id: AGENT_ID,
})
expect(assigned).toMatchObject({
  ok: true,
  result: { task: { assignee_agent_id: AGENT_ID } },
})
```

Keep dispatch, read, completion, and landing authenticated through separate requests. Assert the persisted task is assigned and done.

- [ ] **Step 3: Run focused MCP tests and verify RED**

Run:

```bash
npx vitest run tests/mcp-task-tools.test.ts tests/mcp-flight-tools.test.ts
```

Expected: schema/creation tests fail because `task_create` has no assignment argument, and cross-squad update fails through the old MCP-local resolver.

- [ ] **Step 4: Delegate MCP to the shared resolver**

In `src/mcp/index.ts`:

```ts
import { resolveTaskAssignee } from '../tasks/assignee'
```

Delete the private `resolveTaskAssignee` function. Extend `toolTaskCreate`:

```ts
args: '{ squad_id: string, title: string, done_when: string, body?: string, assignee_agent_id?: string }'

properties: {
  // existing properties
  assignee_agent_id: STRING_SCHEMA,
}
```

Before `createTask`, resolve `args.assignee_agent_id` against `squad.id`; map resolver errors through `fail(400, check.error)`. Pass:

```ts
assignee_agent_id: assignee.value,
```

Keep `task_update` behavior and replace only its resolver call with the shared helper.

- [ ] **Step 5: Update the runtime adapter contract**

Document that task assignment is capability-aware, home-squad compatible, and exposed on both `task_create` and `task_update`. State that assignment does not grant authority and current capabilities are reloaded on every authenticated action.

- [ ] **Step 6: Run focused suites and verify GREEN**

Run:

```bash
npx vitest run tests/task-assignee-sqlite.test.ts tests/tasks-dispatch.test.ts tests/mcp-task-tools.test.ts tests/mcp-flight-tools.test.ts tests/runtime-adapter-contract.test.ts
npm run typecheck
git diff --check
```

Expected: all focused tests, typecheck, and diff check pass.

- [ ] **Step 7: Run the full repository suite**

Run:

```bash
npx vitest run --maxWorkers=2
```

Expected: all test files and tests pass with zero failures. The Node 22 experimental SQLite warning is expected from test-only `node:sqlite`.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/mcp/index.ts tests/mcp-task-tools.test.ts tests/mcp-flight-tools.test.ts docs/runtime-adapter-contract.md
git commit -m "feat(mcp): assign capability-granted agents"
```

---

### Task 3: Review and Production Proof Preparation

**Files:**
- Modify only files required by independent review findings.

**Interfaces:**
- Consumes: completed Task 1 and Task 2 commits.
- Produces: merge-ready branch with no Critical or Important review findings and reproducible production proof instructions.

- [ ] **Step 1: Request independent whole-branch review**

Review the merge-base-to-HEAD diff against the design spec and issue #338. Explicitly inspect tenant isolation, identity cardinality, inactive behavior, capability inheritance, information disclosure, MCP schema compatibility, and the bearer-authenticated assigned-flight test.

- [ ] **Step 2: Resolve every Critical or Important finding test-first**

For each valid finding, add a failing regression test, observe the expected failure, implement the narrow correction, and rerun the affected suite. Minor documentation mismatches should be corrected before publication; unrelated refactors remain out of scope.

- [ ] **Step 3: Run final verification**

```bash
npx vitest run --maxWorkers=2
npm run typecheck
git diff --check $(git merge-base HEAD main)..HEAD
git status --short
```

Expected: full suite passes, typecheck passes, diff check is silent, and tracked worktree is clean after the final commit.

- [ ] **Step 4: Publish through PR and deploy after green checks**

Push `codex/capability-aware-task-assignment`, open a draft PR closing #338, wait for CI/CodeQL, mark ready, merge, fast-forward canonical `main`, run Wrangler strict dry-run, deploy with `wrangler.mumega.toml`, and verify both health endpoints.

- [ ] **Step 5: Run assigned VPS Codex production flight**

Use the existing VPS Codex credential and identity. Create a new Build Integration task with a verifiable `done_when`, assign it to VPS Codex, dispatch a zero-budget flight spanning Runtime Fleet and Build Integration, complete the assigned task, and land the flight. Verify D1 task assignment, task timestamps, flight status, outbox delivery/consumption, presence, and both capability grants.

- [ ] **Step 6: Record private evidence**

Add a credential-free receipt under `mumega.com/docs/proofs/mupot-m1/`, update the M1 manifest without silently replacing its Product-specific condition, validate JSON and hashes, run a secret scan, commit, and push the private evidence branch.

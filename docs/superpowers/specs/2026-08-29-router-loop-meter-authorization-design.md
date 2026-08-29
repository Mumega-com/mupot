# Router, Loop, and Meter Authorization Design

Status: approved in chat by Hadi on 2026-08-29; written-spec review pending.

## Objective

Replace PR #1236's unauthenticated-domain router, public loop tick, and arbitrary-agent meter tools with a bounded current-main slice whose authority comes from authenticated server state.

The slice must make automated routing useful without allowing one valid bearer to assign another squad's work, wake another squad's agent, exhaust another agent's quota, inspect cross-squad spend, or run tenant-wide loops. PR #1236 remains donor evidence only and is neither merged nor extended.

## Current boundary

- Base source is current `origin/main` at slice creation time; the approved design was evaluated at `41330115de7304c95654f57949b41c24761b2e8f`.
- Current main already owns tasks, projects, `project_squad_access`, agents, presence, loops, execution metering, capability resolution, scheduled loop execution, and task wake events.
- PR #1236 adds router/loop/meter surfaces, but its MCP tools use `min: 'authenticated'`, accept arbitrary targets, and do not enforce squad/project/agent authority.
- The replacement manually implements only the approved behavior. It does not cherry-pick donor migrations, tools, receipts, or broad engine rewrites.
- No merge, deploy, credential action, production mutation, or branch-protection change is part of this design.

## Decisions

### 1. Router scope is always explicit

The public router accepts one required `squad_id`. It never offers an omitted-squad or tenant-wide mode.

- Read-only dry-run requires observer-or-higher authority on that squad.
- Mutation requires lead-or-higher authority on that squad.
- REST mutation is org-admin only and still requires a named squad.
- This slice does not add an autonomous scheduled router sweep. Scheduling router mutation is a separate operational design because cadence and blast radius require their own approval.

The public result reports only the named squad's scanned, assigned, and unrouted tasks. It does not reveal other squads' agents, presence, spend, projects, or task counts.

### 2. Router candidates are fenced by task, squad, project, and liveness

For each open unassigned task:

1. `task.squad_id` must equal the authorized squad.
2. If `task.project_id` is non-null, the same squad must hold `write` or `admin` in `project_squad_access` and the project must be active.
3. A candidate agent must be active, belong to the same squad, and have active presence for that exact agent.
4. Desired continuum/model matching may rank candidates but cannot widen the candidate set.
5. No candidate means `unrouted`; no fallback may cross squad boundaries.

Mutation uses one conditional task claim:

```sql
UPDATE tasks
   SET assignee_agent_id = ?1, updated_at = ?2
 WHERE id = ?3
   AND squad_id = ?4
   AND status = 'open'
   AND assignee_agent_id IS NULL
```

The router increments `assigned` and emits the wake only when `meta.changes === 1`. A concurrent loser neither wakes nor claims success.

### 3. There is no public loop-driver tick

The current scheduled handler already owns tenant loop execution through `runLoopsTick`. The replacement does not register `loop_driver_tick` in MCP or REST.

- Scheduled loop execution remains internal.
- Existing explicit loop lifecycle/control surfaces continue using their established owner/admin predicates.
- Recovery of one loop, if later required, is a separate design. This slice does not create a public all-loop or one-loop execution bypass.

Tests must prove `loop_driver_tick` is absent from the registered tool list and that the scheduled path still invokes `runLoopsTick`.

### 4. Meter status and reservation are separate authority questions

Public status:

- An agent-bound caller may read only `auth.boundAgentId`.
- A lead-or-higher caller may read an agent in a squad they control.
- Org-admin may read any agent in the tenant.
- Unbound ordinary members, cross-squad leads, and caller-selected foreign agents fail before spend rows are read.

Reservation:

- No public MCP `execution_meter_check` or equivalent arbitrary-agent reservation tool is registered.
- Reservation is called only from an already-authorized execution path that supplies a server-built `AuthorizedExecution` value.
- Agent, squad, project, cap, and window come from persisted agent/project policy plus server defaults. Caller arguments cannot override them.
- The existing meter's atomic check-and-reserve behavior remains load-bearing.

### 5. Shared resolver is narrow and server-owned

A small resolver centralizes repeated identity-to-scope checks without inventing a universal policy engine.

```ts
export type ExecutionScopeRequest =
  | { action: 'router:read'; squadId: string }
  | { action: 'router:mutate'; squadId: string }
  | { action: 'meter:read'; agentId: string }

export type ExecutionScopeDecision =
  | { ok: true; tenant: string; squadId: string; agentId: string | null; source: 'principal' }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' }
```

The resolver has no serializable or internal-authority escape. It resolves target records before returning authority, but denial responses must not expose cross-squad target metadata.

## Interfaces

### Router engine

```ts
export interface RouterTickInput {
  squadId: string
  dryRun: boolean
  limit?: number
}

export interface RouterTickResult {
  squad_id: string
  dry_run: boolean
  scanned: number
  assigned: number
  unrouted: number
  decisions: Array<{
    task_id: string
    outcome: 'would_assign' | 'assigned' | 'unrouted' | 'lost_claim'
    agent_id: string | null
  }>
}
```

Public limits are bounded server-side to `1..50`. Dry-run performs zero task, wake, flight, or meter mutations.

### Meter status

```ts
export async function getAuthorizedMeterStatus(
  env: Env,
  auth: AuthContext,
  agentId?: string,
): Promise<ToolOutcome>
```

An omitted `agentId` uses `auth.boundAgentId` and fails closed when no binding exists.

### Internal reservation

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

Only the execution orchestrator constructs this value after task, project, squad, and agent authorization. It is not accepted from JSON or MCP arguments.

## Error semantics

- Malformed or omitted public `squad_id`: `400 invalid_args`.
- Existing target outside caller authority: `403 forbidden`; do not return target details.
- Authorized caller naming a missing target: `404 not_found`.
- Lost task claim: success response with decision `lost_claim`, no wake and no assigned increment.
- Infrastructure failure: `503`; never map it to authorization denial or successful empty result.
- Meter denial occurs before querying execution counts or spend.

## Adversarial verification

Router tests mutation-check member mutation denial, cross-squad lead denial, required squad scope, task/agent squad equality, project write access, inactive projects and agents, conditional-claim loss, and dry-run no-effects.

Loop tests prove `loop_driver_tick` is absent from MCP and REST while scheduled execution still invokes the existing internal loop driver.

Meter tests mutation-check bound-agent self-read, cross-squad denial before meter query, same-squad lead and org-admin reads, public reservation-tool absence, caller cap rejection, and durable server-policy authority.

## Slice and review boundaries

The implementation may use two behavior commits in one bounded PR: resolver/router first, then meter and loop-public-absence boundaries. No new migration is expected. If implementation discovers an unavoidable schema requirement, stop and return `RESHAPE` for explicit approval rather than reusing a donor migration.

Before publication, the exact head must have focused adversarial and mutation evidence; typecheck and complete Vitest exit 0; local evidence and every repository guard exit 0; no unresolved internal Critical/Important review finding; and Athena `GREEN`, `BLOCK`, or `RESHAPE` bound to Artifact+SHA256.

The PR remains draft and unmerged until Hadi separately authorizes merge. Athena being stale or a request being queued is not a verdict.

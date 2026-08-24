# Flight 2 Spine Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the immutable Flight Spine data model and bounded server interfaces for objectives, role/assignment epochs, runtime seats/fencing, execution receipts, artifact facts, dependencies, mutation/host-control audit, and decision requests.

**Architecture:** Six additive D1 migrations establish the durable proof graph without changing legacy task, inbox, verdict, or landing behavior. Focused `src/flight-spine/` services own canonical hashing, immutable receipt insertion, objective materialization, seat intent/fencing, artifact metadata, audit, host-control facts, and decisions; bounded MCP tools expose only objective acceptance/readback and pending Codex command-seat attestation needed for the post-deploy proof.

**Tech Stack:** TypeScript 5.6, Cloudflare Workers, D1/SQLite, Hono MCP tools, Vitest 4, canonical JSON/Web Crypto SHA-256.

**Spec:** `/Users/hadi/dev/agents/.worktrees/hadi-mac-autonomous-squads/docs/superpowers/specs/2026-08-23-autonomous-three-squad-flight-system-design.md`

## Global Constraints

- Authoritative source repository: `/Users/hadi/dev/mumega/mupot`, clean remote main `66d857b4ec87fb715d9928a906ed1dbd869d2c19`; re-fetch and stop if it changes before worktree creation.
- Current migration head: `0120_targeted_seat_messages.sql`; reserve `0121`–`0126` only after the migration-numbering guard confirms they remain free.
- All tables are additive. Do not rebuild or reinterpret `tasks`, `flights`, `task_dispatch_receipts`, `agent_messages`, `task_verdicts`, `flight_event_outbox`, `runner_receipts`, or `fleet_control_log`.
- Legacy tools and consumers remain behaviorally unchanged. Flight 2 creates new proof primitives; Flights 3–6 migrate delivery, artifacts, results, gates, landing, controller, and portfolio behavior.
- Use `canonicalJson` and `sha256Hex`/`canonicalJsonDigest` from `src/lib/canonical-json.ts`; do not create another canonicalizer.
- Every immutable evidence table rejects UPDATE and DELETE. Current projections may mutate only through their owning service and must retain immutable history.
- Caller identity, member, agent, token ID, channel, timestamp, receipt predecessor, and hashes are server-derived, never accepted as authoritative arguments.
- Generic `task_update(result=...)` remains an acknowledged defect and is not repaired here; Flight 4 introduces `task_report_result` and rejects the generic path.
- No R2 write, signed launcher, process key, runtime challenge, effect journal, external result, verdict expansion, cost finalization, landing rewrite, controller, or deployment is claimed in Flight 2.
- One schema owner controls all six migration files. Other tasks do not renumber or edit migrations.
- No merge, D1 migration, deployment, token mint/rotation, or live seat mutation without an immutable candidate gate and explicit Hadi authority.
- Bootstrap implementation budget ceiling: 5,000,000 micro-USD; this is proposed in the governed packet and becomes active only after accepted by the flight executor's existing budget policy.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0121_flight_spine_objectives_assignments.sql` | objectives, acceptance keys, task epochs, flight lanes, task assignments, parent/child dependencies |
| `migrations/0122_runtime_seats_fences.sql` | runtime seats, generations, consumer leases, token-binding and pending-seat attestations |
| `migrations/0123_execution_receipt_ledger.sql` | tenant receipt head, append-only execution receipts, semantic receipt edges |
| `migrations/0124_artifact_receipt_facts.sql` | artifact metadata, retrieval receipts, child-artifact consumption facts |
| `migrations/0125_mutation_host_control_audit.sql` | mutation audit and observed host-control receipts |
| `migrations/0126_decision_requests.sql` | deduplicated decision requests and immutable resolutions |
| `src/flight-spine/types.ts` | domain types, branded IDs, receipt/role/decision enums |
| `src/flight-spine/receipts.ts` | append, verify, read and chain execution receipts |
| `src/flight-spine/objectives.ts` | objective acceptance and readback |
| `src/flight-spine/assignments.ts` | atomic composition materialization and assignment epochs |
| `src/flight-spine/dependencies.ts` | parent-child links and consumed-artifact facts |
| `src/flight-spine/seats.ts` | pending seat registration, generation projection and server-only fencing primitives |
| `src/flight-spine/attestations.ts` | current-token binding and pending command-seat attestations |
| `src/flight-spine/artifacts.ts` | metadata and independent retrieval facts only |
| `src/flight-spine/audit.ts` | principal-attributed audit writer and query |
| `src/flight-spine/host-control.ts` | host-control fact validation and recording only |
| `src/flight-spine/decisions.ts` | authority/business decision dedupe and resolution |
| `src/mcp/flight-spine.ts` | bounded Flight 2 MCP tools |

## Stable Interfaces

Create these exact public types in `src/flight-spine/types.ts`:

```ts
import type { Task } from '../types'
import type { CreateTaskInput } from '../tasks/service'

export type LaneRole = 'coordinator' | 'worker' | 'integrator' | 'gate'
export type RuntimeSeatState = 'pending' | 'active' | 'revoked'
export type DecisionClass =
  | 'credential' | 'deployment_or_migration' | 'destructive'
  | 'spend' | 'cross_tenant' | 'business_choice'

export type ReceiptType =
  | 'objective.authorized' | 'objective.accepted' | 'composition.proposed'
  | 'flight.materialized' | 'task.assigned' | 'message.accepted'
  | 'seat.leased' | 'host.persisted' | 'effect.intent'
  | 'runtime.injected' | 'runtime.consumed' | 'provider.observed'
  | 'provider.reconciled' | 'runtime.ack' | 'source.ack'
  | 'artifact.stored' | 'artifact.retrieved' | 'result.reported'
  | 'gate.verdict' | 'task.completed' | 'cost.finalized'
  | 'recovery.takeover' | 'flight.landed'
  | 'host_control.requested' | 'host_control.observed'
  | 'decision.created' | 'decision.resolved'

export interface ReceiptCorrelation {
  objectiveId?: string
  flightId?: string
  taskId?: string
  messageId?: string
}

export interface ExecutionReceiptDraft {
  type: ReceiptType
  issuer: { kind: 'mupot'; id: string }
  actor: { kind: 'member' | 'agent' | 'system' | 'controller'; id: string }
  correlation: ReceiptCorrelation
  assignmentEpoch?: number
  fencingEpoch?: number
  leaseTokenHash?: string
  idempotencyKey: string
  claims: Record<string, unknown>
}

export interface ExecutionReceiptRow {
  sequence: number
  id: string
  tenant: string
  type: ReceiptType
  issuerKind: string
  issuerId: string
  actorKind: string
  actorId: string
  payloadDigest: string
  predecessorReceiptId: string | null
  predecessorHash: string | null
  receiptHash: string
  serverTimestamp: string
}

export interface AcceptedObjective {
  id: string
  tenant: string
  squadId: string
  projectId: string | null
  title: string
  successContract: string
  authorityEnvelope: Record<string, unknown>
  policy: Record<string, unknown>
  budgetMicroUsd: number
  payload: Record<string, unknown>
  payloadDigest: string
  acceptedAt: string
  acceptanceReceiptId: string
}

export interface AcceptObjectiveInput {
  squadId: string
  projectId?: string | null
  title: string
  successContract: string
  authorityEnvelope: Record<string, unknown>
  policy: Record<string, unknown>
  budgetMicroUsd: number
  payload: Record<string, unknown>
  idempotencyKey: string
}

export interface MaterializeCompositionInput {
  objectiveId: string
  flightId: string
  lanes: ReadonlyArray<{
    laneKey: string
    role: LaneRole
    task: CreateTaskInput
    assigneeAgentId: string
    runtimeSeatId: string | null
    dependencyLaneKeys: readonly string[]
  }>
}

export interface MaterializedComposition {
  flightId: string
  objectiveId: string
  tasks: Task[]
  lanes: FlightLane[]
  assignmentReceiptIds: string[]
  materializedReceiptId: string
}

export interface FlightLane {
  id: string
  tenant: string
  flightId: string
  laneKey: string
  role: LaneRole
  taskId: string
  assignmentEpoch: number
  agentId: string
  runtimeSeatId: string | null
  doneWhen: string
  dependencyLaneKeys: string[]
  createdAt: string
}

export interface RuntimeSeat {
  id: string
  tenant: string
  agentId: string
  seatName: string
  hostId: string
  adapterKind: string
  state: RuntimeSeatState
  currentGeneration: number
  currentFencingEpoch: number
}

export interface TokenBindingAttestation {
  id: string
  tenant: string
  tokenId: string
  memberId: string
  agentId: string
  channel: 'workspace'
  credentialFingerprint: string
  issuedAt: string
  expiresAt: string | null
}
```

Create these exact service signatures:

```ts
export async function appendExecutionReceipt(
  env: Env,
  auth: AuthContext,
  draft: ExecutionReceiptDraft,
): Promise<ExecutionReceiptRow>

export async function getExecutionReceipt(
  env: Env,
  tenant: string,
  receiptId: string,
): Promise<ExecutionReceiptRow | null>

export async function acceptObjective(
  env: Env,
  auth: AuthContext,
  input: AcceptObjectiveInput,
): Promise<AcceptedObjective>

export async function getObjective(
  env: Env,
  auth: AuthContext,
  objectiveId: string,
): Promise<AcceptedObjective | null>

export async function materializeComposition(
  env: Env,
  auth: AuthContext,
  input: MaterializeCompositionInput,
): Promise<MaterializedComposition>

export async function issueTokenBindingAttestation(
  env: Env,
  auth: AuthContext,
): Promise<TokenBindingAttestation>

export async function registerPendingRuntimeSeat(
  env: Env,
  auth: AuthContext,
  input: { seatName: string; hostId: string; adapterKind: string; attestationId: string },
): Promise<RuntimeSeat>
```

## Task 1: Add the Six Additive Migrations

**Files:**
- Create: `migrations/0121_flight_spine_objectives_assignments.sql`
- Create: `migrations/0122_runtime_seats_fences.sql`
- Create: `migrations/0123_execution_receipt_ledger.sql`
- Create: `migrations/0124_artifact_receipt_facts.sql`
- Create: `migrations/0125_mutation_host_control_audit.sql`
- Create: `migrations/0126_decision_requests.sql`
- Create: `tests/flight-spine-schema.test.ts`

**Interfaces:**
- Consumes: current schema through migration `0120`.
- Produces: every table/index/trigger named in File Structure; later tasks may assume these exact names.

- [ ] **Step 1: Write RED schema tests using real migration helpers**

Use `createSqliteD1()` and `applyAllMigrations()` from `tests/helpers`. Assert the exact tables exist:

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  'objectives', 'objective_acceptance_keys', 'flight_objectives', 'flight_lanes',
  'flight_task_assignments', 'flight_dependencies', 'runtime_seats',
  'runtime_seat_generations', 'runtime_seat_leases', 'token_binding_attestations',
  'seat_attestations', 'execution_receipt_heads', 'execution_receipts',
  'execution_receipt_edges', 'artifacts', 'artifact_retrieval_receipts',
  'flight_dependency_artifacts', 'mutation_audit_entries', 'host_control_receipts',
  'decision_requests', 'decision_request_resolutions',
]))
```

The RED suite must also assert immutability triggers reject UPDATE/DELETE, partial unique indexes reject a second active seat lease/open decision/gate lane, invalid SHA-256 values fail, self flight dependency fails, and `tasks.assignment_epoch` exists with default `0`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-schema.test.ts
```

Expected: FAIL because migrations/tables do not exist.

- [ ] **Step 3: Implement migration `0121`**

Add `tasks.assignment_epoch INTEGER NOT NULL DEFAULT 0`, then create immutable objectives and lane/assignment/dependency facts. Core constraints:

```sql
CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  created_by_principal_kind TEXT NOT NULL CHECK (created_by_principal_kind IN ('member','agent')),
  created_by_principal_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  squad_id TEXT NOT NULL REFERENCES squads(id) ON DELETE RESTRICT,
  project_id TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  success_contract TEXT NOT NULL CHECK (length(trim(success_contract)) BETWEEN 1 AND 8000),
  authority_envelope TEXT NOT NULL CHECK (json_valid(authority_envelope)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  budget_micro_usd INTEGER NOT NULL CHECK (budget_micro_usd >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest)=64 AND payload_digest=lower(payload_digest)),
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Use `ON DELETE RESTRICT`, append-only triggers, `UNIQUE(tenant, flight_id, lane_key)`, a partial unique gate index per flight, positive assignment epochs, and immutable task/agent/seat attribution columns.

- [ ] **Step 4: Implement migrations `0122`–`0126`**

Use the approved spec's exact boundaries:

- `0122`: pending/active/revoked seats, immutable generations, one active lease, monotonic positive fencing, token-binding and pending-seat attestations. Store fingerprints/public facts only.
- `0123`: `execution_receipts.sequence INTEGER PRIMARY KEY AUTOINCREMENT`, tenant chain head, canonical payload/hash fields, unique issuer/idempotency key, semantic edges, immutable receipts.
- `0124`: artifact metadata/retrieval facts and child-artifact consumption; require 64-hex digest, positive size, producing assignment, retention timestamp and unique storage/retrieval receipts.
- `0125`: append-only principal-attributed mutation and observed host-control facts; reject `shell` and `pty` origins in proof records.
- `0126`: only the six approved decision classes, one open dedupe key, immutable resolution history.

- [ ] **Step 5: Run schema and migration guards**

```bash
npx vitest run tests/flight-spine-schema.test.ts tests/migration-d1-compat.test.ts
node --test tests/migration-numbering.test.mjs
git diff --check
```

Expected: all PASS with pristine output.

- [ ] **Step 6: Commit**

```bash
git add migrations/0121_flight_spine_objectives_assignments.sql \
  migrations/0122_runtime_seats_fences.sql \
  migrations/0123_execution_receipt_ledger.sql \
  migrations/0124_artifact_receipt_facts.sql \
  migrations/0125_mutation_host_control_audit.sql \
  migrations/0126_decision_requests.sql tests/flight-spine-schema.test.ts
git commit -m "feat: add Flight Spine schema"
```

## Task 2: Implement the Execution Receipt Ledger

**Files:**
- Create: `src/flight-spine/types.ts`
- Create: `src/flight-spine/receipts.ts`
- Create: `tests/flight-spine-receipts.test.ts`

**Interfaces:**
- Consumes: migration `0123`, `canonicalJson`, `sha256Hex`, authenticated server identity.
- Produces: `appendExecutionReceipt()`, `getExecutionReceipt()`, `verifyExecutionReceipt()`.

- [ ] **Step 1: Write RED receipt tests**

Tests must prove genesis/null predecessor, successor/head linkage, canonical Unicode-key hashing, server-derived sequence/time/predecessor/actor, stale predecessor conflict, issuer restrictions, same-key/same-bytes idempotent replay, same-key/different-bytes conflict, tenant isolation, immutable rows, and receipt hash verification after DB reread.

```ts
const first = await appendExecutionReceipt(env, auth, objectiveAcceptedDraft)
const second = await appendExecutionReceipt(env, auth, materializedDraft)
expect(second.predecessorReceiptId).toBe(first.id)
expect(await verifyExecutionReceipt(env, second.id)).toEqual({ ok: true })
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-receipts.test.ts
```

- [ ] **Step 3: Implement minimal ledger service**

Compute the hash preimage from canonical server-derived facts and claims. Insert against the current head, map uniqueness/trigger conflicts to typed domain errors, reread, and verify. Do not accept caller sequence, timestamp, predecessor or hash.

- [ ] **Step 4: Run GREEN and typecheck**

```bash
npx vitest run tests/flight-spine-receipts.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/flight-spine/types.ts src/flight-spine/receipts.ts tests/flight-spine-receipts.test.ts
git commit -m "feat: add Flight Spine execution receipts"
```

## Task 3: Implement Objectives, Assignment Epochs, Lanes, and Dependencies

**Files:**
- Create: `src/flight-spine/objectives.ts`
- Create: `src/flight-spine/assignments.ts`
- Create: `src/flight-spine/dependencies.ts`
- Create: `tests/flight-spine-objectives.test.ts`
- Create: `tests/flight-spine-assignments.test.ts`
- Create: `tests/flight-spine-dependencies.test.ts`
- Modify: `src/tasks/service.ts` only to expose a prepared internal task insert that retains all current intake/project/provenance guards.

**Interfaces:**
- Consumes: Task 2 receipts and migration `0121`.
- Produces: `acceptObjective()`, `getObjective()`, `materializeComposition()`, `linkChildFlight()`, `recordConsumedChildArtifact()`.

- [ ] **Step 1: Write RED objective/materialization tests**

Prove server-derived creator/member/agent, canonical payload digest, authority/budget/squad checks, immutable objective, idempotent acceptance, two-to-five workers, one predeclared distinct gate, DAG dependencies, epoch-1 tasks, atomic no-partial failure, legacy epoch 0, stale epoch rejection, child created after parent objective, and consumed-child-artifact facts.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-objectives.test.ts \
  tests/flight-spine-assignments.test.ts tests/flight-spine-dependencies.test.ts
```

- [ ] **Step 3: Implement services**

`acceptObjective()` appends `objective.authorized` and `objective.accepted` receipts and writes the immutable row. `materializeComposition()` validates all lanes before SQL, resolves agents and pending seats, creates fresh tasks through the existing guarded insert, increments `tasks.assignment_epoch`, writes assignment/lane rows and `flight.materialized`/`task.assigned` receipts in one guarded batch. Gate agent and seat must differ from coordinator, workers and integrator.

- [ ] **Step 4: Run GREEN, existing task tests and typecheck**

```bash
npx vitest run tests/flight-spine-objectives.test.ts \
  tests/flight-spine-assignments.test.ts tests/flight-spine-dependencies.test.ts \
  tests/tasks-service.test.ts tests/mcp-task-tools.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/flight-spine/objectives.ts src/flight-spine/assignments.ts \
  src/flight-spine/dependencies.ts src/tasks/service.ts \
  tests/flight-spine-objectives.test.ts tests/flight-spine-assignments.test.ts \
  tests/flight-spine-dependencies.test.ts
git commit -m "feat: add Flight Spine objectives and assignments"
```

## Task 4: Implement Pending Seats, Fencing, and Attestations

**Files:**
- Create: `src/flight-spine/seats.ts`
- Create: `src/flight-spine/attestations.ts`
- Create: `tests/flight-spine-seats.test.ts`
- Create: `tests/flight-spine-attestations.test.ts`
- Modify: `src/members/service.ts` only for an internal HMAC-derived versioned safe fingerprint helper.

**Interfaces:**
- Consumes: migration `0122`, current authenticated `member_tokens` row, Task 2 receipts.
- Produces: `issueTokenBindingAttestation()`, `registerPendingRuntimeSeat()`, server-only acquire/renew/release fencing primitives.

- [ ] **Step 1: Write RED seat/attestation tests**

Prove multiple named seats per agent, duplicate seat rejection, pending seats cannot claim live runtime, generation/epoch monotonicity, one active lease, stale renew/release rejection, retired/revoked rejection, workspace/agent/member/token reread, safe `v1:<hex>` fingerprint, no plaintext/token-hash return, immutable attestations, and `codex-desktop-command` bound to agent `087a...` rather than local HCCLI label.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-seats.test.ts tests/flight-spine-attestations.test.ts
```

- [ ] **Step 3: Implement minimal pending-seat services**

Flight 2 may create only pending command-seat facts. The server-only lease functions establish schema behavior for tests but are not MCP-exposed. Broker attestation, active process generations and runtime challenges remain Flight 3.

- [ ] **Step 4: Run GREEN and membership regressions**

```bash
npx vitest run tests/flight-spine-seats.test.ts tests/flight-spine-attestations.test.ts \
  tests/agent-connection-service.test.ts tests/agent-connection-issued-key.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/flight-spine/seats.ts src/flight-spine/attestations.ts \
  src/members/service.ts tests/flight-spine-seats.test.ts \
  tests/flight-spine-attestations.test.ts
git commit -m "feat: add Flight Spine seat attestations"
```

## Task 5: Implement Artifact Metadata and Flight Dependencies

**Files:**
- Create: `src/flight-spine/artifacts.ts`
- Extend: `src/flight-spine/dependencies.ts`
- Create: `tests/flight-spine-artifacts.test.ts`

**Interfaces:**
- Consumes: migration `0124`, current assignment facts, Task 2 receipts.
- Produces: `recordArtifactMetadata()`, `recordArtifactRetrieval()`, `recordConsumedChildArtifact()` metadata facts only.

- [ ] **Step 1: Write RED artifact-fact tests**

Require canonical digest, positive size, producing task/agent/seat/epoch, storage receipt, canonical object key, visibility, >=30-day retention, independent verifier, matching recomputed digest, one retrieval receipt, and explicit child consumption. Prove no service claims R2 bytes exist or a task result is complete.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-artifacts.test.ts
```

- [ ] **Step 3: Implement metadata-only services**

Insert only facts backed by an existing execution receipt of the correct type. Do not call R2, GitHub, or mutate tasks.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/flight-spine-artifacts.test.ts tests/flight-spine-dependencies.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/flight-spine/artifacts.ts src/flight-spine/dependencies.ts \
  tests/flight-spine-artifacts.test.ts
git commit -m "feat: add Flight Spine artifact facts"
```

## Task 6: Implement Mutation Audit, Host-Control Facts, and Decisions

**Files:**
- Create: `src/flight-spine/audit.ts`
- Create: `src/flight-spine/host-control.ts`
- Create: `src/flight-spine/decisions.ts`
- Create: `tests/flight-spine-audit.test.ts`
- Create: `tests/flight-spine-host-control.test.ts`
- Create: `tests/flight-spine-decisions.test.ts`

**Interfaces:**
- Consumes: migrations `0125`–`0126`, Task 2 receipt writer.
- Produces: `auditMutation()`, `recordHostControlFact()`, `createDecisionRequest()`, `resolveDecisionRequest()`.

- [ ] **Step 1: Write RED tests**

Prove principal/origin/handler/before-after digest attribution, no raw secrets, immutable audit; host-control rejects shell/PTY/unknown principal/missing generation/unsigned observation; only six decision classes, one open dedupe key, no request for retry exhaustion, open/unexpired resolution, idempotent replay and immutable resolution receipt.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/flight-spine-audit.test.ts \
  tests/flight-spine-host-control.test.ts tests/flight-spine-decisions.test.ts
```

- [ ] **Step 3: Implement minimal fact services**

Canonicalize all evidence/options/consequences before digesting. Redact or reject credential-shaped claim values. Flight 2 does not claim whole-route audit coverage or execute host actions.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/flight-spine-audit.test.ts \
  tests/flight-spine-host-control.test.ts tests/flight-spine-decisions.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/flight-spine/audit.ts src/flight-spine/host-control.ts \
  src/flight-spine/decisions.ts tests/flight-spine-audit.test.ts \
  tests/flight-spine-host-control.test.ts tests/flight-spine-decisions.test.ts
git commit -m "feat: add Flight Spine audit and decisions"
```

## Task 7: Add Bounded MCP Tools and Compatibility Integration

**Files:**
- Create: `src/mcp/flight-spine.ts`
- Modify: `src/mcp/index.ts` only to import and append `FLIGHT_SPINE_TOOLS`
- Create: `tests/mcp-flight-spine.test.ts`
- Create: `tests/flight-spine-integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6 services.
- Produces MCP tools: `objective_accept`, `objective_get`, `execution_receipt_get`, `token_binding_attest`, `runtime_seat_register_pending`.

- [ ] **Step 1: Write RED MCP/integration tests**

Require exact schemas with `additionalProperties:false`, agent-bound workspace token for attestation/objective acceptance, squad member authority, server-derived identity, no caller fingerprint/agent/member/channel/timestamp, read visibility, idempotent objective replay, pending command-seat registration, and refusal of runtime lease/process claims.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/mcp-flight-spine.test.ts tests/flight-spine-integration.test.ts
```

- [ ] **Step 3: Implement tool module and register it**

Follow `src/mcp/presence.ts` module style and reuse exported `ToolSpec`, `done`, `fail`, `str`, `readAccess`, and squad capability helpers. Keep new tools out of the directory-channel ambient write surface through the existing channel/capability checks.

- [ ] **Step 4: Run focused and compatibility suites**

```bash
npx vitest run tests/mcp-flight-spine.test.ts tests/flight-spine-integration.test.ts \
  tests/mcp-task-tools.test.ts tests/mcp-flight-tools.test.ts \
  tests/agent-inbox-lease-sqlite.test.ts tests/targeted-seat-dispatch.test.ts \
  tests/runner-receipts.test.ts tests/agent-audit-immutable.test.ts
npm run typecheck
```

- [ ] **Step 5: Run the complete repository verification once**

```bash
npm test
node --test tests/migration-numbering.test.mjs
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/flight-spine.ts src/mcp/index.ts \
  tests/mcp-flight-spine.test.ts tests/flight-spine-integration.test.ts
git commit -m "feat: expose bounded Flight Spine tools"
```

## Task 8: Integrate, Package, and Gate the Bootstrap Candidate

**Files:**
- Create: `docs/receipts/flight-02-bootstrap-manifest.json`
- Create: `docs/receipts/flight-02-candidate.json`
- Create: `docs/receipts/flight-02-gate-verdict.json` by the independent gate only

**Interfaces:**
- Consumes: exact Task 1–7 commits and full verification output.
- Produces: one immutable integration SHA, candidate evidence manifest and PASS/BLOCK verdict; no merge/deploy/migration.

- [ ] **Step 1: Reverify remote and migration allocation**

```bash
test "$(git ls-remote origin refs/heads/main | cut -f1)" = \
  "$(git rev-parse origin/main)"
node scripts/check-migration-numbering.mjs
```

Stop if `origin/main` changed or any migration number collides; rebase/replan before integration.

- [ ] **Step 2: Create the candidate evidence manifest**

Record baseline, commits, file digests, migration list, test commands/results, scope exclusions, role identities, budget/TTL, and immutable candidate SHA. The manifest contains no credential values and makes no runtime/deployment/autonomy claim.

- [ ] **Step 3: Independent gate**

The gate receives a fresh read-only checkout and exact SHA. It verifies schema compatibility, receipt hashing, role/epoch constraints, token/seat safety, legacy regression boundaries, full test evidence, and secret scan. It writes PASS/BLOCK at exact SHA and modifies no candidate file.

- [ ] **Step 4: Prepare the genuine Hadi decision packet only after PASS**

The packet names exact SHA, target Mupot Worker, migrations `0121`–`0126`, deployment command/runbook, rollback boundary, expected first objective, canonical token/seat operation, and evidence. It asks separately for migration/deployment authority; it does not mint, merge, migrate, deploy, or restart.

## Flight 2 Governed Packet

Before Task 1 starts, materialize a fresh zero-legacy-ID supervised flight in `squad-core`:

| Role | Agent | Constraint |
|---|---|---|
| Coordinator | Kasra `c855f82c-1eeb-409d-94d2-f11e9dd18968` | Coordinates only; no gate |
| Worker A | River `f23a6c2c-7377-492f-8d69-96c3946a7148` | Objectives/assignments/dependencies |
| Worker B | Asha `e211b0fb-6ebf-4aab-bac5-6129ce6075e0` | Receipts/audit/decisions |
| Worker C + integrator | Hadi Codex `087a816b-ab9f-400f-8d53-f6f97b94a725` | Schema/seats/artifact facts plus integration; supervised bootstrap exception |
| Independent gate | Athena `a9423609-e3bf-4797-8af8-4b9b7aecdf16` | Read-only candidate; no author/integrator/deploy role |

Flight budget: `5_000_000` micro-USD. Overall TTL: 8 hours. Writer TTL: 90 minutes with one progress-backed 45-minute renewal. Gate TTL: 45 minutes. One retry only for demonstrated transient checkout/test/transport failure. Identity mismatch, migration collision, dirty tree, cross-lane edit, test failure, missing artifact, budget/TTL breach, gate BLOCK, or deployment uncertainty stops the flight.

Receipt chain for this supervised bootstrap is limited to the legacy flight/task/circuit records plus immutable Git artifacts and independent verdict. It explicitly does not count as Flight Spine autonomy evidence.

## Verification Handoff

After a gated candidate and explicit Hadi deployment approval:

1. deploy only the gated SHA through the authoritative Mupot deployment path;
2. verify migrations `0121`–`0126` applied exactly once;
3. use the existing canonical workspace token—never admin/Hadi ChatGPT/HCCLI token—to call `token_binding_attest`;
4. register pending `codex-desktop-command` through `runtime_seat_register_pending`;
5. accept the harmless first objective through `objective_accept`;
6. reread objective and acceptance receipt through the read tools; and
7. close Flight 2 with those receipts while explicitly leaving delivery, runtime consumption, ACK, artifacts bytes, results, gates, landing rewrite, and autonomy to Flights 3–6.

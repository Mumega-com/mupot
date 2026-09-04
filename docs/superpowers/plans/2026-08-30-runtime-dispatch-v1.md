# Runtime Dispatch v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #1240 by adding versioned external task dispatch, native exact-runtime receipts, precise task transitions, editable `/send` completion predicates, separated dashboard evidence, and a synthetic interruption canary.

**Architecture:** Preserve `task_dispatch_receipts.consumed_at` as transport evidence. Add a narrow receipt projection anchored to the existing dispatch and exact inbox row; expose one shared service through MCP and REST. Keep Flight-3 signed deliveries unchanged because ordinary task dispatch lacks their required objective/flight/seat signing facts.

**Tech Stack:** TypeScript, Cloudflare Workers/Hono, D1/SQLite migrations, MCP JSON-RPC tools, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-runtime-dispatch-v1-design.md`

## Global Constraints

- Base is `origin/main` commit `316448990772653cf95fda46392a9d660e4db19e`.
- Use migration `0138`; never renumber or rebuild earlier tables.
- No SOS dependency, raw Codex thread ID, org-admin widening, credential output, deploy, merge, receiver activation, or active voice-task interaction.
- All behavior changes follow strict red-green-refactor TDD.
- Every receipt write reauthorizes the exact workspace-bound assigned agent.
- Transport, runtime consumption, completion/failure, review, and gate remain distinct.

---

### Task 1: Runtime receipt schema and domain service

**Files:**
- Create: `migrations/0138_task_dispatch_runtime_receipts.sql`
- Create: `src/tasks/runtime-receipts.ts`
- Create: `tests/task-dispatch-runtime-receipts.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces `recordTaskDispatchRuntimeReceipt(env, auth, input)` returning a public receipt plus task status.
- Consumes existing `task_dispatch_receipts`, `agent_messages`, `tasks`, `agents`, capabilities, and artifact-verification helpers.

- [ ] **Step 1: Write failing migration/service tests** covering schema application, exact foreign-key anchors, append-only rows, `runtime_consumed -> in_progress`, completion-before-consumption rejection, `completed -> review`, `failed -> blocked`, and no `done` transition.
- [ ] **Step 2: Run** `npx vitest run tests/task-dispatch-runtime-receipts.test.ts` and confirm failures are caused by the absent migration/service.
- [ ] **Step 3: Add migration 0138** with receipt identity, canonical request digest, exact dispatch/message/task/agent correlations, stage/attempt checks, artifact/result/reason fields, unique idempotency key, indexes, no-update/no-delete triggers, and mutation-audit linkage.
- [ ] **Step 4: Implement input normalization and read-only context loading** with bounded strings/arrays, lowercase SHA-256 validation, exact outer-row/body correlation, workspace/agent binding, fresh capability resolution, active assignment validation, and terminal/supersession rejection.
- [ ] **Step 5: Implement idempotent replay** that reauthorizes before returning the original row and rejects changed content under the same key.
- [ ] **Step 6: Implement atomic stage transitions** using one D1 batch plus a changes-count audit guard so any failed state mutation rolls back the receipt insert.
- [ ] **Step 7: Run the focused test**, then `npm run typecheck`.
- [ ] **Step 8: Commit** `feat(tasks): add exact runtime dispatch receipts`.

### Task 2: Versioned external dispatch envelope

**Files:**
- Modify: `src/bus/fleet-bridge.ts`
- Modify: `src/bus/consumer.ts`
- Modify: `tests/fleet-bridge.test.ts`
- Modify: `tests/bus-consumer.test.ts`

**Interfaces:**
- The envelope derives `runtime_address` from the bridge's already data-derived `agentId`; no second caller-controlled address exists.
- Envelope schema is exactly `runtime.dispatch/v1` with no private runtime identifier.

- [ ] **Step 1: Write failing tests** proving the version/address fields, caller inability to override address, sticky route behavior, and no duplicate inbox row on Queue replay.
- [ ] **Step 2: Run** `npx vitest run tests/fleet-bridge.test.ts tests/bus-consumer.test.ts` and verify the new assertions fail.
- [ ] **Step 3: Pass the selected fleet route address** from the consumer into the bridge and emit the exact v1 body.
- [ ] **Step 4: Keep the existing sender/request/project outer metadata unchanged** and retain the exactly-one external-versus-AgentDO route.
- [ ] **Step 5: Run focused tests and typecheck.**
- [ ] **Step 6: Commit** `feat(dispatch): emit runtime.dispatch v1 envelopes`.

### Task 3: MCP and REST receipt parity

**Files:**
- Modify: `src/mcp/index.ts`
- Modify: `src/tasks/index.ts`
- Create: `tests/mcp-task-runtime-receipts.test.ts`
- Create: `tests/task-runtime-receipt-routes.test.ts`

**Interfaces:**
- MCP: `task_dispatch_runtime_receipt({ task_id, dispatch_receipt_id, message_id, stage, runtime_receipt_hash, attempt, artifact_refs?, artifact_sha256?, result?, reason? })`.
- REST: generated `POST /actions/task_dispatch_runtime_receipt` with the identical arguments and authenticated principal.

- [ ] **Step 1: Write failing contract tests** for tool advertisement, strict schemas, REST/MCP equivalent responses, directory/unbound/wrong-agent denial, revoked capability, wrong task/dispatch/message/attempt, and safe error bodies.
- [ ] **Step 2: Run the two new suites and verify RED.**
- [ ] **Step 3: Add the MCP tool** with member floor and exact service delegation; do not duplicate authorization logic.
- [ ] **Step 4: Add the REST route** behind existing authentication, CSRF, and tenant middleware; do not accept agent or tenant identity from the body.
- [ ] **Step 5: Run focused tests, MCP schema tests, and typecheck.**
- [ ] **Step 6: Commit** `feat(api): expose native runtime receipt operations`.

### Task 4: `/send` exact completion predicate and task readback

**Files:**
- Modify: `src/dashboard/index.ts`
- Modify: `tests/dashboard-send.test.ts` or the existing `/send` coverage file selected by repository conventions.

**Interfaces:**
- Dispatch-now requires operator-provided `done_when` and sends it unchanged.
- Polling treats `review` as completed work awaiting gate, not `done`.

- [ ] **Step 1: Write failing rendered-page and request tests** proving the field exists, blank predicates block dispatch, exact text is submitted, the generic hard-coded predicate is absent, and `review` renders separately from `done`.
- [ ] **Step 2: Run the focused dashboard suite and verify RED.**
- [ ] **Step 3: Add the required field and validation** and use its value in the create payload.
- [ ] **Step 4: Preserve the existing create-and-dispatch request and use subsequent polling to read the task plus receipt timeline.**
- [ ] **Step 5: Render `review`, `blocked`, and terminal gate states distinctly.**
- [ ] **Step 6: Run focused tests and typecheck.**
- [ ] **Step 7: Commit** `fix(dashboard): preserve exact dispatch predicates`.

### Task 5: Receipt readback and dashboard separation

**Files:**
- Modify: `src/tasks/index.ts`
- Modify: `src/dashboard/index.ts` or a focused dashboard view module if the existing file boundary requires it.
- Create: `tests/dashboard-runtime-receipts.test.ts`
- Extend: `tests/task-runtime-receipt-routes.test.ts`

**Interfaces:**
- Task readback includes a bounded `runtime_receipts` projection.
- Dashboard labels `transport_delivered`, `runtime_consumed`, `completed|failed`, `review`, and `gate_verdict` independently.

- [ ] **Step 1: Write failing tests** with mixed-stage fixtures proving no stage is inferred from another and hidden squads/projects do not leak receipts.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Add a bounded indexed read service/query** and include it only after the task visibility check.
- [ ] **Step 4: Render separate stage rows/badges** without equating transport or consumption with completion.
- [ ] **Step 5: Run focused tests and typecheck.**
- [ ] **Step 6: Commit** `feat(dashboard): separate runtime receipt stages`.

### Task 6: Synthetic restart/interruption canary and documentation

**Files:**
- Create: `tests/runtime-dispatch-canary.test.ts`
- Modify: `docs/runtime-adapter-contract.md`
- Modify: `docs/host-a-seat.md`
- Create: `docs/operations/runtime-dispatch-v1.md`

**Interfaces:**
- Canary uses local SQLite and deterministic fake host/runtime boundaries only.
- Documents install-neutral API use, authority, disable/recovery, and Flight-3 boundary.

- [ ] **Step 1: Write the failing synthetic canary** for one transport row, one consumption row, one completion row, review state, and independent verdict; rerun from persisted SQLite after interruption at transport and consumption boundaries.
- [ ] **Step 2: Add negative canaries** for wrong outer sender, stale attempt, changed replay, revoked capability, missing artifact hash, and any voice-task address.
- [ ] **Step 3: Run the canary and verify RED before final service corrections.**
- [ ] **Step 4: Make the minimum corrections required for GREEN.**
- [ ] **Step 5: Document the contract, recovery, and no-SOS/no-raw-thread boundary.**
- [ ] **Step 6: Run canary, focused receipt/bridge/API/dashboard suites, typecheck, migration checks, and `git diff --check`.**
- [ ] **Step 7: Commit** `test(runtime): prove exact dispatch receipt lifecycle`.

### Task 7: Full verification, independent gate, and draft PR

**Files:**
- Modify only findings required by verification or Hadi-grok review.

**Interfaces:**
- Produces exact base/head SHAs, test receipts, Hadi-grok PASS/BLOCK, and a draft PR linked to #1240.

- [ ] **Step 1: Run** `npm run typecheck`.
- [ ] **Step 2: Run all focused #1240 suites.**
- [ ] **Step 3: Run** `npm test` with loopback permission and confirm the full suite remains green against the 6,771-test baseline plus new tests.
- [ ] **Step 4: Run migration numbering/schema-source checks, secret scan, and `git diff --check`.**
- [ ] **Step 5: Commit any verification-only fixes and record exact base/head SHAs.**
- [ ] **Step 6: Ask canonical Hadi-grok to review the exact SHA** against this spec and #1240; require evidence-backed PASS/BLOCK and no authorship.
- [ ] **Step 7: Resolve every blocking finding through new red-green cycles and re-gate.**
- [ ] **Step 8: Push the branch and open a draft PR** only after PASS; do not merge or deploy.

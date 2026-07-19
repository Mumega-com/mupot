# Agent Host and Project Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the existing Agent Host, connect DME Kubernetes Hermes, and expose project-attributed work and receipts through Activity and Evidence.

**Architecture:** Extend the existing `fleet-runtime` installer with structured policy-bound profiles and a Kubernetes adapter. Add explicit project attribution to durable messages, then build cursor-ready Activity and Evidence read projections from authoritative task, message, flight, and receipt tables.

**Tech Stack:** Node.js ESM, Cloudflare Workers, D1/SQLite, TypeScript, Hono HTML, launchd, systemd, Kubernetes, Vitest, Node test runner.

## Global Constraints

- SOS is not a Mupot dependency or transport.
- Do not create a second installer or a second project-state store.
- No token, private key, model credential, or authorization header enters Git, a manifest, a service definition, a receipt, or test output.
- Runtime commands use argument arrays with `shell: false`.
- Project RBAC is checked before attributed messages or projections are returned.
- Existing unassigned messages, tasks, and flights remain valid.
- All behavior changes follow red-green-refactor.

---

### Task 1: Project-Attributed Durable Messages

**Files:**
- Create: `migrations/0056_project_activity_evidence.sql`
- Modify: `src/agents/messages.ts`
- Modify: `src/agents/inbox-routes.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/bus/fleet-bridge.ts`
- Modify: `src/bus/consumer.ts`
- Test: `tests/project-message-attribution.test.ts`
- Modify: `tests/agent-messages.test.ts`

**Interfaces:**
- Produces nullable `project_id` on `SendInput` and `InboxMessage`.
- Produces `canAgentsMessageOnProject(env, projectId, fromAgent, toAgent)`.

- [ ] Write failing migration and service tests for project validation, participant access, inbox return shape, dispatch inheritance, and request-ID conflict across projects.
- [ ] Run the focused tests and confirm failures are caused by missing attribution.
- [ ] Add the nullable column, validation triggers, indexes, service fields, API/MCP argument, and dispatch inheritance.
- [ ] Run focused messaging, inbox, bridge, MCP, migration, and typecheck tests.

### Task 2: Activity and Evidence Read Projections

**Files:**
- Create: `src/projects/projections.ts`
- Modify: `src/dashboard/projects.ts`
- Modify: `src/projects/index.ts`
- Modify: `src/mcp/projects.ts`
- Test: `tests/project-projections.test.ts`
- Modify: `tests/dashboard-projects.test.ts`
- Modify: `tests/projects-routes.test.ts`

**Interfaces:**
- Produces `listProjectActivity(env, access, projectId, cursor, limit)`.
- Produces `listProjectEvidence(env, access, projectId, cursor, limit)`.
- Produces `GET /api/projects/:id/activity` and `/evidence`.

- [ ] Write failing tests covering tasks, messages, flights, task results, verdicts, workflow receipts, dispatch receipts, landing receipts, acknowledgement evidence, RBAC, ordering, escaping, and cursor pagination.
- [ ] Run the focused tests and confirm the placeholder views fail expectations.
- [ ] Implement parameter-bound projections and authenticated API endpoints.
- [ ] Replace honest empty placeholders with semantic Activity and Evidence tables while preserving honest empty and capped states.
- [ ] Run focused tests, migration replay, and typecheck.

### Task 3: Policy-Bound Agent Host Profiles

**Files:**
- Create: `fleet-runtime/profile-contract.mjs`
- Create: `fleet-runtime/profile-runner.mjs`
- Modify: `fleet-runtime/inbox-handler.mjs`
- Modify: `fleet-runtime/starter-contract.mjs`
- Modify: `fleet-runtime/install.mjs`
- Test: `fleet-runtime/profile-contract.test.mjs`
- Test: `fleet-runtime/profile-runner.test.mjs`
- Modify: `fleet-runtime/inbox-handler.test.mjs`

**Interfaces:**
- Produces strict `mupot.agent-profile/v1` validation.
- Produces `runProfile(profile, batch, injectables)` using direct spawn.

- [ ] Write failing tests for exact-key validation, secret rejection, executable allowlists, sender/kind policy, acknowledgement-loop rejection, timeout, durable result, and shell metacharacter inertness.
- [ ] Run the focused Node tests and confirm missing modules fail.
- [ ] Implement profile validation and direct execution, then connect it to the durable inbox handler.
- [ ] Extend installer receipts with profile hashes but no profile secrets.
- [ ] Run all `fleet-runtime/*.test.mjs` tests.

### Task 4: DME Kubernetes Hermes Adapter

**Files:**
- Create: `deploy/kubernetes/agent-host/deployment.yaml`
- Create: `deploy/kubernetes/agent-host/network-policy.yaml`
- Create: `deploy/kubernetes/agent-host/config.example.json`
- Create: `scripts/kubernetes-agent-host-receipt.mjs`
- Test: `tests/kubernetes-agent-host.test.ts`
- Modify: `docs/runtime-starter.md`

**Interfaces:**
- Consumes the same runtime bundle and profile contract as macOS/Linux.
- Produces `mupot-kubernetes-agent-host-receipt/v1`.

- [ ] Write failing static and receipt tests for non-root execution, read-only root filesystem, Secret references, probes, resource bounds, restricted egress, no literal credentials, and DME-owned identity inputs.
- [ ] Add the deployment, policy, example config, and verifier.
- [ ] Run focused tests and render the manifests with a temporary DME fixture.

### Task 5: Cross-Pot Receipt and End-to-End Proof

**Files:**
- Create: `src/addons/project-link/*`
- Create: `migrations/0057_project_links.sql`
- Test: `tests/project-link-addon.test.ts`
- Modify: `docs/superpowers/specs/2026-07-18-dme-cross-pot-collaboration-design.md`

**Interfaces:**
- Produces signed, idempotent allowlisted envelopes and linked receipt hashes.

- [ ] Write failing tests for signature, idempotency, destination reauthorization, prohibited customer fields, revocation, retry, and stale remote state.
- [ ] Implement the addon manifest, link service, envelope validation, receipt persistence, and project projection rows.
- [ ] Connect the DME Kubernetes identity using DME-owned credentials.
- [ ] Run one governed DME flight and verify matching receipt hashes in both project Evidence views.

### Task 6: Release Verification

- [ ] Run `node --test fleet-runtime/*.test.mjs`, `npm test`, `npm run typecheck`, clean migration replay, no-secrets, and browser smoke.
- [ ] Install the Agent Host into a temporary prefix and verify install/status/reload/uninstall receipts preserve state.
- [ ] Verify Activity and Evidence on desktop and mobile viewports without overflow.
- [ ] Review the complete branch for authorization leakage, secret exposure, replay gaps, and misleading evidence.
- [ ] Publish the branch only after all required proof is current.

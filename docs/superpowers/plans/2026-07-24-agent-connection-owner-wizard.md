# Agent Connection Owner Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an authenticated owner/admin one guided browser flow to resolve or create an agent, configure immutable home plus optional cross-squad access, issue an agent-bound MCP credential once, install generated client configuration, verify messaging, and revisit a non-secret receipt.

**Architecture:** A focused dashboard sub-application under `/agents/connect` adapts the existing `provisionAgentConnection()` and `loadAgentConnectionStatus()` services rather than adding a second writer. Migration `0073` adds a race-safe pending-request quota; a narrow cancellation service releases an abandoned reservation owned by the same actor. Provisioning returns the raw credential and verification challenge only to the original no-store response, while refresh-safe receipt pages contain only authorized non-secret status and poll the existing status API.

**Tech Stack:** Cloudflare Workers, D1/SQLite, Hono, TypeScript, server-rendered HTML with minimal browser JavaScript, Vitest, Node `node:sqlite`.

## Global Constraints

- Start from the current head of stacked verification PR #538 on
  `feat/agent-connection-owner-wizard`; keep this slice independently reviewable.
- The dashboard is an adapter over `provisionAgentConnection`; it never writes
  agents, memberships, capabilities, bindings, tokens, requests, or receipts
  directly.
- Owner/admin authority is derived from the authenticated session. A bound
  agent session is never accepted as a wizard operator.
- Resolve-before-create is mandatory. An exact active name or slug match blocks
  creation and directs the operator to the existing identity.
- One agent keeps one immutable home squad. Cross-squad access reuses the same
  canonical agent/member binding.
- Reopening an agent or receipt never mints. Existing bound agents require the
  explicit `add` or `replace` credential action.
- The browser creates one stable `request_id` per draft and reuses it for every
  retry. A changed payload with that request ID remains a conflict.
- Each actor may hold at most three `pending` connection requests. The database
  enforces the limit under concurrency. An authenticated operator may cancel
  only their own exact pending request; cancellation never revokes a committed
  credential or rewrites a receipt.
- Raw credentials and plaintext challenges appear only in the successful
  provisioning response. They are not put in URLs, cookies, storage APIs,
  server logs, or the refresh-safe receipt page.
- Generated endpoint/configuration output comes only from pinned
  `PUBLIC_ORIGIN`; request Host is never used.
- The receipt page distinguishes immutable issuance facts from current agent,
  token, and access state.
- No production migration, deployment, live credential mutation, merge, or
  self-gate is authorized by this plan. Cursor/the user owns the PR gate.

## Error Contract

Wizard routes map service/database outcomes to stable, actionable errors:

- `forbidden`
- `agent_not_found`
- `agent_inactive`
- `existing_agent_match`
- `agent_already_connected`
- `agent_identity_unminted`
- `request_id_conflict`
- `agent_setup_in_progress`
- `too_many_pending_agent_connections`
- `request_not_pending`
- `replace_token_not_found`
- `public_origin_unconfigured`
- `receipt_failed`

Unknown internal errors return a generic failure and never expose SQL, a token,
challenge, binding difference, or cross-tenant existence.

## File Map

- Create `migrations/0073_agent_connection_pending_quota.sql` — concurrent
  pending-request quota trigger.
- Create `tests/agent-connection-pending-quota.test.ts` — real-SQLite quota and
  actor/tenant isolation coverage.
- Modify `src/members/agent-connection.ts` — stable quota error mapping and
  actor-scoped pending cancellation.
- Modify `tests/agent-connection-service.test.ts` — cancellation behavior and
  retry after release.
- Create `src/dashboard/agent-connection-wizard.ts` — authorization adapter,
  candidate search, parsing, route handlers, show-once response, and receipt UI.
- Create `tests/agent-connection-wizard.test.ts` — authenticated route/service
  integration coverage.
- Create `tests/agent-connection-wizard-render.test.ts` — pure HTML/JavaScript
  safety and state rendering coverage.
- Modify `src/dashboard/index.ts` — mount the wizard and replace the legacy
  create-only form with a guided-flow entry point.
- Modify `tests/dashboard-unit-panels.test.ts` and dashboard route tests — CTA,
  gate, and compatibility assertions.
- Modify `src/mcp/index.ts` and its tests — actionable `not_agent_bound` next
  action for messaging tools.
- Modify `scripts/local-browser-smoke.mjs` only if the existing authenticated
  smoke harness can visit the new GET surface without weakening its fixtures.
- Create `docs/superpowers/handoffs/2026-07-24-agent-connection-owner-wizard.md`
  — current-head evidence and independent-review boundary.

---

### Task 1: Enforce bounded pending reservations and recovery

**Files:**
- Create: `migrations/0073_agent_connection_pending_quota.sql`
- Create: `tests/agent-connection-pending-quota.test.ts`
- Modify: `src/members/agent-connection.ts`
- Modify: `tests/agent-connection-service.test.ts`

- [ ] **Step 1: Write failing real-SQLite quota tests**

Apply migrations through `0073`, then prove:

- three pending rows for one `(tenant, actor_kind, actor_id)` are allowed;
- the fourth insert fails with the stable quota condition;
- another actor and another tenant have independent quotas;
- terminal `completed|failed` rows do not consume quota;
- two concurrent-looking distinct request IDs cannot both cross the ceiling.

- [ ] **Step 2: Add the database trigger**

Create a `BEFORE INSERT` trigger on `agent_connection_requests` that raises
`agent_connection_pending_quota` when `NEW.status = 'pending'` and the same
tenant/actor already has three pending rows.

The quota is deliberately per actor, not per bare request ID or target, so one
operator cannot collide with another operator's recovery budget.

- [ ] **Step 3: Add stable service mapping**

Map only the exact trigger failure to
`too_many_pending_agent_connections`. Do not classify unrelated D1 errors as a
quota response.

- [ ] **Step 4: Add actor-scoped cancellation**

Export:

```ts
cancelAgentConnectionRequest(
  env: Env,
  actor: AgentConnectionActor,
  requestId: string,
  now?: Date,
): Promise<
  | { ok: true; status: 'cancelled' }
  | { ok: false; error: 'invalid_request_id' | 'request_not_pending' }
>
```

The sole mutation is a conditional update scoped by
`tenant + actor_kind + actor_id + request_id + status = 'pending'`, setting
`status = 'failed'`, `error_code = 'cancelled'`, and terminal timestamps.
Zero changed rows returns the same `request_not_pending` result for missing,
foreign, terminal, and cross-tenant requests.

- [ ] **Step 5: Prove cancellation and recovery**

Tests must show same-actor cancellation releases quota, foreign actors cannot
cancel, completed issuance cannot be cancelled or revoked, and the cancelled
request ID cannot later be reused to mint.

- [ ] **Step 6: Run focused tests**

```bash
pnpm vitest run tests/agent-connection-pending-quota.test.ts tests/agent-connection-service.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add migrations/0073_agent_connection_pending_quota.sql \
  src/members/agent-connection.ts \
  tests/agent-connection-pending-quota.test.ts \
  tests/agent-connection-service.test.ts
git commit -m "feat: bound pending agent connection requests"
```

---

### Task 2: Build the authenticated wizard adapter

**Files:**
- Create: `src/dashboard/agent-connection-wizard.ts`
- Create: `tests/agent-connection-wizard.test.ts`

- [ ] **Step 1: Write failing authorization and candidate-search tests**

Cover:

- owner/admin and current org-admin member access;
- ordinary member refusal;
- bound-agent session refusal even if it carries broad grants;
- tenant mismatch refusal;
- candidate search by case-insensitive name or slug;
- inactive agents excluded;
- result fields limited to ID, name, slug, status, immutable home squad, bound
  state, and non-secret live-token metadata.

- [ ] **Step 2: Implement one operator/auth adapter**

Map dashboard auth into `AgentConnectionActor` once:

- pure owner/admin web session → `kind: 'user'`;
- eligible member session → `kind: 'member'` with current resolved grants;
- any `boundAgentId` → refuse.

Do not add owner/admin compatibility logic inside the shared provisioning or
access services.

- [ ] **Step 3: Implement candidate search and resolve-before-create**

Use `findAgentsByName()` plus canonical binding/live-token reads. Before a new
target is provisioned, repeat an exact normalized name/slug lookup on the
server. Return `existing_agent_match` when an active identity matches; the
browser's prior search is helpful evidence but never the enforcement boundary.

- [ ] **Step 4: Parse a narrow JSON provision contract**

The POST body contains:

```ts
{
  request_id: string
  target:
    | { kind: 'existing'; agent_ref: string }
    | {
        kind: 'new'
        home_squad_id: string
        agent: { name: string; slug: string; role: string; model: string }
      }
  additional_access: Array<{ squad_id: string; capability: Capability }>
  credential: {
    action: 'issue_if_missing' | 'add' | 'replace'
    label: string
    home_capability: 'observer' | 'member'
    replace_token_id?: string
  }
}
```

Reject unknown shapes and let the canonical service own all substantive
normalization, authorization, ceiling, and race rules.

- [ ] **Step 5: Add authenticated routes**

Mount:

- `GET /agents/connect` — wizard shell and squad choices;
- `GET /agents/connect/search?q=...` — non-secret candidates;
- `POST /agents/connect/provision` — shared service adapter;
- `POST /agents/connect/cancel` — actor-scoped abandoned-request recovery;
- `GET /agents/connect/receipts/:receiptId` — refresh-safe receipt shell.

All JSON routes use no-store and same-origin CSRF protection inherited from the
dashboard. Denied receipt lookups remain 404.

- [ ] **Step 6: Run focused tests**

```bash
pnpm vitest run tests/agent-connection-wizard.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/agent-connection-wizard.ts tests/agent-connection-wizard.test.ts
git commit -m "feat: add agent connection wizard adapter"
```

---

### Task 3: Implement agent and access steps

**Files:**
- Modify: `src/dashboard/agent-connection-wizard.ts`
- Modify: `tests/agent-connection-wizard-render.test.ts`
- Modify: `tests/agent-connection-wizard.test.ts`

- [ ] **Step 1: Write failing rendering and route tests**

Prove:

- Step 1 forces search before enabling new-agent creation;
- candidates show immutable home squad and connected/unminted state;
- selecting an existing agent cannot edit its home;
- Step 2 shows home access as locked;
- additional squad rows exclude home and duplicate squads;
- each access row shows the operator's current capability ceiling;
- review copy explicitly says the existing canonical identity is reused.

- [ ] **Step 2: Render accessible, progressively enhanced steps**

Keep navigation state in the page while it is open. Do not put a prospective
raw credential or challenge into page state. Generate the stable request ID in
the browser once per draft with `crypto.randomUUID()` and preserve it across
safe submission retries.

- [ ] **Step 3: Prove server enforcement**

Route tests bypass the browser controls to prove exact duplicate creation,
home-squad duplication, grant-above-ceiling, and unauthorized target-squad
access are still rejected without writes.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/agent-connection-wizard.ts \
  tests/agent-connection-wizard-render.test.ts \
  tests/agent-connection-wizard.test.ts
git commit -m "feat: guide agent identity and access selection"
```

---

### Task 4: Implement explicit credential and show-once connect steps

**Files:**
- Modify: `src/dashboard/agent-connection-wizard.ts`
- Modify: `tests/agent-connection-wizard-render.test.ts`
- Modify: `tests/agent-connection-wizard.test.ts`

- [ ] **Step 1: Write failing credential-semantics tests**

Cover:

- new/unminted agent offers only `issue_if_missing`;
- bound existing agent requires explicit `add` or `replace`;
- replacement lists only live tokens bound to that canonical agent/member;
- label length and `observer|member` home ceiling;
- GET/revisit never calls provisioning;
- a repeated identical submission returns service replay semantics and never
  exposes a second raw value.

- [ ] **Step 2: Render the successful show-once response**

Return JSON containing:

- raw token in a separate show-once field;
- plaintext verification challenge in a separate show-once field;
- receipt ID and stable receipt URL;
- pinned MCP endpoint;
- paste-ready Claude Code, Codex, and Cursor snippets that reference the token
  placeholder/environment variable rather than embedding the token;
- non-secret issuance summary.

The browser inserts these fields into the current DOM and provides explicit
copy controls. It must not call `history.pushState`, `replaceState`,
`localStorage`, `sessionStorage`, IndexedDB, Cache API, analytics, or a logging
API with either show-once value.

- [ ] **Step 3: Prove origin and refresh safety**

Use a malicious request Host with a pinned different `PUBLIC_ORIGIN`. Assert all
snippets, endpoint, and receipt URL use only the pinned origin. Refresh the
receipt URL and assert the response contains neither the raw token, plaintext
challenge, generated configuration, nor credential hash.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/agent-connection-wizard.ts \
  tests/agent-connection-wizard-render.test.ts \
  tests/agent-connection-wizard.test.ts
git commit -m "feat: render show-once agent connection setup"
```

---

### Task 5: Implement verification polling and durable receipt UI

**Files:**
- Modify: `src/dashboard/agent-connection-wizard.ts`
- Modify: `tests/agent-connection-wizard-render.test.ts`
- Modify: `tests/agent-connection-wizard.test.ts`

- [ ] **Step 1: Write failing receipt-state tests**

Cover pending, connected, verified, failed, expired, revoked-current-token, and
changed-current-access states. Ensure terminal polling stops for
`pass|fail|expired`, while manual refresh renders the same authorized state.

- [ ] **Step 2: Render the verification instruction**

The show-once page tells the operator to invoke:

```json
{
  "name": "verify_agent_connection",
  "arguments": {
    "receipt_id": "<receipt-id>",
    "challenge": "<show-once-challenge>"
  }
}
```

The challenge remains visually and structurally separate from every generated
client configuration.

- [ ] **Step 3: Poll only the authorized status endpoint**

Minimal JavaScript polls
`/api/agent-connections/<encoded-receipt-id>/status`, re-renders safe fields,
uses bounded backoff, and stops at a terminal status. It never interpolates a
receipt ID into an external origin.

- [ ] **Step 4: Separate issuance from current state**

Receipt HTML labels immutable issuance facts independently from current agent
status, token revocation, synchronized access, and verification evidence.
Links use only IDs already authorized in the receipt result.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/agent-connection-wizard.ts \
  tests/agent-connection-wizard-render.test.ts \
  tests/agent-connection-wizard.test.ts
git commit -m "feat: show agent connection verification receipts"
```

---

### Task 6: Cut over dashboard discovery and actionable messaging errors

**Files:**
- Modify: `src/dashboard/index.ts`
- Modify: `tests/dashboard-unit-panels.test.ts`
- Modify: relevant MCP messaging tests
- Modify: `src/mcp/index.ts`

- [ ] **Step 1: Mount the wizard**

Mount `agentConnectionWizardApp` under `/agents/connect` after the shared
dashboard auth/tenant middleware.

- [ ] **Step 2: Replace the legacy create-only form**

On `/agents`, show one primary **Create or connect agent** link for eligible
operators. Keep the primitive `POST /agents` compatibility route during this
stacked slice, but remove it as the promoted path and label it deprecated in
code. Do not redirect old POST clients into a credential-minting flow.

- [ ] **Step 3: Make agent-bound errors actionable**

For `send`, `broadcast`, and `inbox`, retain `not_agent_bound` and add the
canonical next action: use the owner flow at `/agents/connect` or the
`provision_agent_connection` MCP tool. Do not weaken authentication or reveal
another agent's connection state.

- [ ] **Step 4: Run route and messaging tests**

```bash
pnpm vitest run tests/dashboard-unit-panels.test.ts \
  tests/mcp-agent-tools.test.ts \
  tests/mcp-inbox-access.test.ts
```

Use the repository's actual matching test filenames if they differ; record the
exact command in the handoff.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.ts src/mcp/index.ts tests
git commit -m "feat: route operators through agent connection setup"
```

---

### Task 7: Prove the full owner journey and prepare the stacked PR

**Files:**
- Modify: `scripts/local-browser-smoke.mjs` when compatible
- Create: `docs/superpowers/handoffs/2026-07-24-agent-connection-owner-wizard.md`

- [ ] **Step 1: Run the complete focused matrix**

```bash
pnpm vitest run \
  tests/agent-connection-pending-quota.test.ts \
  tests/agent-connection-service.test.ts \
  tests/agent-connection-wizard.test.ts \
  tests/agent-connection-wizard-render.test.ts \
  tests/agent-connection-status.test.ts \
  tests/agent-connection-issued-key.test.ts \
  tests/mcp-agent-connection-verification.test.ts
```

- [ ] **Step 2: Exercise the browser journey**

Cover both new and existing agent paths, additional access, explicit add/replace,
show-once separation, generated configurations, refresh safety, verification
polling, and abandoned-request cancellation. If the repository browser harness
cannot safely seed this mutation flow, record it as `NOT YET TESTED` rather than
claiming browser proof from route tests.

- [ ] **Step 3: Run static and full-suite verification**

```bash
pnpm typecheck
pnpm vitest run --maxWorkers=4 --reporter=dot
git diff --check
git status --short
```

- [ ] **Step 4: Audit the sensitive boundary**

Use narrow searches and review the complete branch diff to prove:

- no direct wizard writes to protected tables;
- no raw token/challenge persistence or URL inclusion;
- no Host-derived configuration/receipt origin;
- no unscoped cancellation;
- no owner/admin widening in the shared access service;
- no production/deploy mutation.

- [ ] **Step 5: Write the handoff**

Record exact branch/head, base PR, focused/full commands and counts, browser
status, untested areas, CI status, and the independent-review boundary. Do not
include a token, challenge, hash, session, or secret.

- [x] **Step 6: Push and open a draft stacked PR**

Base the draft PR on `feat/agent-connection-guided-flow`, link #528, PR #537,
and PR #538, and state that this slice adds the owner wizard only. Do not merge,
deploy, run production migrations, or self-approve.

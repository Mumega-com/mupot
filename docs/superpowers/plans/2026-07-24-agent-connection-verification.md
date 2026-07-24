# Agent Connection Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the exact show-once agent credential issued by
`provisionAgentConnection()` can authenticate, orient its bound agent, send a
deterministic loopback request, observe it through inbox peek, and clean up only
that message, while the owner polls a non-secret receipt.

**Architecture:** Extend both MCP authentication doors with the server-derived
token ID, then add a focused verification service that owns challenge validation,
messaging proof, exact cleanup, and receipt/request transitions. The MCP callback
delegates to that service; an authenticated dashboard status route performs its
own actor-or-home-admin authorization on every poll.

**Tech Stack:** Cloudflare Workers, Hono, D1/SQLite, MCP JSON-RPC, Web Crypto,
Vitest, TypeScript.

## Global Constraints

- Base this stacked branch on foundation head `a69c680`; do not modify PR #537.
- Never accept `token_id`, `member_id`, `agent_id`, or tenant from callback input.
- Generate at least 128 bits of challenge entropy; foundation currently returns
  192 bits and only stores SHA-256.
- Compare challenge hashes with a constant-work byte comparison.
- Allow at most five wrong-challenge attempts. Attempts one through four remain
  retryable; attempt five sets receipt verification to `fail`, clears the hash,
  and terminally fails the request.
- Identity mismatches never consume another receipt's challenge budget.
- A successful verification is terminal and replay-safe.
- A transient orient/send/peek/cleanup failure records non-secret checks, keeps
  the challenge usable until expiry, and does not mint or rotate a credential.
- Poll authorization is issuing actor OR effective home-squad admin; all
  cross-tenant and unauthorized receipt lookups return 404.
- Never persist or return raw token, token hash, challenge plaintext, generated
  configuration, or loopback message body in a receipt or status payload.
- Loopback request ID is exactly `agent-connection:<receipt-id>`.
- Cleanup deletes only the exact tenant + message ID + bound agent + request ID
  row and must receipt one changed row.
- No production migration, deploy, live mint, or live token revocation is
  authorized by this plan.

---

### Task 1: Add verification attempt state and exact cleanup contract

**Files:**
- Create: `migrations/0072_agent_connection_verification.sql`
- Modify: `tests/agent-connections-migration.test.ts`
- Modify: `src/agents/messages.ts`
- Create: `tests/agent-connection-message-cleanup.test.ts`

**Interfaces:**
- Produces: `agent_connection_receipts.verification_attempts`.
- Produces:

```ts
export async function deleteAgentConnectionMessage(
  env: Env,
  input: {
    messageId: string
    agentId: string
    requestId: string
  },
): Promise<{ ok: true } | { ok: false; reason: 'message_not_found' | 'db_error' }>
```

- [ ] **Step 1: Write failing migration tests**

Add real-SQLite assertions that all migrations create
`verification_attempts INTEGER NOT NULL DEFAULT 0`, that negative values and
values above five are rejected, and that the field may increment while issuance
snapshot columns remain immutable.

- [ ] **Step 2: Write failing cleanup tests**

Seed two tenants and multiple messages, then prove cleanup removes exactly the
row matching all four server-known values and returns `message_not_found` for a
mismatch without deleting anything else.

- [ ] **Step 3: Run tests and verify failure**

```bash
npx vitest run \
  tests/agent-connections-migration.test.ts \
  tests/agent-connection-message-cleanup.test.ts
```

Expected: failure because migration `0072` and
`deleteAgentConnectionMessage()` do not exist.

- [ ] **Step 4: Add migration `0072`**

Use:

```sql
ALTER TABLE agent_connection_receipts
  ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER agent_connection_verification_attempts_insert
BEFORE INSERT ON agent_connection_receipts
WHEN NEW.verification_attempts < 0 OR NEW.verification_attempts > 5
BEGIN
  SELECT RAISE(ABORT, 'invalid_verification_attempts');
END;

CREATE TRIGGER agent_connection_verification_attempts_update
BEFORE UPDATE OF verification_attempts ON agent_connection_receipts
WHEN NEW.verification_attempts < OLD.verification_attempts
  OR NEW.verification_attempts > 5
BEGIN
  SELECT RAISE(ABORT, 'invalid_verification_attempts');
END;
```

- [ ] **Step 5: Implement exact cleanup**

Delete with one tenant-scoped statement:

```sql
DELETE FROM agent_messages
 WHERE tenant = ?
   AND id = ?
   AND to_agent = ?
   AND from_agent = ?
   AND request_id = ?
```

Map one changed row to `{ ok: true }`, zero to `message_not_found`, and thrown
errors to `db_error` without returning the raw database message.

- [ ] **Step 6: Run focused tests**

Expected: both files pass.

- [ ] **Step 7: Commit**

```bash
git add migrations/0072_agent_connection_verification.sql \
  src/agents/messages.ts \
  tests/agent-connections-migration.test.ts \
  tests/agent-connection-message-cleanup.test.ts
git commit -m "feat: add agent connection verification state"
```

---

### Task 2: Carry server-derived token identity through every MCP auth door

**Files:**
- Modify: `src/types.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/mcp/oauth-authorize.ts`
- Modify: `src/auth/member-bearer.ts`
- Modify: `tests/member-bearer.test.ts`
- Modify: `tests/oauth-dual-auth.test.ts`
- Create: `tests/mcp-token-identity.test.ts`

**Interfaces:**
- Produces: `AuthContext.tokenId?: string | null`.
- Produces: `AgentIdentity.tokenId: string`.
- Preserves: directory OAuth capability ceiling and `boundAgentId = null`.

- [ ] **Step 1: Write failing auth tests**

Cover:

- direct `mupot_` bearer authentication selects `t.id AS token_id`;
- OAuth-provider props re-read the exact live token and copy `props.tokenId`;
- injected internal auth headers are identity assertions only, but retain a
  syntactically valid `tokenId` after live capability re-resolution;
- revoked/wrong-member tokens still return null;
- shared HTTP bearer resolution returns the same token ID.

- [ ] **Step 2: Run tests and verify failure**

```bash
npx vitest run \
  tests/member-bearer.test.ts \
  tests/oauth-dual-auth.test.ts \
  tests/mcp-token-identity.test.ts
```

Expected: failure because the current auth shape omits token identity.

- [ ] **Step 3: Extend the types and queries**

Add:

```ts
tokenId?: string | null
```

to `AuthContext`, select `t.id AS token_id` in the direct MCP and shared bearer
queries, and set `tokenId` only from the committed row or trusted OAuth props.
Never read it from tool arguments.

- [ ] **Step 4: Preserve internal-header hardening**

When `resolveAuth()` accepts the internal OAuth header, re-resolve the referenced
token row by `(tokenId, memberId, tenant, revoked_at IS NULL)` before retaining
`tokenId` and `boundAgentId`. If that proof is absent, clear both and let
verification refuse.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npx vitest run \
  tests/member-bearer.test.ts \
  tests/oauth-dual-auth.test.ts \
  tests/mcp-token-identity.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/mcp/index.ts src/mcp/oauth-authorize.ts \
  src/auth/member-bearer.ts tests/member-bearer.test.ts \
  tests/oauth-dual-auth.test.ts tests/mcp-token-identity.test.ts
git commit -m "feat: expose authenticated token identity"
```

---

### Task 3: Implement retry-safe verification service

**Files:**
- Create: `src/members/agent-connection-verification.ts`
- Create: `tests/agent-connection-verification.test.ts`
- Modify: `src/members/agent-connection.ts`

**Interfaces:**
- Consumes: `buildOrient`, `sendAgentMessage`, `readAgentInbox`,
  `deleteAgentConnectionMessage`, `requiredCanonicalOrigin`.
- Produces:

```ts
export interface AgentConnectionVerificationPrincipal {
  tenant: string
  tokenId: string
  memberId: string
  agentId: string
}

export type AgentConnectionVerificationOutcome =
  | {
      status: 'messaging_verified'
      receiptId: string
      messageId: string
      replay: boolean
      checks: Record<string, { status: 'pass' }>
    }
  | {
      status: 'verification_incomplete'
      error: string
      retryable: boolean
    }

export async function verifyAgentConnection(
  env: Env,
  principal: AgentConnectionVerificationPrincipal,
  input: { receiptId: string; challenge: string },
  now?: Date,
  deps?: Partial<AgentConnectionVerificationDeps>,
): Promise<AgentConnectionVerificationOutcome>
```

- [ ] **Step 1: Write failing real-SQLite tests**

Provision a receipt through `provisionAgentConnection()` and cover:

- exact token/member/agent/tenant + challenge succeeds;
- orient returns the bound agent;
- deterministic self-send uses `kind=request` and the exact request ID;
- inbox peek observes the exact message;
- cleanup deletes only that message;
- receipt and request become `messaging_verified`;
- replay returns the committed pass without another send;
- wrong tenant is indistinguishable from absent receipt;
- wrong token, member, or agent is generic and does not increment attempts;
- challenge mismatch increments attempts atomically;
- attempts one through four remain pending/retryable;
- attempt five sets `verification_status=fail`, clears hash, and fails request;
- expired challenge returns terminal incomplete;
- an injected orient/send/peek/cleanup failure records only non-secret checks,
  marks `client_connected`, and remains retryable;
- a retry after transient cleanup failure reuses the deterministic send and
  finishes cleanup/pass.

- [ ] **Step 2: Run test and verify failure**

```bash
npx vitest run tests/agent-connection-verification.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement constant-work challenge validation**

Hash the supplied challenge with SHA-256, decode both lowercase hex digests into
fixed 32-byte arrays, XOR every byte, and branch only after the loop. Reject
malformed stored hashes generically.

- [ ] **Step 4: Implement identity and attempt transitions**

Load by `(tenant, receipt_id)`, compare the four server-derived identity fields,
then conditionally increment:

```sql
UPDATE agent_connection_receipts
   SET verification_attempts = verification_attempts + 1,
       verification_status =
         CASE WHEN verification_attempts + 1 >= 5 THEN 'fail'
              ELSE verification_status END,
       verification_challenge_hash =
         CASE WHEN verification_attempts + 1 >= 5 THEN NULL
              ELSE verification_challenge_hash END,
       verification_error_code = 'challenge_mismatch',
       updated_at = ?
 WHERE tenant = ?
   AND id = ?
   AND verification_status = 'pending'
   AND verification_attempts < 5;
```

At the fifth failure, conditionally update the matching request to `failed`.

- [ ] **Step 5: Implement messaging proof**

Call `buildOrient()` for the receipt agent, then:

```ts
const requestId = `agent-connection:${receipt.id}`
const body = 'Mupot agent connection verification'
```

Use `sendAgentMessage()` with a server-only self-send authorization reason,
`readAgentInbox(..., { peek: true, limit: 100 })`, match by returned message ID
and request ID, then call `deleteAgentConnectionMessage()`.

- [ ] **Step 6: Commit verification results atomically**

On pass, one D1 batch must:

- set receipt `verification_status='pass'`;
- clear `verification_challenge_hash`;
- set `client_connected_at`, message/request IDs, `messaging_verified_at`,
  `checks_json`, and `updated_at`;
- set request `status='messaging_verified'` only from
  `credential_issued|client_connected`.

On transient service failure, persist `client_connected_at`, non-secret
`checks_json`, and a stable error code while keeping receipt `pending` and the
request at `client_connected`.

Assert every conditional write.

- [ ] **Step 7: Run focused tests**

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/members/agent-connection-verification.ts \
  src/members/agent-connection.ts \
  tests/agent-connection-verification.test.ts
git commit -m "feat: verify agent messaging connections"
```

---

### Task 4: Add the agent-bound MCP callback

**Files:**
- Create: `src/mcp/agent-connection.ts`
- Modify: `src/mcp/index.ts`
- Create: `tests/mcp-agent-connection-verification.test.ts`
- Modify: `tests/provision-tools.test.ts`

**Interfaces:**
- Produces MCP tool:

```json
{
  "name": "verify_agent_connection",
  "arguments": {
    "receipt_id": "uuid",
    "challenge": "show-once value"
  }
}
```

- [ ] **Step 1: Write failing MCP tests**

Drive JSON-RPC with real SQLite and the issued raw token. Prove the callback:

- is advertised;
- accepts only `receipt_id` and `challenge`;
- derives token/member/agent/tenant from authentication;
- refuses human/workspace unbound tokens;
- refuses another token for the same agent;
- maps mismatch/expiry/retry/pass/replay to stable codes without identity
  details;
- never returns challenge, raw token, token hash, or message body.

- [ ] **Step 2: Run test and verify failure**

```bash
npx vitest run tests/mcp-agent-connection-verification.test.ts
```

Expected: `unknown_tool`.

- [ ] **Step 3: Implement and register tool**

Require `auth.tokenId`, `auth.memberId`, and `auth.boundAgentId`; call
`verifyAgentConnection()` with those server-derived fields. Use
`additionalProperties: false`. Map errors to 400/403/404/409/410/500 without
returning which identity field mismatched.

- [ ] **Step 4: Run MCP and provisioning tests**

```bash
npx vitest run \
  tests/mcp-agent-connection-verification.test.ts \
  tests/provision-tools.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/agent-connection.ts src/mcp/index.ts \
  tests/mcp-agent-connection-verification.test.ts tests/provision-tools.test.ts
git commit -m "feat: add agent connection verification tool"
```

---

### Task 5: Add authorized non-secret status polling

**Files:**
- Create: `src/members/agent-connection-status.ts`
- Modify: `src/dashboard/index.ts`
- Create: `tests/agent-connection-status.test.ts`

**Interfaces:**
- Produces:

```ts
export async function loadAgentConnectionStatus(
  env: Env,
  auth: AuthContext,
  receiptId: string,
): Promise<
  | { ok: true; value: AgentConnectionPublicStatus }
  | { ok: false; error: 'not_found' }
>
```

- Produces: `GET /api/agent-connections/:receiptId/status`.

- [ ] **Step 1: Write failing route tests**

Cover:

- issuing web user;
- issuing member;
- effective home-squad admin through org/department/squad inheritance;
- unauthorized same-tenant caller gets 404;
- cross-tenant caller gets 404;
- revoked token and changed current access are labelled current state;
- output includes no actor ID, raw/hash/challenge/config/message body;
- pending/pass/fail/expired states survive manual refresh.

- [ ] **Step 2: Run test and verify failure**

```bash
npx vitest run tests/agent-connection-status.test.ts
```

Expected: route not found.

- [ ] **Step 3: Implement authorization**

Load the receipt only for `env.TENANT_SLUG`. Allow when:

```ts
const issuedByCaller =
  (receipt.actor_kind === 'user' && auth.userId === receipt.actor_id)
  || (receipt.actor_kind === 'member' && auth.memberId === receipt.actor_id)
```

or when the caller is an owner/admin web session or has effective admin on
`receipt.home_squad_id`. Collapse every denial to `not_found`.

- [ ] **Step 4: Build the public status**

Return issuance snapshot plus separately labelled current agent status, token
revocation boolean, and synchronized access. Return only the last four
characters of token ID in polling output.

- [ ] **Step 5: Register route and run tests**

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/members/agent-connection-status.ts src/dashboard/index.ts \
  tests/agent-connection-status.test.ts
git commit -m "feat: expose agent connection status"
```

---

### Task 6: Prove the issued key on all public messaging surfaces

**Files:**
- Create: `tests/agent-connection-issued-key.test.ts`
- Modify only production files required by a demonstrated parity defect.

**Interfaces:**
- Verifies: `boot_context`, `orient`, `send`, `inbox { peek: true }`,
  `verify_agent_connection`, and exact cleanup.

- [ ] **Step 1: Build one real end-to-end SQLite/MCP test**

Apply all migrations, seed an operator, call
`provision_agent_connection`, capture the show-once raw token, reconnect using
that raw token, and assert:

1. `boot_context.bound_agent_id` is the receipt agent;
2. `orient` without args returns that agent;
3. `send` self-loopback returns one message ID;
4. `inbox { peek: true }` returns that exact ID without consuming;
5. cleanup removes only that message;
6. `verify_agent_connection` records pass;
7. owner polling returns `messaging_verified`.

Also drive Claude/Codex/Cursor configuration output and assert every endpoint
uses pinned `PUBLIC_ORIGIN` under a malicious request Host.

- [ ] **Step 2: Add the negative matrix**

Use a human token, another token for the same agent, another agent token, and a
cross-tenant receipt. All must fail closed without exposing identity mismatch
details.

- [ ] **Step 3: Run the end-to-end test**

```bash
npx vitest run tests/agent-connection-issued-key.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add tests/agent-connection-issued-key.test.ts
git commit -m "test: prove issued agent connection key"
```

---

### Task 7: Verify the verification release candidate

**Files:**
- Modify only files required by attributable failures.

**Interfaces:**
- Verifies the entire stacked verification slice.

- [ ] **Step 1: Run focused matrix**

```bash
npx vitest run \
  tests/agent-connections-migration.test.ts \
  tests/agent-connection-message-cleanup.test.ts \
  tests/member-bearer.test.ts \
  tests/oauth-dual-auth.test.ts \
  tests/mcp-token-identity.test.ts \
  tests/agent-connection-verification.test.ts \
  tests/mcp-agent-connection-verification.test.ts \
  tests/agent-connection-status.test.ts \
  tests/agent-connection-issued-key.test.ts \
  tests/agent-connection-service.test.ts \
  tests/provision-tools.test.ts
```

- [ ] **Step 2: Run typecheck and full suite**

```bash
npm run typecheck
npm test
```

- [ ] **Step 3: Run secret/direct-write audit**

```bash
git diff --check
rg -n "verification_challenge_hash|token_hash|credential\\.raw" \
  src/members/agent-connection-verification.ts \
  src/members/agent-connection-status.ts \
  src/mcp/agent-connection.ts
git status --short
```

Inspect every match. Stored challenge hashes are allowed; raw/token hashes in
public payload construction are not.

- [ ] **Step 4: Push a stacked PR**

Open against `feat/agent-connection-foundation`, link #528 and PR #537, list
the exact current-head evidence, and request independent red-team review.

---

## Deferred to the Owner Wizard Plan

- Create/connect wizard screens.
- Resolve-before-create search UI.
- Access/credential review step.
- Show-once credential page and copy controls.
- Receipt completion page and polling client.
- Pending-per-actor quota and owner/admin cancellation surface.
- Legacy agent-token UI deprecation after parity evidence.

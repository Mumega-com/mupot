# Grant Agent Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-gated MCP tool that grants an existing stable agent identity a capability on an additional squad without minting a new agent, member, or token.

**Architecture:** Shared member-service functions resolve exactly one active agent-bound member and idempotently persist capability grants. The existing HTTP member route delegates persistence to the shared service, while MCP resolves agent/squad references, enforces target-squad admin and caller-rank ceilings, then emits an attributed provision receipt.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Vitest, MCP JSON-RPC.

## Global Constraints

- Never return, log, mint, revoke, or modify a raw credential.
- Reject zero or multiple active bound member identities.
- Require caller `admin` on the target squad and reject grants above the caller's effective rank.
- Exclude `owner` from the tool capability enum.
- Preserve existing HTTP capability behavior and tenant isolation.
- No D1 schema migration or unrelated refactor.

---

### Task 1: Shared Agent Identity And Grant Persistence

**Files:**
- Modify: `src/members/service.ts`
- Modify: `src/members/index.ts`
- Test: `tests/members-capability-service.test.ts`

**Interfaces:**
- Produces: `resolveActiveAgentMember(env, agentId)` returning one member ID or `unminted|ambiguous`.
- Produces: `upsertCapabilityGrant(env, grant)` returning `{ grant, result: 'created'|'updated'|'unchanged' }`.
- Consumes: existing `CapabilityGrant`, `Env`, D1 batch receipt checks.

- [ ] **Step 1: Write failing service tests**

Cover one active token, multiple tokens for the same member, zero identities, multiple distinct
members, inactive/revoked filtering, and created/updated/unchanged grant outcomes. Assert the
identity query is tenant-bound and the write is delete-then-insert in one batch.

- [ ] **Step 2: Verify tests fail for missing exports**

Run:

```bash
npx vitest run tests/members-capability-service.test.ts
```

Expected: FAIL because `resolveActiveAgentMember` and `upsertCapabilityGrant` are not exported.

- [ ] **Step 3: Implement the service functions**

Use the identity query:

```sql
SELECT DISTINCT t.member_id
FROM member_tokens t
JOIN members m ON m.id = t.member_id
WHERE t.tenant = ?
  AND t.agent_id = ?
  AND t.revoked_at IS NULL
  AND m.tenant = ?
  AND m.status = 'active'
ORDER BY t.member_id
LIMIT 2
```

Use an existing-grant read followed by the same explicit delete-then-insert D1 batch currently in
`src/members/index.ts`. Call `assertBatchWritten` for the inserted grant statement.

- [ ] **Step 4: Delegate HTTP persistence to the service**

Keep member/scope validation and `actorMaxRankOnScope` in the route. Replace only the inline grant
SQL with:

```ts
const outcome = await upsertCapabilityGrant(c.env, grant)
return c.json({ grant: outcome.grant, action: 'grant', result: outcome.result }, 201)
```

- [ ] **Step 5: Verify service and existing member tests**

```bash
npx vitest run tests/members-capability-service.test.ts tests/members-sensitive-response.test.ts tests/members-token-lifecycle.test.ts
```

Expected: PASS.

### Task 2: MCP `grant_agent_capability`

**Files:**
- Modify: `src/mcp/provision.ts`
- Modify: `tests/provision-tools.test.ts`
- Modify: `docs/runtime-adapter-contract.md`

**Interfaces:**
- Consumes: `resolveAgentRef`, `resolveSquadRef`, `resolveActiveAgentMember`, `upsertCapabilityGrant`, `hasCapability`, and `memberCanOnSquad`.
- Produces: MCP tool `grant_agent_capability { agent, squad, capability }`.

- [ ] **Step 1: Write failing MCP tests**

Add tests proving advertisement/schema, successful member grant, idempotent result, same-member
multi-token acceptance, unminted/ambiguous identity rejection, invalid capability rejection,
target-squad admin enforcement, above-caller ceiling rejection, and absence of token fields in the
response/event.

- [ ] **Step 2: Verify MCP tests fail**

```bash
npx vitest run tests/provision-tools.test.ts
```

Expected: FAIL because `grant_agent_capability` is not advertised.

- [ ] **Step 3: Implement the tool**

Validate capability with a local allowlist:

```ts
const GRANTABLE_AGENT_CAPABILITIES = new Set<Capability>(['observer', 'member', 'lead', 'admin'])
```

Resolve the agent and squad, require `memberCanOnSquad(..., 'admin')`, then require:

```ts
hasCapability(auth.capabilities ?? [], 'squad', squad.id, capability, squad.department_id)
```

Resolve the active bound member, call `upsertCapabilityGrant`, emit kind `capability`, and return
only resolved public IDs and the grant outcome.

- [ ] **Step 4: Document the contract**

Add the exact tool signature, authorization rule, identity ambiguity behavior, and no-token
invariant beside the existing provision-tool documentation.

- [ ] **Step 5: Verify focused behavior**

```bash
npx vitest run tests/provision-tools.test.ts tests/oauth-dual-auth.test.ts tests/runtime-adapter-contract.test.ts
```

Expected: PASS.

### Task 3: Regression, Review, Publication, And Production Proof

**Files:**
- Modify only if verification exposes a scoped defect.

**Interfaces:**
- Consumes: completed Tasks 1-2.
- Produces: merged/deployed code plus production D1 and flight receipts.

- [ ] **Step 1: Run complete local verification**

```bash
npm run typecheck
npm test -- --run
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Request independent review**

Reviewer checks authorization ceilings, identity ambiguity, tenant filters, SQL batch semantics,
response secrecy, and compatibility with flight authorization.

- [ ] **Step 3: Commit, push, and open a draft PR**

Use branch `codex/grant-agent-capability`, link issue #336, and include exact test counts.

- [ ] **Step 4: Merge only after every GitHub check passes**

Mark ready, merge to `main`, and record the exact merge commit.

- [ ] **Step 5: Deploy the exact merge commit**

Run production dry-run, deploy with `wrangler.mumega.toml`, and verify `/health`.

- [ ] **Step 6: Apply and verify tenant-zero grants**

Use a temporary owner credential to grant the stable Product, Kasra, Loom, Hermes, and Fleet
Consumer member identities only their documented squad capabilities. Revoke the owner credential
and verify all rows through read-only D1.

- [ ] **Step 7: Dispatch and land the bounded cross-squad flight**

Mint a temporary Product verification credential, grant that one member the required flight
squads, create a task with a non-placeholder `done_when`, dispatch a zero-budget flight referencing
the task and squads, complete the task, land the flight, verify outbox delivery/consumption, and
revoke the credential.

- [ ] **Step 8: Record reusable Mumega evidence**

Update the M1 manifest and append a content-hashed final receipt containing squad IDs, grant rows,
task/flight/outbox IDs, code/deployment versions, test counts, and credential revocation receipts.
Run JSON/hash validation, workflow tests, and the private secret scan before commit and push.

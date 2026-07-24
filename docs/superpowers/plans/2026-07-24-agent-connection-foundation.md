# Agent Connection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land rollout steps 1–3 of the approved agent-connection design: canonical agent/member identity, synchronized squad access, race-safe agent token minting, and sole-writer cutover for existing MCP, REST, and dashboard credential surfaces.

**Architecture:** Migration `0071_agent_connections.sql` makes the canonical agent/member binding and request/receipt contracts database-enforced. The existing members service becomes binding-aware, a focused `agent-access` service owns routing plus authorization, and `provisionAgentConnection()` composes prepared mutations into the approved reservation/provisioning boundaries. Existing entry points and the new high-level MCP tool share those services; the verification callback and wizard are separate follow-on plans.

**Tech Stack:** Cloudflare Workers, D1/SQLite, Hono, TypeScript, Vitest, Node `node:sqlite`.

## Global Constraints

- One agent has one immutable home squad and one canonical member identity.
- The canonical home-squad capability is identity-wide and permanently limited to `observer|member`.
- Additional tokens inherit the existing home capability; they do not change it.
- Cross-squad access may use `observer|member|lead|admin`, subject to target-squad admin authority and the caller's grant ceiling.
- `memberships` is routing presence only and stores the neutral `member` marker; `capabilities` remains the sole authorization source.
- `create_agent` creates only the agent plus home routing membership; it never creates a member, binding, capability, or token.
- `grant_agent_capability`, `register_agent_key`, and the REST membership route refuse unminted agents.
- Raw credentials are returned once, never logged, never stored, and never included in configuration snippets.
- Generated endpoint/configuration output requires pinned `PUBLIC_ORIGIN`; Host-derived fallback is forbidden. HTTPS is required except explicit loopback HTTP.
- Request identity is `(tenant, actor_kind, actor_id, request_id)`, never a bare request ID.
- No wizard, production migration, deployment, live mint, or token revocation is part of this plan.

---

## File Map

- Create `migrations/0071_agent_connections.sql` — canonical binding, migration guard/backfill, token weld triggers, request table, receipt table, and receipt immutability.
- Create `tests/agent-connections-migration.test.ts` — real-SQLite migration and constraint coverage.
- Modify `src/members/service.ts` — binding resolution and race-safe agent-bound mint.
- Modify `tests/dashboard-agent-token.test.ts` — canonical binding and inherited-home-capability mint coverage.
- Modify `tests/members-capability-service.test.ts` — binding-based resolution coverage.
- Modify `tests/members-capability-sqlite.test.ts` — remove active-token identity assumptions.
- Create `src/members/agent-access.ts` — synchronized add/change/remove access service.
- Create `tests/agent-access-service.test.ts` — real-SQLite synchronized-writer tests.
- Modify `src/mcp/provision.ts` — MCP mint/grant delegation and home ceiling.
- Modify `tests/provision-tools.test.ts` — MCP compatibility behavior.
- Modify `src/org/index.ts` — REST delegation and target-squad admin floor.
- Modify `src/org/service.ts` — expose prepared agent-create statements without changing primitive behavior.
- Create `tests/org-agent-membership.test.ts` — REST authorization and state-parity coverage.
- Modify `src/dashboard/connect.ts` — strict pinned-origin helper and Cursor snippet.
- Modify `tests/dashboard-connect.test.ts` — Host-injection and loopback-origin matrix.
- Modify `src/dashboard/index.ts` — use pinned origin before credential mutation.
- Modify `tests/members-sensitive-response.test.ts` and `tests/dashboard-agent-token.test.ts` — dashboard no-mutation origin failures.
- Create `src/members/agent-connection.ts` — actor-scoped reservation and atomic full provisioning service.
- Create `tests/agent-connection-service.test.ts` — new/existing, retry, race, receipt, and raw-loss behavior.
- Modify `src/index.ts` — schedule fail-soft request/receipt retention maintenance.
- Modify `src/tasks/assignee.ts` only if its import or identity-result type changes; assignment behavior remains unchanged.

---

### Task 1: Add the database-enforced connection contract

**Files:**
- Create: `migrations/0071_agent_connections.sql`
- Create: `tests/agent-connections-migration.test.ts`

**Interfaces:**
- Produces: `agent_member_bindings`, `agent_connection_requests`, `agent_connection_receipts`.
- Produces: token triggers that require `(tenant, agent_id, member_id)` to match the canonical binding.
- Produces: one pending request per `(tenant, target_key)`.
- Consumes: existing `agents`, `members`, and `member_tokens` tables.

- [ ] **Step 1: Write the failing migration tests**

Create a real-SQLite harness that applies all migrations through `0070`, seeds agents/members/tokens, then applies `0071`.

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const DIR = join(__dirname, '..', 'migrations')
const TARGET = '0071_agent_connections.sql'

function applyBeforeTarget(sqlite: { exec(sql: string): void }) {
  for (const file of readdirSync(DIR).filter((name) => name.endsWith('.sql') && name < TARGET).sort()) {
    sqlite.exec(readFileSync(join(DIR, file), 'utf8'))
  }
}

function applyTarget(sqlite: { exec(sql: string): void }) {
  sqlite.exec(readFileSync(join(DIR, TARGET), 'utf8'))
}

function seedOrg(sqlite: { exec(sql: string): void }) {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-home', 'dept-1', 'home', 'Home'),
      ('squad-other', 'dept-1', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-1', 'squad-home', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-1', 'Agent Member', 'active', 'tenant-a');
  `)
}
```

Add tests proving:

```ts
it('backfills one binding from all historical tokens for one member', () => {
  const h = createSqliteD1()
  applyBeforeTarget(h.sqlite)
  seedOrg(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
    VALUES
      ('token-live', 'member-1', 'hash-live', '', 'workspace', datetime('now'), NULL, 'agent-1', 'tenant-a'),
      ('token-old', 'member-1', 'hash-old', '', 'workspace', datetime('now'), datetime('now'), 'agent-1', 'tenant-a');
  `)
  applyTarget(h.sqlite)
  expect(h.sqlite.prepare(
    'SELECT tenant, agent_id, member_id FROM agent_member_bindings',
  ).all()).toEqual([{ tenant: 'tenant-a', agent_id: 'agent-1', member_id: 'member-1' }])
  h.close()
})

it('blocks migration when one agent has two historical members', () => {
  const h = createSqliteD1()
  applyBeforeTarget(h.sqlite)
  seedOrg(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-2', 'Duplicate', 'active', 'tenant-a');
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES
      ('token-1', 'member-1', 'hash-1', '', 'workspace', datetime('now'), 'agent-1', 'tenant-a'),
      ('token-2', 'member-2', 'hash-2', '', 'workspace', datetime('now'), 'agent-1', 'tenant-a');
  `)
  expect(() => applyTarget(h.sqlite)).toThrow()
  h.close()
})
```

Also cover tenant-null welded rows, multiple tokens for the same canonical member, mismatched token insert/update refusal, binding update refusal, binding deletion while tokens exist, actor-scoped request reuse, pending-target collision across actors, receipt snapshot immutability, and allowed verification-field updates.

- [ ] **Step 2: Run the migration test and verify it fails**

Run:

```bash
npx vitest run tests/agent-connections-migration.test.ts
```

Expected: FAIL because `migrations/0071_agent_connections.sql` does not exist.

- [ ] **Step 3: Create the migration**

Use the approved table columns from the design and add these exact enforcement patterns:

```sql
CREATE TABLE agent_member_bindings (
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, agent_id),
  UNIQUE (tenant, member_id)
);

CREATE TABLE agent_connection_migration_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO agent_connection_migration_guard (ok)
SELECT 0
  FROM member_tokens
 WHERE agent_id IS NOT NULL AND tenant IS NULL
 LIMIT 1;

INSERT INTO agent_connection_migration_guard (ok)
SELECT 0
  FROM member_tokens
 WHERE agent_id IS NOT NULL
 GROUP BY tenant, agent_id
HAVING COUNT(DISTINCT member_id) > 1
 LIMIT 1;

DROP TABLE agent_connection_migration_guard;

INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
SELECT tenant, agent_id, MIN(member_id), MIN(created_at)
  FROM member_tokens
 WHERE agent_id IS NOT NULL
 GROUP BY tenant, agent_id;
```

Then create the request and receipt tables exactly as specified in
`docs/superpowers/specs/2026-07-24-agent-connection-flow-design.md`, including:

```sql
PRIMARY KEY (tenant, actor_kind, actor_id, request_id)
```

and:

```sql
CREATE UNIQUE INDEX idx_agent_connection_one_pending_target
  ON agent_connection_requests (tenant, target_key)
  WHERE status = 'pending';
```

Add the binding and token guards:

```sql
CREATE TRIGGER agent_member_bindings_no_update
BEFORE UPDATE ON agent_member_bindings
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER agent_member_bindings_delete_requires_no_tokens
BEFORE DELETE ON agent_member_bindings
WHEN EXISTS (
  SELECT 1 FROM member_tokens
   WHERE tenant = OLD.tenant
     AND agent_id = OLD.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER member_tokens_agent_binding_insert
BEFORE INSERT ON member_tokens
WHEN NEW.agent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_member_bindings
   WHERE tenant = NEW.tenant
     AND agent_id = NEW.agent_id
     AND member_id = NEW.member_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER member_tokens_agent_binding_update
BEFORE UPDATE OF tenant, agent_id, member_id ON member_tokens
WHEN NEW.agent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_member_bindings
   WHERE tenant = NEW.tenant
     AND agent_id = NEW.agent_id
     AND member_id = NEW.member_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;
```

Add a receipt trigger whose `WHEN` clause compares every immutable issuance
column with `IS NOT`; permit changes only to
`verification_status`, `verification_challenge_hash`,
`verification_expires_at`, `client_connected_at`,
`verification_message_id`, `verification_request_id`,
`messaging_verified_at`, `verification_error_code`, `checks_json`, and
`updated_at`.

Also add a `BEFORE INSERT` receipt trigger that aborts inside SQLite unless the
matching actor-scoped request still exists with the same fingerprint and
`status='pending'`:

```sql
CREATE TRIGGER agent_connection_receipt_requires_pending_request
BEFORE INSERT ON agent_connection_receipts
WHEN NOT EXISTS (
  SELECT 1
    FROM agent_connection_requests
   WHERE tenant = NEW.tenant
     AND actor_kind = NEW.actor_kind
     AND actor_id = NEW.actor_id
     AND request_id = NEW.request_id
     AND request_fingerprint = NEW.request_fingerprint
     AND status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'agent_connection_request_not_pending');
END;
```

This trigger—not a post-commit JavaScript row-count assertion—is the rollback
guard for stale provisioning attempts.

- [ ] **Step 4: Run migration and compatibility tests**

Run:

```bash
npx vitest run tests/agent-connections-migration.test.ts tests/migration-d1-compat.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit**

```bash
git add migrations/0071_agent_connections.sql tests/agent-connections-migration.test.ts
git commit -m "feat: add canonical agent connection schema"
```

---

### Task 2: Make agent token minting use the canonical binding

**Files:**
- Modify: `src/members/service.ts:126-326`
- Modify: `tests/dashboard-agent-token.test.ts:113-205`
- Modify: `tests/members-capability-service.test.ts:133-178`
- Modify: `tests/members-capability-sqlite.test.ts:88-151`
- Modify: `src/tasks/assignee.ts:1-44` only if the result type import changes

**Interfaces:**
- Produces: `resolveAgentMemberBinding(env, agentId): Promise<{ kind: 'bound'; memberId: string } | { kind: 'unminted' }>`
- Produces: `prepareAgentBoundTokenMint(env, input): Promise<PreparedAgentTokenMint>` with raw/token metadata and uncommitted D1 statements.
- Preserves: `resolveActiveAgentMember()` as a compatibility wrapper during this slice.
- Produces: `mintAgentBoundToken()` that atomically creates/claims the binding and retries one lost claim.

- [ ] **Step 1: Write failing binding-aware mint tests**

Add real-SQLite tests for:

```ts
it('reuses the canonical member after every token is revoked', async () => {
  const first = await mintAgentBoundToken(env, agent, 'first', 'observer')
  sqlite.prepare('UPDATE member_tokens SET revoked_at = datetime(?) WHERE id = ?')
    .run('now', first.tokenId)
  const second = await mintAgentBoundToken(env, agent, 'second')
  expect(second.memberId).toBe(first.memberId)
  expect(second.grantCapability).toBe('observer')
})

it('allows two live tokens only when both use the bound member', async () => {
  const first = await mintAgentBoundToken(env, agent, 'first')
  const second = await mintAgentBoundToken(env, agent, 'second')
  expect(second.memberId).toBe(first.memberId)
  expect(sqlite.prepare(
    'SELECT COUNT(DISTINCT member_id) AS n FROM member_tokens WHERE agent_id = ?',
  ).get(agent.id)).toEqual({ n: 1 })
})

it('never raises or lowers the existing home grant during an additional mint', async () => {
  await mintAgentBoundToken(env, agent, 'first', 'observer')
  const second = await mintAgentBoundToken(env, agent, 'second', 'member')
  expect(second.grantCapability).toBe('observer')
})
```

Add a mocked D1 race test: the first batch throws
`agent_identity_conflict`, the binding re-read returns the winner's member, and
the retry inserts only the token for that member. Assert no raw token from the
failed attempt is returned or persisted.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/dashboard-agent-token.test.ts tests/members-capability-service.test.ts tests/members-capability-sqlite.test.ts
```

Expected: FAIL because identity resolution still scans only active tokens.

- [ ] **Step 3: Implement binding resolution**

Add:

```ts
export type AgentMemberBinding =
  | { kind: 'bound'; memberId: string }
  | { kind: 'unminted' }

export async function resolveAgentMemberBinding(
  env: Env,
  agentId: string,
): Promise<AgentMemberBinding> {
  const row = await env.DB.prepare(
    `SELECT b.member_id
       FROM agent_member_bindings b
       JOIN members m ON m.id = b.member_id
      WHERE b.tenant = ?1
        AND b.agent_id = ?2
        AND m.tenant = ?1
        AND m.status = 'active'
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<{ member_id: string }>()
  return row ? { kind: 'bound', memberId: row.member_id } : { kind: 'unminted' }
}
```

Keep `resolveActiveAgentMember()` temporarily returning its legacy string union,
but implement it by calling `resolveAgentMemberBinding()`. `ambiguous` remains in
the public type only for compatibility error mapping; migration `0071` prevents
new ambiguous state.

- [ ] **Step 4: Implement race-safe minting**

Change first mint to batch four ordered statements:

1. dedicated `members` insert;
2. `agent_member_bindings` insert;
3. home `capabilities` insert limited by `AgentTokenCapability`;
4. welded `member_tokens` insert.

Put statement construction in `prepareAgentBoundTokenMint()` so the full
connection service can place those same statements in its larger provisioning
batch. Its returned shape is:

```ts
export interface PreparedAgentTokenMint {
  raw: string
  tokenId: string
  memberId: string
  createdAt: string
  grantCapability: AgentTokenCapability
  statements: D1PreparedStatement[]
  bindingDisposition: 'created' | 'reused'
  bindingProof: {
    agentId: string
    memberId: string
    homeSquadId: string
    disposition: 'creating' | 'existing'
  }
}
```

For a bound agent, query the existing home capability and batch only the token
insert. Return the committed home capability, ignoring a conflicting default
from an additional-token caller. On `agent_identity_conflict`, discard the
failed raw value, re-read the binding once, generate a fresh raw token, and retry
against the winner's member. Any second conflict propagates.

Do not use `ON CONFLICT` to overwrite a binding. Do not delete or update the
binding. Keep `assertBatchWritten()` on every required insert.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/dashboard-agent-token.test.ts tests/members-capability-service.test.ts tests/members-capability-sqlite.test.ts tests/task-assignee.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit**

```bash
git add src/members/service.ts src/tasks/assignee.ts tests/dashboard-agent-token.test.ts tests/members-capability-service.test.ts tests/members-capability-sqlite.test.ts
git commit -m "feat: enforce canonical agent member bindings"
```

---

### Task 3: Add the sole synchronized squad-access writer

**Files:**
- Create: `src/members/agent-access.ts`
- Create: `tests/agent-access-service.test.ts`
- Modify: `src/members/service.ts` only to remove superseded guarded-grant code after callers move

**Interfaces:**
- Produces: `setAgentSquadAccess(env, input): Promise<AgentSquadAccessResult>`
- Produces: `removeAgentSquadAccess(env, input): Promise<AgentSquadAccessResult>`
- Produces: `prepareAgentSquadAccess(env, input, bindingProof): Promise<PreparedAgentSquadAccess>` for composition inside provisioning.
- Consumes: canonical `agent_member_bindings`.

- [ ] **Step 1: Write failing real-SQLite access tests**

Use all migrations and seed one bound agent plus home/target squads. Cover:

```ts
await expect(setAgentSquadAccess(env, {
  agentId: 'agent-1',
  memberId: 'member-1',
  squadId: 'squad-other',
  capability: 'admin',
})).resolves.toMatchObject({
  membership: { agent_id: 'agent-1', squad_id: 'squad-other', capability: 'member' },
  grant: { member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-other', capability: 'admin' },
})
```

Also assert:

- repeated calls are unchanged and never create duplicate rows;
- rank changes update only `capabilities`, retaining one membership;
- a mismatched member returns `agent_identity_conflict` with no writes;
- no binding returns `agent_identity_unminted`;
- home `lead|admin|owner` returns `home_capability_ceiling`;
- removing home access returns `home_squad_immutable`;
- removing cross-squad access deletes both rows in one batch;
- an injected failure on either write rolls back both representations.

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npx vitest run tests/agent-access-service.test.ts
```

Expected: FAIL because `src/members/agent-access.ts` does not exist.

- [ ] **Step 3: Implement the service**

Define:

```ts
export type AgentAccessCapability = 'observer' | 'member' | 'lead' | 'admin'

export interface SetAgentSquadAccessInput {
  agentId: string
  memberId: string
  squadId: string
  capability: AgentAccessCapability
}

export type AgentSquadAccessError =
  | 'agent_not_found'
  | 'squad_not_found'
  | 'agent_identity_unminted'
  | 'agent_identity_conflict'
  | 'home_capability_ceiling'
  | 'home_squad_immutable'
  | 'receipt_failed'
```

Load the agent home squad and canonical binding in one tenant-scoped read. Refuse
before writes on missing/conflicting binding or a home capability above
`member`. Batch:

```sql
INSERT INTO memberships (id, agent_id, squad_id, capability)
VALUES (?1, ?2, ?3, 'member')
ON CONFLICT(agent_id, squad_id) DO UPDATE SET capability = 'member';
```

and:

```sql
INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
VALUES (?1, ?2, 'squad', ?3, ?4)
ON CONFLICT(member_id, scope_type, scope_id)
DO UPDATE SET capability = excluded.capability;
```

`prepareAgentSquadAccess()` performs the same validation and returns both bound
statements plus the prior snapshot without executing them:

```ts
export interface PreparedAgentSquadAccess {
  statements: [D1PreparedStatement, D1PreparedStatement]
  priorMembership: 'present' | 'absent'
  priorCapability: AgentAccessCapability | null
  resultAfterCommit: 'created' | 'updated' | 'unchanged'
}
```

The builder consumes the binding proof returned by
`prepareAgentBoundTokenMint()`. For an existing proof it confirms the stored
binding before returning statements. For a `creating` proof, both INSERTs use
`INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM agent_member_bindings WHERE
tenant=? AND agent_id=? AND member_id=?)`; the orchestrator orders the binding
statement before access statements in the same batch. A lost binding claim
therefore yields zero access writes and the later welded-token trigger aborts
the whole batch.

`setAgentSquadAccess()` obtains an `existing` proof from the database, calls this
builder, executes its statements in one batch, asserts both receipts, and
re-reads state. The connection orchestrator uses the builder directly so all
requested additional squads land in its one provisioning batch.

Re-read both committed rows and return `created|updated|unchanged` by comparing
the prior state captured before the batch. Removal uses one batch with exact
`agent_id/member_id/squad_id` predicates and refuses when `squadId` equals the
home squad.

- [ ] **Step 4: Run access tests**

Run:

```bash
npx vitest run tests/agent-access-service.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit**

```bash
git add src/members/agent-access.ts tests/agent-access-service.test.ts src/members/service.ts
git commit -m "feat: synchronize agent squad access"
```

---

### Task 4: Require pinned canonical origins for credential output

**Files:**
- Modify: `src/dashboard/connect.ts:14-76`
- Modify: `tests/dashboard-connect.test.ts:11-75`
- Modify: `src/dashboard/index.ts:1800-1830`
- Modify: `tests/members-sensitive-response.test.ts`

**Interfaces:**
- Produces: `requiredCanonicalOrigin(env): { ok: true; origin: string } | { ok: false; error: 'public_origin_unconfigured' }`
- Produces: `cursorSnippet(slug, origin): string`
- Consumes: existing #88 `canonicalOrigin()`.

- [ ] **Step 1: Write the failing origin matrix**

Add:

```ts
expect(requiredCanonicalOrigin({ PUBLIC_ORIGIN: 'https://agents.example' }))
  .toEqual({ ok: true, origin: 'https://agents.example' })
expect(requiredCanonicalOrigin({ PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }))
  .toEqual({ ok: true, origin: 'http://127.0.0.1:8787' })
expect(requiredCanonicalOrigin({ PUBLIC_ORIGIN: 'http://evil.example' }))
  .toEqual({ ok: false, error: 'public_origin_unconfigured' })
expect(requiredCanonicalOrigin({}))
  .toEqual({ ok: false, error: 'public_origin_unconfigured' })
```

Add a request test with URL `https://evil.example/members/.../tokens` and
`PUBLIC_ORIGIN=https://pot.example`; assert every rendered endpoint is
`https://pot.example/mcp`, no `evil.example` appears, and missing
`PUBLIC_ORIGIN` causes a 503 before `INSERT INTO member_tokens`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run tests/dashboard-connect.test.ts tests/members-sensitive-response.test.ts
```

Expected: FAIL because strict origin resolution and Cursor output do not exist.

- [ ] **Step 3: Implement strict origin resolution**

Add:

```ts
export function requiredCanonicalOrigin(
  env: { PUBLIC_ORIGIN?: string },
): { ok: true; origin: string } | { ok: false; error: 'public_origin_unconfigured' } {
  const sentinel = 'mupot-host-derived-origin-forbidden'
  const origin = canonicalOrigin(env, sentinel)
  if (origin === sentinel) return { ok: false, error: 'public_origin_unconfigured' }
  const url = new URL(origin)
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'public_origin_unconfigured' }
  }
  return { ok: true, origin: url.origin }
}
```

Add `cursorSnippet()` as streamable HTTP JSON with the same
`<MEMBER_TOKEN>` placeholder discipline as `claudeCodeSnippet()`.

In the dashboard token route, resolve the pinned origin before calling
`mintMemberToken()`. Render a 503 error and perform no mutation on failure.

- [ ] **Step 4: Run origin tests**

Run:

```bash
npx vitest run tests/dashboard-connect.test.ts tests/members-sensitive-response.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/connect.ts src/dashboard/index.ts tests/dashboard-connect.test.ts tests/members-sensitive-response.test.ts
git commit -m "fix: pin credential output to public origin"
```

---

### Task 5: Cut MCP and REST compatibility surfaces over to the shared services

**Files:**
- Modify: `src/mcp/provision.ts:24-620`
- Modify: `tests/provision-tools.test.ts:1-720`
- Modify: `src/org/index.ts:20-305`
- Create: `tests/org-agent-membership.test.ts`
- Modify: `src/dashboard/index.ts:1324-1430`
- Modify: `tests/dashboard-agent-token.test.ts`

**Interfaces:**
- Consumes: `mintAgentBoundToken()`, `setAgentSquadAccess()`, `requiredCanonicalOrigin()`.
- Removes: independent capability-only and membership-only writes.
- Preserves: `create_agent` as an unminted primitive.

- [ ] **Step 1: Write failing MCP compatibility tests**

Add cases proving:

- `create_agent` inserts no member, binding, capability, or token;
- `mint_agent_token` returns the canonical member and inherited home capability;
- `mint_agent_token` rejects missing/unsafe `PUBLIC_ORIGIN` before mint;
- `mint_agent_token` returns only the pinned endpoint despite a malicious request Host;
- `grant_agent_capability` refuses home `lead|admin` with
  `home_capability_ceiling`;
- `grant_agent_capability` creates/updates both routing membership and capability;
- unminted grant remains `agent_identity_unminted`;
- `register_agent_key` remains create-on-missing forbidden.

- [ ] **Step 2: Write failing REST tests**

Drive `POST /api/org/agents/:id/memberships` through Hono and assert:

```ts
expect(leadResponse.status).toBe(403)
expect(await leadResponse.json()).toMatchObject({ error: 'forbidden', need: 'admin' })
expect(adminResponse.status).toBe(201)
expect(await readRows(sqlite)).toEqual({
  memberships: [{ agent_id: 'agent-1', squad_id: 'squad-other', capability: 'member' }],
  capabilities: [{ member_id: 'member-1', scope_id: 'squad-other', capability: 'lead' }],
})
```

Also cover repeated idempotent calls, unminted refusal, home ceiling, caller
grant ceiling, cross-tenant refusal, and rollback parity.

- [ ] **Step 3: Run focused surface tests and verify failure**

Run:

```bash
npx vitest run tests/provision-tools.test.ts tests/org-agent-membership.test.ts tests/dashboard-agent-token.test.ts
```

Expected: FAIL because the existing surfaces still write independently and the
REST route still gates at `lead`.

- [ ] **Step 4: Update MCP delegation**

In `mint_agent_token`, call `requiredCanonicalOrigin(env)` before
`mintAgentBoundToken()`. Return:

```ts
mcp_endpoint: mcpEndpoint(origin.origin)
```

and pass the same pinned origin to `wakeContractForAgent()`.

In `grant_agent_capability`, preserve target-squad admin and grant-ceiling
checks, then call:

```ts
setAgentSquadAccess(env, {
  agentId: agent.id,
  memberId: binding.memberId,
  squadId: squad.id,
  capability,
})
```

Map service errors one-to-one to the stable MCP errors in the design. Do not
fall back to `upsertActiveAgentCapabilityGrant()`.

- [ ] **Step 5: Update REST delegation**

Change the target gate to:

```ts
if (!(await canOnSquad(c.env, c.get('auth'), squad.id, 'admin'))) {
  return c.json({ error: 'forbidden', need: 'admin' }, 403)
}
```

Accept only `observer|member|lead|admin`. Resolve the canonical binding, enforce
the caller's grant ceiling with the target squad's `department_id`, and delegate
to `setAgentSquadAccess()`. Return 201 for `created`, 200 for
`updated|unchanged`, and stable 409 errors for unminted/conflict/home-ceiling
states.

- [ ] **Step 6: Keep dashboard mint on the canonical service**

The legacy `/admin/agent-token/mint` route remains available, but it must call
the binding-aware `mintAgentBoundToken()` and display the returned committed
home capability. Do not add the wizard in this task.

- [ ] **Step 7: Run focused surface tests**

Run:

```bash
npx vitest run tests/provision-tools.test.ts tests/org-agent-membership.test.ts tests/dashboard-agent-token.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/provision.ts src/org/index.ts src/dashboard/index.ts tests/provision-tools.test.ts tests/org-agent-membership.test.ts tests/dashboard-agent-token.test.ts
git commit -m "refactor: route agent access through shared services"
```

---

### Task 6: Add the full provisioning service and MCP tool

**Files:**
- Modify: `src/org/service.ts:300-470`
- Create: `src/members/agent-connection.ts`
- Create: `tests/agent-connection-service.test.ts`
- Modify: `src/mcp/provision.ts`
- Modify: `tests/provision-tools.test.ts`
- Modify: `src/dashboard/connect.ts`
- Modify: `tests/dashboard-connect.test.ts`

**Interfaces:**
- Produces: `prepareAgentCreate(env, squadId, input): Promise<CreateResult<PreparedAgentCreate>>`
- Produces: `provisionAgentConnection(env, actor, input): Promise<AgentConnectionOutcome>`
- Produces: MCP tool `provision_agent_connection`.
- Consumes: prepared agent create, token mint, and synchronized access statements.

- [ ] **Step 1: Write failing service tests**

Create a real-SQLite suite using all migrations and these public input types:

```ts
export interface AgentConnectionActor {
  kind: 'user' | 'member'
  id: string
  grants: CapabilityGrant[]
  legacyOrgRole?: 'owner' | 'admin'
}

export type AgentConnectionTarget =
  | { kind: 'existing'; agentRef: string }
  | { kind: 'new'; homeSquadId: string; agent: CreateAgentInput }

export interface AgentConnectionInput {
  requestId: string
  target: AgentConnectionTarget
  additionalAccess: Array<{
    squadId: string
    capability: 'observer' | 'member' | 'lead' | 'admin'
  }>
  credential: {
    action: 'issue_if_missing' | 'add' | 'replace'
    label: string
    homeCapability?: 'observer' | 'member'
    replaceTokenId?: string
  }
}
```

Cover:

- new agent: one agent, home membership, binding, member, home grant, additional
  access pairs, token, request, and receipt;
- existing unminted agent: reuse agent row and create one canonical identity;
- existing bound agent with `issue_if_missing`: return
  `agent_already_connected` and do not mint;
- explicit `add`: mint one additional token on the same member;
- explicit `replace`: revoke exactly `replaceTokenId` and insert its replacement
  in the same provisioning batch;
- same actor/request/fingerprint pending returns `in_progress`;
- same actor/request/fingerprint complete returns the non-secret receipt and
  `credential_already_issued`, never raw;
- same actor/request with a different fingerprint returns
  `request_id_conflict`;
- different actors may use the same request string;
- concurrent different request IDs for one target yield one winner and one
  `agent_setup_in_progress`;
- stale pending reservations are marked expired before a new reservation;
- a failed provisioning statement rolls back the agent/access/token/receipt
  batch and leaves a terminal failed request;
- simulated response loss after commit cannot mint on retry;
- receipt endpoint and every snippet use `PUBLIC_ORIGIN`, never request Host;
- receipt/configuration/request rows contain neither raw token nor token hash.

- [ ] **Step 2: Run the service test and verify failure**

Run:

```bash
npx vitest run tests/agent-connection-service.test.ts
```

Expected: FAIL because `src/members/agent-connection.ts` does not exist.

- [ ] **Step 3: Refactor agent creation into a prepared primitive**

In `src/org/service.ts`, preserve all current validation and entitlement checks
but split statement construction from execution:

```ts
export interface PreparedAgentCreate {
  agent: Agent
  statements: [D1PreparedStatement, D1PreparedStatement]
}

export async function prepareAgentCreate(
  env: Env,
  squadId: string,
  input: CreateAgentInput,
): Promise<CreateResult<PreparedAgentCreate>> {
  // Run the existing validation, parent lookup, entitlement check, and row
  // construction. Return the bound agents INSERT and neutral home-membership
  // INSERT without executing them.
}

export async function createAgent(
  env: Env,
  squadId: string,
  input: CreateAgentInput,
): Promise<CreateResult<Agent>> {
  const prepared = await prepareAgentCreate(env, squadId, input)
  if (!prepared.ok) return prepared
  try {
    await env.DB.batch(prepared.value.statements)
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'slug_taken' }
    throw error
  }
  return { ok: true, value: prepared.value.agent }
}
```

Run:

```bash
npx vitest run tests/agent-profile-sqlite.test.ts tests/provision-tools.test.ts
```

Expected: PASS; `create_agent` behavior is unchanged and still creates no
identity or token rows.

- [ ] **Step 4: Implement canonical normalization and reservation**

In `src/members/agent-connection.ts`, export:

```ts
export const AGENT_CONNECTION_PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_RECEIPT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_VERIFY_TTL_MS = 15 * 60 * 1000
```

Normalize by:

- trimming request ID and enforcing 1–128 characters;
- resolving existing agents ID-first;
- lowercasing and NFC-normalizing new slugs;
- sorting additional access by `squadId`;
- rejecting duplicate squad IDs and the home squad in `additionalAccess`;
- deriving `target_key` as `agent:<id>` or
  `new:<home-squad-id>:<normalized-slug>`;
- hashing canonical JSON with SHA-256.

Reservation order is exact:

1. look up only
   `(tenant, actor_kind, actor_id, request_id)`;
2. return replay/conflict state if found;
3. conditionally expire stale pending rows for the target;
4. insert the new pending request;
5. map the partial-index collision to `agent_setup_in_progress` without
   returning another actor's identifiers.

- [ ] **Step 5: Implement authorization and prepared provisioning**

Before reservation or mutation, require:

- valid pinned origin from `requiredCanonicalOrigin(env)`;
- `lead` to create on the home squad;
- `admin` to mint on the home squad;
- `admin` on each additional target squad;
- requested additional rank no higher than the caller's effective target rank;
- active existing agent and immutable data-derived home squad.

After reservation:

1. obtain `PreparedAgentCreate` or the existing agent;
2. resolve/prepare the canonical member and token according to
   `credential.action`;
3. prepare home access and every additional access pair;
4. create a random verification challenge, store only its SHA-256 hash, and
   return the plaintext challenge once with the raw token;
5. build one immutable receipt with
   `verification_status='pending'`, pinned `endpoint`, canonical access JSON,
   and no secret fields;
6. insert the receipt while the
   `agent_connection_receipt_requires_pending_request` trigger still observes
   the exact actor-scoped request as pending;
7. append a conditional request update:

```sql
UPDATE agent_connection_requests
   SET status = 'credential_issued',
       agent_id = ?1,
       member_id = ?2,
       token_id = ?3,
       receipt_id = ?4,
       updated_at = ?5,
       finalized_at = ?5
 WHERE tenant = ?6
   AND actor_kind = ?7
   AND actor_id = ?8
   AND request_id = ?9
   AND status = 'pending';
```

Execute prepared agent statements first, then member/binding, access, token,
receipt, and request transition in one D1 batch. A stale request makes the
receipt trigger raise inside the transaction and rolls back every preceding
statement. After success, assert every required insert plus exactly one request
transition before returning raw material. On failure, run a separate
conditional update from `pending` to `failed`; never mint implicitly on retry.

The successful result is:

```ts
export interface AgentConnectionIssued {
  status: 'credential_issued'
  credential: {
    raw: string
    tokenId: string
    shownOnce: true
  }
  verification: {
    receiptId: string
    challenge: string
    expiresAt: string
  }
  endpoint: string
  configuration: {
    claudeCode: string
    codex: string
    cursor: string
  }
  receipt: AgentConnectionReceipt
}
```

Replay outcomes never implement or populate `credential.raw` or
`verification.challenge`.

- [ ] **Step 6: Add the MCP tool**

Register `provision_agent_connection` in `PROVISION_TOOLS` with
`additionalProperties: false`. Accept exactly:

```ts
{
  request_id: string
  existing_agent?: string
  new_agent?: {
    home_squad: string
    slug: string
    name: string
    role?: string
    model?: string
  }
  additional_access?: Array<{
    squad: string
    capability: 'observer' | 'member' | 'lead' | 'admin'
  }>
  credential: {
    action: 'issue_if_missing' | 'add' | 'replace'
    label?: string
    home_capability?: 'observer' | 'member'
    replace_token_id?: string
  }
}
```

Require exactly one of `existing_agent` and `new_agent`. Derive
`actor.kind='member'`, `actor.id=auth.memberId`, and grants from authenticated
context. Resolve squad/agent references before calling the service. Map stable
service errors to 400/403/404/409/500 without including another actor's request
or receipt ID.

- [ ] **Step 7: Implement and schedule retention**

Export:

```ts
export async function sweepAgentConnectionRetention(
  env: Env,
  now = new Date(),
): Promise<{
  requestsExpired: number
  challengesExpired: number
  requestsPurged: number
  receiptsPurged: number
}> {
  // Use tenant-scoped conditional UPDATE/DELETE statements and the four fixed
  // retention constants. Clear challenge hashes when verification expires.
  // Catch and report failures so this sweep never rejects the cron heartbeat.
}
```

Use one D1 batch in this order:

1. `pending -> expired` where `expires_at <= now`;
2. receipt `verification_status -> expired`, challenge hash to null, and
   `updated_at=now` where verification is pending and expired;
3. purge final request rows older than the 30-day cutoff;
4. purge receipt rows older than the 365-day cutoff.

Add `ctx.waitUntil(sweepAgentConnectionRetention(env).then(() => undefined))`
to `src/index.ts#scheduled` and update the numbered heartbeat comment.

In `tests/agent-connection-service.test.ts`, inject a fixed `now` and prove each
boundary uses `<=` at expiry, does not purge a 29-day request or 364-day receipt,
and never touches another tenant.

- [ ] **Step 8: Run orchestration and surface tests**

Run:

```bash
npx vitest run \
  tests/agent-connection-service.test.ts \
  tests/agent-profile-sqlite.test.ts \
  tests/provision-tools.test.ts \
  tests/dashboard-connect.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 9: Commit**

```bash
git add src/org/service.ts src/members/agent-connection.ts src/mcp/provision.ts src/dashboard/connect.ts src/index.ts tests/agent-connection-service.test.ts tests/agent-profile-sqlite.test.ts tests/provision-tools.test.ts tests/dashboard-connect.test.ts
git commit -m "feat: provision complete agent connections"
```

---

### Task 7: Verify the foundation as one release candidate

**Files:**
- Modify only files required by failures attributable to Tasks 1–6.

**Interfaces:**
- Verifies: migrations, type contracts, compatibility tools/routes, and no unrelated regressions.

- [ ] **Step 1: Run the focused security matrix**

```bash
npx vitest run \
  tests/agent-connections-migration.test.ts \
  tests/dashboard-agent-token.test.ts \
  tests/members-capability-service.test.ts \
  tests/members-capability-sqlite.test.ts \
  tests/agent-access-service.test.ts \
  tests/dashboard-connect.test.ts \
  tests/members-sensitive-response.test.ts \
  tests/provision-tools.test.ts \
  tests/org-agent-membership.test.ts \
  tests/agent-connection-service.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run type checking**

```bash
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors; only intentional files are modified; one
reviewable commit per prior task.

If Steps 1–3 expose an in-scope defect, return to the task that owns that file,
add a failing regression test there, implement the smallest correction, rerun
that task's focused command, and then repeat Task 7 from Step 1. Do not create an
unverified catch-all correction commit and do not squash task commits before
review.

---

## Deferred Follow-on Plans

1. `verify_agent_connection`, agent-bound `tokenId` authentication context,
   loopback send/peek/cleanup, and receipt-status polling.
2. Owner wizard and receipt UI, enabled only after this foundation's
   synchronized-writer cutover is green.

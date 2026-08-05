# Database Mock Audit — mupot#685

**Purpose:** Identify all places where database mocks or hand-written fixtures could diverge from production schema, risking silent test passes against queries that would fail live.

**Status:** Initial audit. 7 high-risk tests identified. Mutation discipline examples provided. CI enforcement rules documented for Phase 2.

---

## Audit Summary

| Category | Count | Risk | Example |
|----------|-------|------|---------|
| Category A: Filtered migrations | 1+ | Medium | `agent-connections-migration.test.ts` applies only pre-target migrations |
| Category B: Full migration chain | 1 | Low | `list-agent-tokens-real-schema.test.ts` applies ALL migrations ✓ |
| Category C: Hand-written schema | 7 | High | `members-capability-sqlite.test.ts` hand-writes CREATE TABLE |
| Category D: DB mocks (canned rows) | Unknown | Critical | Any `.mock()` returning row objects bypasses SQL execution |

---

## Category A: Filtered Migration Chain (Medium Risk)

**Pattern:** Apply a subset of migrations, leaving later schema changes invisible.

**Risk:** A query can pass even if production (which runs ALL migrations) would fail because a later migration added/removed a column or changed a constraint.

### Tests

**`tests/agent-connections-migration.test.ts`**
- Applies migrations up to `0071_agent_connections.sql` only
- Hand-seeds org structure (departments, squads, agents)
- Tests agent connection request lifecycle
- **Risk:** Later migrations that modify `agents`, `member_tokens`, or related tables won't be visible here
- **Recommendation:** Add `list_agent_connections_real_schema.test.ts` with full migration chain + query regression cases

---

## Category C: Hand-Written Schema (High Risk)

**Pattern:** Use `sqlite.exec('CREATE TABLE ...')` with manually-typed columns instead of running migrations.

**Risk:** CRITICAL for security-sensitive tables. The list_agent_tokens bug (#684) happened because a hand-written test schema returned a canned row object with `capability` — but the real table has no such column. The test passed because it never ran SQL.

### Tests

#### 1. **`tests/members-capability-sqlite.test.ts`**
- **Tables:** agents, members, member_tokens, capabilities, agent_member_bindings
- **Risk Level:** CRITICAL — tests authorization logic
- **Schema Drift Risk:** 
  - Capability CHECK constraint may differ from production
  - Foreign key enforcement depends on PRAGMA setting
  - Column ordering could mask projection bugs
- **Queries tested:** upsertCapabilityGrant, resolveActiveAgentMember
- **Recommendation:** Rebase on full migration chain; add regression cases for each capability gate

#### 2. **`tests/tasks-source-pot-assignment-rbac.test.ts`**
- **Tables:** Likely capabilities, members, tasks
- **Risk Level:** HIGH — authorization gates
- **Recommendation:** Audit schema, add full-migration version

#### 3. **`tests/task-assignee-sqlite.test.ts`**
- **Risk Level:** HIGH
- **Recommendation:** Audit schema, add full-migration version

#### 4. **`tests/inbox-fence-sqlite.test.ts`**
- **Risk Level:** HIGH — fence logic is security-critical
- **Recommendation:** Audit schema, add full-migration version

#### 5. **`tests/workflow-pipeline.test.ts`**
- **Risk Level:** MEDIUM
- **Recommendation:** Audit schema

#### 6. **`tests/tasks-cross-squad-assignment.test.ts`**
- **Risk Level:** HIGH — cross-squad access is authorization-sensitive
- **Recommendation:** Audit schema, add full-migration version

#### 7. **`tests/mcp-flight-tools.test.ts`**
- **Risk Level:** HIGH — MCP tools are attack surface
- **Recommendation:** Audit schema, add full-migration version

---

## Category B: Full Migration Chain (Low Risk) ✓

**Pattern:** Apply EVERY migration in order, run actual query, assert on real schema.

### Tests

#### `tests/list-agent-tokens-real-schema.test.ts` ✓
- **Status:** GREEN — canonical pattern
- **What it does:**
  - Loads all migration files from `migrations/` directory
  - Applies them in sorted order (natural filename order)
  - Builds the EXACT schema production runs at startup
  - Executes the actual MCP tool's query: `SELECT id, member_id, label, channel, created_at, revoked_at FROM member_tokens WHERE agent_id = ?1 AND tenant = ?2 ...`
- **Mutation Testing:**
  - Includes regression case: `it('REGRESSION: the shipped query naming `capability` throws', () => { ... })` — asserts the broken query THROWS
  - Proves the test catches the bug it was written to prevent
- **Pattern for Future Queries:**
  ```typescript
  // 1. Apply all migrations
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  // 2. Test the real query
  it('query_name executes against production schema', () => {
    const query = `... actual SELECT/INSERT/UPDATE/DELETE ...`
    expect(() => harness.sqlite.prepare(query).all(...)).not.toThrow()
  })

  // 3. Regression: broken version throws
  it('REGRESSION: broken variant throws (proves test catches it)', () => {
    const broken = `... version with the bug this test prevents ...`
    expect(() => harness.sqlite.prepare(broken).all(...)).toThrow()
  })
  ```

---

## Category D: Mock Database (Critical Risk)

**Pattern:** `.mock()` returning canned row objects, never executing SQL.

**Risk:** HIGHEST. The exact scenario that shipped list_agent_tokens broken:
- Mock returns `{ id, label, created_at }`
- Real query asks for `{ id, label, capability, created_at }` (capability doesn't exist)
- Test passes (mock doesn't check column existence)
- Production fails (D1 rejects the query)

**How to find:**
```bash
grep -rE "\.mock\(|mockReturnValue|mockResolvedValue" tests --include="*.test.ts"
grep -rE "vi\.fn.*\.mock" tests --include="*.test.ts"
```

**Action:** Search and audit each result. Convert to real-schema tests.

---

## Mutation Testing Requirements (Subtask 4)

### Rule: Security Guards Must Have Recorded Red/Green Pairs

Every authorization check, validation gate, or security-critical query needs:

1. **Green case:** The correct query/guard passes
2. **Red case:** A broken variant that should fail DOES fail
3. **Both run against real schema** (not a mock)

The regression case PROVES the test catches the bug it prevents.

### Examples

#### ✓ Correct Pattern (from `list-agent-tokens-real-schema.test.ts`)

```typescript
// GREEN: correct query succeeds
it("list_agent_tokens' query executes against the real schema", () => {
  const query = `SELECT id, member_id, label, channel, created_at, revoked_at
       FROM member_tokens
      WHERE agent_id = ?1 AND tenant = ?2
      ORDER BY created_at ASC`
  expect(() => {
    harness.sqlite.prepare(query.replace(/\?\d+/g, '?')).all('agent-x', 'mumega')
  }).not.toThrow()
})

// RED: broken variant throws — proving the test catches it
it('REGRESSION: the shipped query naming `capability` throws — proving this test catches it', () => {
  const broken = `SELECT id, member_id, label, channel, capability, created_at, revoked_at
       FROM member_tokens WHERE agent_id = ? AND tenant = ?`
  expect(() => harness.sqlite.prepare(broken).all('agent-x', 'mumega')).toThrow()
})
```

**Why the regression case matters:** It proves the test actually catches the specific bug, not just "queries run without error."

#### ✗ Insufficient Pattern

```typescript
// WRONG: only tests green case
it('query succeeds', () => {
  const result = query()
  expect(result.success).toBe(true)
})

// Missing: regression case that would fail without the fix
// Missing: verification that the test catches the exact bug
```

### Security Guards (Authorization, Fencing, Validation)

Every gate needs the same pattern:

```typescript
// GREEN: correct grant passes
it('admin on squad can grant capability', () => {
  // set up: member has admin on squad
  // action: call grantCapability(...)
  // assert: grant succeeds
})

// RED: insufficient grant fails
it('REGRESSION: member without admin fails (proves gate enforces it)', () => {
  // set up: member has only 'member' level, not admin
  // action: call grantCapability(...)
  // assert: fails with 403 forbidden
})
```

---

## Action Items (by phase)

### Phase 1: This Task (Subtasks 1–4)
- [x] Land #684 production fix + real-schema test
- [x] Create this audit document
- [ ] Add mutation discipline to new security-critical tests going forward

### Phase 2: CI Enforcement (Subtask 5 — follow-up task)
- [ ] Block merge if a NEW production query has no real-schema test
- [ ] Block merge if a real-schema test lacks a regression case
- [ ] ESLint rule: warn on `CREATE TABLE` in `.test.ts` files
- [ ] ESLint rule: warn on `.mock()` applied to DB prepare/first/all methods
- [ ] Document: "All new DB queries must be tested against production schema"

### Phase 3: Backport (Later task)
- [ ] Convert Category A tests (filtered migrations) to full-migration versions
- [ ] Convert Category C tests (hand-written schemas) to migrations + real-schema
- [ ] Remove any Category D mocks (canned DB responses)
- [ ] Add regression cases to all security-sensitive queries

---

## Related Issues

- **mupot#682:** list_agent_tokens + revoke_agent_token lifecycle tools
- **mupot#684:** list_agent_tokens shipped with non-existent column; TWELVE tests passed
- **mupot#685:** "Make GREEN mean WORKING" — this task

---

## Reference: Production Schema vs. Test Schemas

**Production:** D1 applies all migrations in order on startup. Schema is the combined result of migrations 0001–009X (current).

**Real-schema test:** Replicates this exactly by running all migration files in sorted order.

**Hand-written schema test:** Author manually writes CREATE TABLE + INSERT statements. Schema diverges if:
- Migration adds a column → hand-written schema doesn't have it → test passes but production fails
- Migration adds a constraint → hand-written schema doesn't have it → test allows invalid data
- Migration drops a column → hand-written schema still has it → test references it but production doesn't
- Migration splits/merges tables → hand-written schema misses dependencies

**Filtered migration test:** Applies migrations 0001–0060 but not 0061–009X. If 0065 adds a column the query references, the test won't see it.

---

## Commit Message Guidance

When landing tests that have real-schema + regression cases, include:

```
fix(test): add real-schema test for critical_query

Tests the actual query against the production schema (all migrations applied) and includes a regression case asserting the broken variant throws. Prevents silent failures where mocked or incomplete schemas hide query errors.

Why both cases matter:
  - GREEN case: proves the correct query succeeds
  - RED case: proves the test catches the specific bug

Ref: mupot#685 (mutation discipline, security guards)
```


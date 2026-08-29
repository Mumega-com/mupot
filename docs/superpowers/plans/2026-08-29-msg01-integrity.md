# MSG-01 Immutable Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an immutable send-time message-body baseline and report verified integrity on inbox, lease, and dead-letter reads without breaking existing message semantics.

**Architecture:** Add nullable `body_length` and `body_sha256` columns for legacy compatibility plus triggers that prevent baseline mutation. Every production writer computes the baseline before insert; one shared verifier maps legacy rows to `null`, exact matches to `true`, and truncation/substitution to `false` across all read paths.

**Tech Stack:** TypeScript, Web Crypto SHA-256, D1/SQLite, message inbox/lease/dead-letter paths, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start from the merged delivery/presence descendant after Loom Slice 6 GO and reconcile the exact Athena verdict for PR #1237.
- Design-time migration path is `migrations/0136_agent_message_integrity.sql`; renumber above then-current main before editing.
- Preserve sender-scoped idempotency, target visibility, inbox fences, target seats, project attribution, push events, leases, ACKs, and dead-letter behavior.
- Never recompute and overwrite the baseline after send.
- Legacy rows with either baseline field absent return `is_intact: null`, never an inferred `true`.

---

### Task 1: Reconcile Athena's #1237 Verdict Into Testable Requirements

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/msg01-verdict-reconciliation.md`
- Read: Athena artifact named in the Mupot verdict
- Read: PR #1237 exact-head diff

**Interfaces:**
- Consumes: Athena verdict, Artifact+SHA256, and immutable PR #1237 head.
- Produces: a finding-to-test matrix with one row per GREEN condition or BLOCK finding.

- [ ] **Step 1: Verify the artifact hash and exact head**

Record the PR head, artifact path, computed SHA256, named verdict, and whether the artifact actually reviews that head. A mismatch is `UNPROVEN` and blocks code.

- [ ] **Step 2: Convert every finding into a named test case**

The matrix must include writer coverage, baseline immutability, legacy null, truncation false, same-length substitution false, inbox/lease/dead-letter parity, and all preserved message invariants.

- [ ] **Step 3: Commit the reconciliation**

```bash
git add docs/receipts/pr1236-fix-forward/msg01-verdict-reconciliation.md
git commit -m "docs(msg): reconcile Athena verdict"
```

### Task 2: Add Immutable Baseline Columns

**Files:**
- Create: `migrations/0136_agent_message_integrity.sql` (renumber above current head at execution)
- Test: `tests/agent-message-integrity-migration.test.ts`

**Interfaces:**
- Produces: nullable `agent_messages.body_length INTEGER` and `body_sha256 TEXT`, validation constraints/triggers, and update guards.

- [ ] **Step 1: Write migration invariants**

Use full migrations. Assert legacy null/null inserts succeed; length-only/hash-only fail; invalid negative length or non-lowercase/non-64-hex hash fails; setting both on insert succeeds; and later updates to body baseline fields fail.

- [ ] **Step 2: Confirm RED, implement, and verify**

The migration must not backfill old rows because current bodies cannot prove their send-time state. Add triggers preventing updates from one baseline pair to another and preventing null legacy rows from being retroactively declared intact outside an explicit future migration.

```bash
npx vitest run tests/agent-message-integrity-migration.test.ts tests/helpers-migrations.test.ts
node scripts/check-migration-numbering.mjs origin/main
git add migrations tests/agent-message-integrity-migration.test.ts
git commit -m "feat(db): add message integrity baseline"
```

### Task 3: Implement One Baseline and Verification Primitive

**Files:**
- Modify: `src/lib/crypto.ts`
- Modify: `src/agents/messages.ts`
- Test: `tests/message-integrity-core.test.ts`

**Interfaces:**
- Produces: `messageBodyBaseline(body): Promise<{ bodyLength: number; bodySha256: string }>` and `verifyMessageBody(body, storedLength, storedSha256): Promise<boolean | null>`.

- [ ] **Step 1: Write Unicode, truncation, and substitution vectors**

Use UTF-8 byte length, not JavaScript UTF-16 character count. Cover ASCII, emoji, composed/decomposed Unicode, empty body, truncated body, and same-byte-length substitution.

- [ ] **Step 2: Confirm RED and implement**

```ts
const bytes = new TextEncoder().encode(body)
return { bodyLength: bytes.byteLength, bodySha256: toHex(await crypto.subtle.digest('SHA-256', bytes)) }
```

Verification returns `null` unless both stored values exist; otherwise it compares both byte length and hash.

- [ ] **Step 3: Mutation-check and commit**

Temporarily return `true` when lengths match; same-length substitution must fail. Restore.

```bash
npx vitest run tests/message-integrity-core.test.ts
git add src/lib/crypto.ts src/agents/messages.ts tests/message-integrity-core.test.ts
git commit -m "feat(msg): verify immutable body baseline"
```

### Task 4: Cover Every Production Writer

**Files:**
- Modify: `src/agents/messages.ts`
- Modify: `src/channels/index.ts`
- Test: `tests/message-integrity-writers.test.ts`

**Interfaces:**
- Consumes: `messageBodyBaseline(body)`.
- Produces: baseline-bound inserts for both production `agent_messages` writers.

- [ ] **Step 1: Write writer enumeration tests**

Assert `sendAgentMessage` normal/idempotent paths and the central-command channel insert persist correct length/hash. Add a source guard that fails if a production `INSERT INTO agent_messages` omits both baseline columns.

- [ ] **Step 2: Confirm RED and modify inserts**

Compute the baseline before building D1 statements. Include `body_length` and `body_sha256` in both insert forms; preserve every existing idempotency and visibility predicate.

- [ ] **Step 3: Mutation-check and commit**

Temporarily remove baseline columns from `src/channels/index.ts`; the writer enumeration test must fail. Restore.

```bash
npx vitest run tests/message-integrity-writers.test.ts tests/agent-messages.test.ts tests/channel-central-command.test.ts
git add src/agents/messages.ts src/channels/index.ts tests/message-integrity-writers.test.ts
git commit -m "fix(msg): bind all production writers"
```

### Task 5: Verify Inbox, Lease, and Dead-Letter Reads

**Files:**
- Modify: `src/agents/messages.ts`
- Test: `tests/message-integrity-read-paths.test.ts`

**Interfaces:**
- Consumes: stored baseline fields on `InboxMessage`, `LeasedMessage`, and `DeadLetteredMessage` queries.
- Produces: public `is_intact: boolean | null` on all three paths.

- [ ] **Step 1: Write parity tests**

For each read path, seed four rows: legacy, intact, truncated, and same-length substituted. Assert `[null, true, false, false]` while preserving target-seat visibility, lease ownership, delivery attempts, and dead-letter reason.

- [ ] **Step 2: Confirm RED and add shared row mapping**

Select baseline fields in each query and call one mapper; do not hardcode `is_intact` or recompute a new baseline into storage.

- [ ] **Step 3: Mutation-check and commit**

Temporarily bypass verification in the lease mapper; the lease substitution test must fail. Restore.

```bash
npx vitest run tests/message-integrity-read-paths.test.ts tests/agent-inbox-lease-sqlite.test.ts tests/inbox-fence-sqlite.test.ts
git add src/agents/messages.ts tests/message-integrity-read-paths.test.ts
git commit -m "fix(msg): report read-path integrity"
```

### Task 6: Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/msg01-integrity-exact-head.md`

**Interfaces:**
- Produces: Athena-finding coverage, writer enumeration, read-path parity, mutation, full-suite, Lumen, Athena, and Loom evidence.

- [ ] **Step 1: Run focused and full gates**

```bash
npx vitest run tests/agent-message-integrity-migration.test.ts tests/message-integrity-core.test.ts tests/message-integrity-writers.test.ts tests/message-integrity-read-paths.test.ts
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Gate and stop**

Commit receipt, push, open draft PR, obtain green required checks, Lumen review, Athena exact-head Artifact+SHA256, and Loom composition. Stop for Hadi.

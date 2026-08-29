# Repository CI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every required local and GitHub repository gate on clean main without importing new product behavior from PR #1236.

**Architecture:** Repair existing contracts at their source and convert newly non-compliant tests to the canonical SQLite migration harness. Preserve guard strength; local evidence applies migrations one file at a time and validates the existing runtime workflows.

**Tech Stack:** TypeScript 5, Vitest, Node.js guard scripts, Cloudflare Wrangler/D1, SQLite test harness.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start after the MSG-01 Athena verdict and explicit Loom Slice 1 GO.
- Base the branch on then-current `origin/main`; do not cherry-pick `18c8f41e`, `0623b62f`, or `541881c8` wholesale.
- Add no token-grant, device, onboarding, router-cron, or migration `0140`–`0142` behavior.
- Do not add `@ts-ignore`, broad lint suppression, scanner exclusions, or ratchet exemptions.
- The complete suite and every repository guard must exit zero.

---

### Task 1: Pin the Reproducible Red Baseline

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/ci-foundation-baseline.md`
- Read: `package.json`
- Read: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: exact clean-main SHA and required GitHub check names.
- Produces: a command/exit manifest that later proves each original failure is cleared.

- [ ] **Step 1: Record the immutable base and failing commands**

```bash
git rev-parse HEAD
npm run typecheck
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
npx vitest run tests/wfp-dispatcher.test.ts
bash scripts/ci-local-evidence.sh
```

Expected on design-time main: typecheck `2`, no-secrets `1`, schema-source `1`, WFP two failed tests, and local-evidence nonzero. Record actual exits after refreshing main; do not copy old counts.

- [ ] **Step 2: Commit only the baseline receipt**

```bash
git add docs/receipts/pr1236-fix-forward/ci-foundation-baseline.md
git commit -m "test(ci): pin clean-main failures"
```

### Task 2: Repair Shared Type Contracts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/auth/sso.ts`
- Modify: `src/billing/stripe.ts`
- Modify: `src/connectors/supabase-webhook.ts`
- Modify: `src/routines/cron-scheduler.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/mcp/pots.ts`
- Test: `tests/type-contracts.test.ts`

**Interfaces:**
- Consumes: the runtime bindings used by billing and Supabase plus the existing `AuthContext` and MCP `ToolSpec` contracts.
- Produces: one canonical exported MCP `ToolSpec`; `Env` fields for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_WEBHOOK_SECRET`; bus event/actor unions covering the existing emitted events.

- [ ] **Step 1: Add compile-time contract witnesses**

```ts
import type { Env } from '../src/types'
import type { ToolSpec } from '../src/mcp/index'
import { POT_TOOLS } from '../src/mcp/pots'

const bindings = (env: Env) => [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.SUPABASE_WEBHOOK_SECRET]
const tools: ToolSpec[] = POT_TOOLS
void bindings
void tools
```

- [ ] **Step 2: Run typecheck and confirm the witnesses expose the current mismatches**

Run: `npm run typecheck`

Expected: nonzero with the existing Env, event actor, and `additionalProperties` incompatibilities.

- [ ] **Step 3: Centralize the contracts**

Export `ToolSpec` from `src/mcp/index.ts` or a new `src/mcp/types.ts` and import that exact type from `src/mcp/pots.ts`. Keep `inputSchema.additionalProperties: boolean` required. Extend only the runtime bindings and event/actor literals already used by production code; do not replace unions with `string`.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck
npx vitest run tests/type-contracts.test.ts tests/enterprise-sso.test.ts tests/stripe-billing.test.ts tests/supabase-connector.test.ts
git add src/types.ts src/auth/sso.ts src/billing/stripe.ts src/connectors/supabase-webhook.ts src/routines/cron-scheduler.ts src/mcp/index.ts src/mcp/pots.ts tests/type-contracts.test.ts
git commit -m "fix(types): align runtime contracts"
```

Expected: the named contract errors disappear; remaining unrelated baseline failures remain visible.

### Task 3: Repair Existing Call Sites Without Suppression

**Files:**
- Modify: `src/alerts/dispatcher.ts`
- Modify: `src/billing/routes.ts`
- Modify: `src/connectors/dashboard.ts`
- Modify: `src/dashboard/copilot.ts`
- Modify: `src/dashboard/mission-control-views.ts`
- Modify: `src/dashboard/pricing.ts`
- Modify: `src/dashboard/studio-chat.ts`
- Modify: `src/dashboard/studio-data-api.ts`
- Modify: `src/dashboard/studio.ts`
- Modify: `src/fleet/presence.ts`
- Modify: `src/mcp/supabase-tools.ts`
- Modify: `src/pots/checkout.ts`
- Modify: `src/pots/routes.ts`
- Modify: `src/pots/service.ts`
- Modify: `src/routines/actions.ts`
- Modify: `src/routines/dispatch.ts`

**Interfaces:**
- Consumes: exact production function signatures and `Project`, `PresenceView`, `SovereignPotProvisionResult`, and connector unions.
- Produces: type-correct adapters with no unused imports/parameters and no fabricated default fields.

- [ ] **Step 1: Remove dead values and fix exhaustive mappings**

Delete imports/locals proven unused by `TS6133`/`TS6196`; add the missing `supabase` connector label; use `_parameter` only when a callback contract genuinely requires an unused positional argument.

- [ ] **Step 2: Adapt callers to real signatures**

Use named adapter objects where production signatures changed. For project test/fixture objects, supply the real nullable deployment fields:

```ts
const deploymentFields = {
  repo_url: null,
  worker_name: null,
  live_url: null,
  assigned_squad_id: null,
  deploy_status: 'unconfigured' as const,
}
```

Do not cast incomplete objects with `as Project`.

- [ ] **Step 3: Make routine schedule narrowing explicit**

Construct the discriminated union by branch:

```ts
const schedule = kind === 'cron'
  ? { kind, timezone, cronExpression }
  : kind === 'once'
    ? { kind, timezone, runOnceAt }
    : { kind: 'manual' as const, timezone }
```

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck
npx vitest run tests/studio-dashboard.test.ts tests/mcp-presence-tools.test.ts tests/project-routine-lifecycle-collect.test.ts tests/pot-checkout-provisioning.test.ts
git add src tests
git commit -m "fix(ci): repair typed call sites"
```

### Task 4: Align WFP Tests With the Production Dispatcher

**Files:**
- Modify: `tests/wfp-dispatcher.test.ts`
- Read: `src/dispatcher.ts`

**Interfaces:**
- Consumes: `DispatcherEnv.DISPATCHER.get(name, args, { limits })` and the current tenant-not-found response.
- Produces: tests that assert the three-argument dispatch contract and exact public error body.

- [ ] **Step 1: Preserve the failing tests as witnesses**

Run: `npx vitest run tests/wfp-dispatcher.test.ts`

Expected: failure because the mock expects only `'viamar'` and because its expected message omits `sovereign`.

- [ ] **Step 2: Correct the assertions**

```ts
expect(mockDispatcher.get).toHaveBeenCalledWith(
  'viamar',
  {},
  { limits: { cpuMs: 50, subRequests: 50 } },
)
expect(body.message).toBe("No active sovereign mupot instance provisioned for 'unprovisioned-tenant'.")
```

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/wfp-dispatcher.test.ts
git add tests/wfp-dispatcher.test.ts
git commit -m "test(wfp): match dispatcher contract"
```

### Task 5: Remove Secret-Like Fixtures Without Weakening the Scanner

**Files:**
- Modify: the exact fixture files reported by `node scripts/no-secrets.mjs`
- Do not modify unless a scanner bug is separately proven: `scripts/no-secrets.mjs`

**Interfaces:**
- Consumes: scanner output paths and token-pattern rules.
- Produces: structurally valid synthetic fixtures assembled at runtime, never scanner allowlists.

- [ ] **Step 1: Capture scanner findings**

Run: `node scripts/no-secrets.mjs`

Expected: nonzero with exact file/line findings.

- [ ] **Step 2: Replace each literal with segmented synthetic data**

```ts
const syntheticBearer = ['synthetic', 'fixture', 'value'].join('-')
```

Keep assertions about length, hashing, and rejection behavior intact. Never add the path or value to an exclusion list.

- [ ] **Step 3: Mutation-check the scanner**

In an untracked temporary file under `tests/`, add one known scanner-shaped fake, confirm `no-secrets` exits nonzero, remove the temporary file, then confirm exit zero. Do not commit the mutation fixture.

- [ ] **Step 4: Commit**

```bash
git add tests
git commit -m "test(security): remove secret-shaped fixtures"
```

### Task 6: Shrink the Test-Schema Ratchet With Real SQLite

**Files:**
- Modify: the eight exact test files reported as new `mockDB` violations
- Modify: `scripts/test-schema-source-baseline.json` only to remove entries that are truly converted
- Read: `tests/helpers/sqlite-d1.ts`
- Read: `tests/helpers/migrations.ts`

**Interfaces:**
- Consumes: `createSqliteD1(): SqliteD1Harness` and `applyAllMigrations(sqlite): void`.
- Produces: production-code tests backed by the full committed schema.

- [ ] **Step 1: Confirm the exact eight offenders**

Run: `node scripts/check-test-schema-source.mjs`

- [ ] **Step 2: Convert each fixture**

```ts
const harness = createSqliteD1()
applyAllMigrations(harness.sqlite)
const env = { DB: harness.d1 } as Env
```

Seed rows with SQL through `harness.sqlite`; do not emulate `prepare()`, hand-write DDL, or select individual migrations.

- [ ] **Step 3: Run converted tests and ratchet**

```bash
npm test
node scripts/check-test-schema-source.mjs
```

Expected: both commands exit zero, and the baseline only shrinks.

- [ ] **Step 4: Commit**

```bash
git add tests scripts/test-schema-source-baseline.json
git commit -m "test(db): use canonical migration harness"
```

### Task 7: Repair Local D1 Migration Evidence

**Files:**
- Modify: `scripts/ci-local-evidence.sh`
- Create: `scripts/apply-local-migrations.mjs`
- Test: `tests/local-evidence-migrations.test.ts`
- Read: `migrations/0001_initial.sql` through the current migration head

**Interfaces:**
- Consumes: sorted committed migration filenames and Wrangler's per-file D1 execution.
- Produces: `applyLocalMigrations(config, persistDir)` behavior that never concatenates the migration chain into one compound SQL statement.

- [ ] **Step 1: Add a regression that exceeds SQLite's compound-select threshold**

The test creates more than 500 trivial migration files in a temporary directory and invokes the extracted migration runner. Expected: every file is applied in lexical order and the process exits zero.

- [ ] **Step 2: Confirm the old aggregate path fails**

Run: `npx vitest run tests/local-evidence-migrations.test.ts`

Expected before repair: nonzero with SQLite `too many terms in compound SELECT` or an assertion showing one aggregate invocation.

- [ ] **Step 3: Apply migrations incrementally**

Create the Node helper with this exported contract and have `ci-local-evidence.sh` invoke it with the sorted migration directory, Wrangler config, and persist directory:

```ts
export async function applyMigrationFiles(files: string[], apply: (file: string) => Promise<void>) {
  for (const file of [...files].sort()) await apply(file)
}
```

The production shell/Node path must call Wrangler once per migration file or use Wrangler's native migration command without generating a compound SELECT.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/local-evidence-migrations.test.ts
bash scripts/ci-local-evidence.sh
git add scripts/ci-local-evidence.sh scripts/apply-local-migrations.mjs tests/local-evidence-migrations.test.ts
git commit -m "fix(ci): apply local migrations incrementally"
```

### Task 8: Full Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/ci-foundation-exact-head.md`

**Interfaces:**
- Consumes: all Task 1 failures and required GitHub check names.
- Produces: exact-head evidence packet for Lumen, Athena, and Loom.

- [ ] **Step 1: Run the full local gate**

```bash
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Mutation-check load-bearing repairs**

Temporarily revert one dispatcher assertion, one scanner fixture, one schema-harness conversion, and the incremental migration loop. Each focused guard must fail. Restore the exact head and rerun the full gate.

- [ ] **Step 3: Push, open the draft PR, and request gates**

Record base/head SHAs and exits in the receipt, commit it, push, and open a draft PR. After required GitHub checks are green, request Lumen review, resolve findings, rerun evidence, then request Athena exact-head review. Stop for Loom composition and Hadi's merge decision.

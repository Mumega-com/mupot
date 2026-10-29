# Canonical board-page latency — round 2 implementation record

Spec: Kasra brief `v039-p50-retention-20261029.md` and both pinned #2272 gate receipts
at afe444c3. This is round 2 of 2 on the same builder branch.

Final design:

- Measure the actual authenticated GET /dashboard/kanban HTML page. Only a no-query
  canonical full-board load contributes; filtered variants, HEAD, the unused API and
  MCP kanban_board are explicitly out of scope.
- Run the page first and capture handler duration before any telemetry. Commit
  counter, collection onset and sample in one background D1 batch via waitUntil.
  Catch failures, never block or fail the page, and record a separate unique KV
  counter-failure marker. Coverage includes these markers; unreadable ledger means
  unknown. KV consistency and simultaneous store-loss limits are documented.
- Keep reads bounded to 20,000 latest observations. Move physical cap/cutoff pruning
  solely to the independently named maintenance slot. Include route in both cutoff
  predicates. No per-request prune. Actual page integration also corrected an
  existing SQL string literal (`archived`) exposed by strict SQLite.
- Retain default seven complete UTC days, floor 20, nearest-rank math and existing
  admin read. Pin literal retention=14 days/cap=20,000; test and mutate M1, M6/M7,
  M11, M13, window_end and actual instrumentation routing.
- Kasra verifies production's applied migration head at deployment. No credentials
  are requested or accessed by this builder.

Tests were written first for the requested regressions. Before the fixes, seven
new regression cases failed; actual-page integration also reproduced the strict SQL
literal failure. The single-background-batch test observed two batches before its fix.
The complete-window/boundary/tenant tests pin guards that previously existed but had
survived the independent lenses' mutations.

Validation commands:

```sh
npx vitest run tests/route-latency*.test.ts tests/kanban-routes.test.ts tests/maintenance-heartbeat-slots.test.ts tests/scheduled-budget.test.ts tests/schema-chain.test.ts tests/migration-d1-compat.test.ts --maxWorkers=2
node scripts/prove-route-latency-mutations.mjs
node --test tests/gen-schema-chain.test.mjs tests/check-schema-chain-fresh.test.mjs
npm run typecheck
node scripts/check-migration-numbering.mjs
node scripts/check-schema-chain-fresh.mjs
node scripts/check-test-schema-source.mjs
git diff --check
```

Operational scope and evidence limits: `docs/operations/board-latency-retention.md`.
No merge, deploy or publish. Return the new head for Kasra's pinned round-2 gate.

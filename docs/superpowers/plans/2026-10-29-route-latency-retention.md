# Authenticated board latency retention

Spec: Kasra brief `v039-p50-retention-20261029.md`.

Measure `GET /api/kanban/board`, after cookie authentication, including the durable
request count and handler through response creation. Count all admitted authenticated
executions, including handler failures. Persist the denominator before the handler;
if it fails, return 503 without executing the handler. This one extra D1 batch is the
cost of an independent denominator: a lost asynchronous sample must leave a gap.
Persist every measured latency using waitUntil (await only without a Worker context).
No identity, query, header, auth material, or request URL is retained.

Migration 0268 (main's head is 0267) adds tenant-scoped daily request counts, at most
20,000 latest samples per tenant/route, and collection-start metadata. Retention is
14 days; existing maintenance retention work also prunes during inactivity.
The admin-only read defaults to seven complete UTC days (1..13 accepted so the first
day cannot overlap the partially expired 14th day). Return n, total_requests,
coverage=n/total_requests, nearest-rank p50/p95 in ms, collection start, and window.
Percentiles are unknown below 20 samples or if the denominator is inconsistent.
Gaps and collection warmup are explicitly partial; zero requests means unknown.
The coverage denominator is durable admitted executions, not unauthenticated edge
attempts. This does not independently measure Cloudflare edge traffic.

- [x] Baseline kanban tests; write real-migration service and HTTP/auth tests first.
- [x] Observe red; implement percentile/read/write/prune helpers and migration.
- [x] Wire the existing board read and an admin metrics route; extend the existing
  retention maintenance entry without changing the maintenance slot schedule.
- [x] Mutation-prove route/tenant guards, floor, denominator, retention, cap, and auth.
- [x] Run focused Vitest with --maxWorkers=2, typecheck and repository guards to exit 0.
Delivery: own-branch PR receipt with URL/SHA/commands for Kasra's two review lenses.

Production applied migration head is inaccessible without credentials; no secret files
will be read. Recheck numbering against origin/main and flag remote-head proof for Kasra.

Verified: 112 Vitest tests in eight files, 59 Node schema-generator/guard tests,
typecheck, schema freshness, test-schema source, migration numbering, and diff checks.
All final unmutated checks exited 0. The initial service/API tests failed before their
implementation modules existed. Mutations then proved the behavioral guards with
assertion failures rather than compile/import/setup failures.

Ruling: retain the explicit synchronous denominator batch / pre-handler 503 behavior.
The independent read-only review identified this as a P1 cost to assess in Kasra's gate;
asynchronous counters would permit count and sample loss together, hiding a gap. This
build preserves the independently durable denominator and documents the availability
and latency tradeoff; it does not claim the tradeoff has passed the steward's gate.

Reproduce unmutated verification:

```sh
npx vitest run tests/route-latency.test.ts tests/route-latency-routes.test.ts tests/route-latency-maintenance.test.ts tests/kanban-routes.test.ts tests/maintenance-heartbeat-slots.test.ts tests/scheduled-budget.test.ts tests/schema-chain.test.ts tests/migration-d1-compat.test.ts --maxWorkers=2
node --test tests/gen-schema-chain.test.mjs tests/check-schema-chain-fresh.test.mjs
npm run typecheck
node scripts/check-migration-numbering.mjs
node scripts/check-schema-chain-fresh.mjs
node scripts/check-test-schema-source.mjs
git diff --check
```

# Retained canonical board-page latency

The measured surface is the authenticated **GET /dashboard/kanban** HTML page,
linked by the dashboard's own “Kanban board” navigation. Only its canonical full-board
load, with **no query string**, contributes. Filtered/query variants, HEAD, auth
refusals, the legacy `/api/kanban/board` API and MCP `kanban_board` are out of scope.
This excludes cheap `?project=bogus` responses from the distribution and sample cap.

The timer covers the page handler through response creation. It excludes auth,
network/browser time and every telemetry write. The page always runs first. Its
counter, collection onset and sample are then committed in **one off-path D1 batch**
kept alive by `waitUntil`. There is no awaited telemetry on the response path and
no telemetry-generated 503. Standalone callers without a Worker context use best-effort
background persistence too; they do not hold the page for instrumentation.

If that atomic batch fails, its missing counter is recorded separately in the existing
SESSIONS KV namespace. Each failure gets a unique opaque key, with only tenant,
fixed namespace, UTC day and random UUID, plus timestamp metadata; it expires after
14 days. There is no KV read/modify/write increment to race under concurrent failures.
The failed batch saves no sample, so its KV failure marker is a coverage gap.
Neither D1 nor KV failure changes the user's page response. Failure logs are fixed
strings and contain no request or error material.

An org admin with an existing session can read:

```text
GET /api/telemetry/board-latency?days=7
```

Windows are 1..13 **complete UTC days**, default seven, excluding the current day.
They stay wholly inside rolling 14-day retention. The read returns the fixed route,
window, `n`, `recorded_requests`, `counter_failures`, `total_requests`, `coverage`,
nearest-rank `p50_ms`/`p95_ms`, collection start and window completeness. It is
admin-only, tenant-scoped and `no-store`; route labels are not selectable.

`total_requests = persisted D1 counters + independent KV counter-failure markers`.
Coverage is `n / total_requests`. A zero or inconsistent denominator, fewer than
20 samples, or an unavailable/incomplete failure-ledger read yields unknown
percentiles. With enough samples, gaps or collection warmup yield `partial`.
`observed` requires a complete collection window, coverage exactly one and no
counter failures. It is not a latency/SLO verdict or an edge-traffic count.

The KV ledger is [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
A newly written failure can take time to appear in another location's read. The response
labels this explicitly; an unreadable, malformed, non-progressing or over-budget ledger
read is unknown, never zero failures. Reads page the scoped ledger, up to 32 pages
across the selected days. If both D1 and the independent KV write fail, only the fixed
failure log remains: complete loss of both stores cannot be reconstructed by this metric.
No claim of lossless edge accounting or live production performance is made.

Collection attempts every eligible canonical page sample. Reads are bounded to the
latest **20,000** observations, so a temporary excess already lowers read coverage.
Physical cap and 14-day cutoff deletion run **only** in the separately named
`board-latency-retention` maintenance slot. The existing cron trigger is unchanged;
there are now 19 reachable slots. The old agent-connection retention sweep keeps its
own label and outcome. Cutoff predicates include tenant AND route to use the sample
index range. Table size can temporarily exceed the cap between maintenance ticks;
there are no per-page DELETEs or cap scans.

Samples contain only an opaque UUID, tenant, fixed route, timestamp and duration.
Counters contain tenant, route, UTC-day bucket and count. Collection-start metadata
contains no request data and survives expiry. No user id, URL/query, header, cookie,
token, SQL text or error content is stored.

Migration `0268_route_latency_retention.sql` is additive and the generated schema
bundle contains its current page-label CHECK constraints. Kasra owns production
migration-head verification, migration application, review and deployment; the builder
needs no production credentials and makes no production mutation.

Local integration tests load the actual cookie-authenticated HTML page, run its
background writes and perform the seven-day metric read with nonzero n and numeric
p50/p95. Synthetic fixture dates do not imply existing production history. On a new
deployment there is no retroactive data; the first complete-day window starts filling
after UTC rollover. The suite also pins coverage with a complete window, cross-tenant
collection onset, cross-tenant admin rejection, equality at the warmup boundary,
exclusive window_end, 14-day retention and the 20,000 cap as literals.

```sh
node scripts/prove-route-latency-mutations.mjs
```

The prover requires assertion failures (not import/setup/compiler failures), restores
source byte-for-byte, and requires the restored suite to exit 0. Gate-surviving
mutants are explicitly named M1, M6/M7, M11 and M13; retention=30 days and cap=200,000
are separate mutations.

Round-2 verification: 125 Vitest tests across nine files and 59 Node schema tests
passed, with completed processes exiting 0. All 35 mutations produced assertion
failures; the prover restored source and exited 0. Typecheck, migration numbering,
schema freshness, test-schema-source and diff checks also exited 0. These are local
build/test receipts, not a gate verdict, deployment or live seven-day measurement.

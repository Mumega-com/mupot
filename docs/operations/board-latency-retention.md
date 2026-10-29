# Retained authenticated board latency

The measured route is **GET /api/kanban/board**. Every cookie-authenticated GET
admitted to its handler is counted; HEAD and authentication refusals are excluded.
Timing begins after authentication and includes the durable counter batch and board
handler through response creation. Handler failures are counted and sampled too.
This measures server response preparation, not browser/network time or auth latency.

An org admin with an existing dashboard session can read:

```text
GET /api/telemetry/board-latency?days=7
```

The default is seven **complete UTC days**, excluding the current day. Accepted
windows are 1..13 days, keeping every requested day within rolling 14-day retention.
The response names the route, UTC window, `n`, `total_requests`, `coverage`,
`p50_ms`, `p95_ms`, `recording_since`, and `window_complete`. It is not cached.
Only org admins can read this pot-wide aggregate; route labels are not selectable.

Coverage is `n / total_requests`, where the denominator is durably admitted
authenticated handler executions. It is not a Cloudflare edge request count.
Zero requests or inconsistent counts produce null coverage. Below **20 samples**,
percentiles are null and status is `unknown`; otherwise nearest-rank percentiles
describe the retained observations. Missing samples or collection warmup produce
`partial`. `observed` means the requested collection window and counts agree;
it is not a performance/SLO verdict. A new deployment cannot claim seven days of
history immediately. Missing or unreadable tables return 503/unknown.

Collection attempts **all** samples, retaining the latest **20,000** per tenant and
fixed route, with a 14-day time limit. Cap eviction leaves request counts intact,
so coverage falls rather than presenting a truncated distribution as complete.
Samples contain only an opaque random id, tenant, fixed route, timestamp and
duration. Daily counters hold only tenant, route, bucket and count. No request
URL, query, user id, header, cookie, token, SQL text or error content is stored.
Collection-start metadata has no request data and survives sample expiry.

Samples and expired data are written/pruned in one off-path D1 batch under
`waitUntil`; non-Worker callers await it. Cleanup also runs on the existing
agent-connection-retention maintenance heartbeat during inactivity, without adding
a cron trigger or changing slot order. Reads exclude expired windows even between
maintenance ticks. Physical deletion during inactivity follows that heartbeat's cadence.
The heartbeat awaits both independent sweeps to settle before reporting a failure,
so one rejected sweep cannot release `waitUntil` while the other is still running.

There is an intentional availability/performance cost: an independent denominator
requires **one additional awaited D1 batch** before executing the handler. It holds
collection-start insertion, a counter increment and expired-counter cleanup. If it
fails, the board returns 503 before doing uncounted work. A failed async sample
cannot erase its durable count. A whole Worker/edge failure before admission is
outside this metric. The bounded sample-cap scan also consumes off-path D1 work.
Kasra should assess this tradeoff in the two-lens gate; no production latency or
availability claim has been made from local tests.

Apply migration `0268_route_latency_retention.sql` before deploying the code. The
generated schema bundle includes it for new pots. The origin/main numbering guard
was checked; production's applied head remains UNPROVEN because this builder did
not access secret files or production D1 credentials. Kasra must verify the applied
head before landing/deployment. No deployment or live seven-day collection is included.
Resolving that UNPROVEN item requires an authenticated D1 migration-list receipt naming
the highest applied file below 0268; otherwise renumber and regenerate before landing.

Local proof includes fixed-distribution math, sample gaps, floor, warmup, tenant/admin
isolation, injection-safe labels, strict request/sample retention, sample cap, handler
failures, real dashboard mounting and the real scheduled deletion path. The mutation
runner temporarily changes source in a review worktree, requires assertion failures,
restores it, and requires the restored suite to exit 0:

```sh
node scripts/prove-route-latency-mutations.mjs
```

All 22 mutations were killed (19 core guards, maintenance wiring, dashboard mounting,
and cleanup failure isolation). Mutants exited 1 with assertion failures; restored
suites and runners exited 0.

# PostHog Architecture — Lessons for the mupot Substrate

> Grounded research (kasra-research, 2026-06-16). All mechanisms verified against current PostHog source/docs, not training data.
> Feeds [substrate-contract.md](./substrate-contract.md). PostHog is both a teacher here and a brick we wire (#14 + the marketing squad).

## A. Sandboxed user code — HogVM
PostHog evolved: arbitrary Python plugins → Node `vm2` (Node's own docs: "do not use for untrusted code") → **HogVM**, a stack-based bytecode VM with hard limits baked in: 64MB memory ceiling (per-op cost tracking), 5s CPU timeout (checked every 128 ops), 1000-frame call stack, **no direct network in transformations** (`fetch` lives only in destinations, via a separate fetch service — the VM never opens a socket), `validate_bytecode()` pre-deploy.

**Lesson → mupot:** don't `eval` tenant code; run overlays as **child Workers** (dispatch namespace + service binding) with explicit `cpu_ms`/128MB limits; route all network through a **sealed parent proxy** (`env.NETWORK_PORT.fetch`) with per-tenant allowlists; `validate_overlay()` pre-activation. **ADOPT the metering pattern; ADAPT to CF dispatch namespaces instead of a custom VM; the separate-fetch-service pattern is mandatory.**

## B. Extension-surface versioning — the trap
PostHog's `plugin.json` tracked `posthogVersion` (the HOST), never a plugin-API version. plugins→CDP was a **clean break** with per-plugin hand-migration — survivable only because PostHog owned the whole catalog.

**Lesson → mupot:** we do NOT own the overlay catalog (tenants write their own). Declare **`mupotPortVersion: "1"`** in the child manifest now; additive changes safe; breaking changes bump version + ship a parent **migration shim** (cheap — we stay in JS/TS, unlike PostHog's language change). **AVOID PostHog's no-versioning. Cost now = zero; cost later = a migration sprint touching every tenant.**

## C. Composable products — vertical slices, no runtime gate
PostHog = hybrid monolith; products as `products/` vertical slices sharing one Django process + Postgres + ClickHouse. Product toggling is billing-plan/SDK flags, **not runtime isolation**; cross-product data sharing is implicit (shared event tables).

**Lesson → mupot:** ADOPT vertical-slice organization per port. ADAPT the billing-gate as the **per-tier port-availability gate** (lower tier → parent never provisions that port's binding). Do NOT replicate shared storage — **per-tenant D1/KV by construction**, never shared tables with `tenant_id`.

## D. Self-host + cloud duality — parity drift
Same Docker images; what diverged: paid features cloud-first/-only, Helm support dropped (2023), self-host = "hobby tier", brutal resource floor (Kafka+ClickHouse+ZooKeeper ~1.5GB idle, 8GB+ min), `SECRET_KEY` ships with a default, hardcoded k8s URLs break docker-compose.

**Lesson → mupot:** ADOPT same-core for managed-mumega + sovereign-fork. AVOID cloud-only drift — **feature parity as a parent-manifest invariant**. Generate random `POT_SECRET` at init (fail-loud on default); no hardcoded URLs (CF bindings are name-resolved). CF-native sidesteps the resource floor entirely.

## E. Ingestion / pub-sub — Kafka→ClickHouse
Rust capture → Kafka (primary + **overflow topic** for backpressure + historical) → CDP worker → Kafka → ClickHouse **pulls** via Kafka engine. At-least-once + eventual dedup (ReplacingMergeTree). Swapping Kafka is hard (they built Millpond just to reroute one path).

**Lesson → mupot:** AVOID Kafka/ClickHouse on CF. ADOPT the **overflow + dead-letter queue** pattern (CF Queues, day one — one bad overlay can't stall ingestion) and **pull-based consumers** (D1 analytics consumer pulls from Queues on its own schedule). Design for at-least-once + idempotency keys. **Seal the pub/sub port now** (`publish`/`subscribe`) — never leak queue/topic names into business logic.

## CF-native flags (PostHog choices to AVOID on CF)
| PostHog | Why it breaks on CF | mupot alternative |
|---|---|---|
| Kafka + ZooKeeper | stateful, heavy floor | CF Queues |
| ClickHouse | not on CF | D1 + Vectorize |
| Node `vm2` sandbox | not a real boundary | dispatch namespaces + service bindings |
| shared ClickHouse across tenants | cross-tenant adjacency | per-tenant D1/KV |
| docker-compose single-host | SPOF | CF multi-region implicit |
| hardcoded k8s URLs | breaks off-k8s | CF service bindings |

## Top 3 to steal
1. **VM-metering at the boundary** → child-Worker isolation + explicit limits + `validate_overlay()`.
2. **Separate fetch service** → overlays never hold raw `fetch`; call `env.NETWORK_PORT.fetch` (allowlisted).
3. **Overflow queue** → backpressure isolation from day one.

## Top 1 trap
**No API versioning until too late.** Define `mupotPortVersion: "1"` before the first overlay ships; migration shims in the parent on every breaking bump.

## Sources
HogVM execute.py · PostHog Hog docs · CDP transformations · app-server history blog · plugin-scaffold types.ts · CDP megaissue #22833 · migration PR #24366 · how-posthog-works · ingestion-pipeline · ClickHouse docs · Millpond · self-host docs + disclaimer · Helm sunset blog · DeepWiki PostHog. (Full URLs in bus memory `sos:posthog-mupot-research`.)

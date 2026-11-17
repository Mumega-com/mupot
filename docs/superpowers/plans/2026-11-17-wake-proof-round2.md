# Wake proof round-two implementation plan

> For agentic workers: use superpowers:executing-plans for the reader/observer work. Copy-only work has disjoint ownership; the builder does not gate, merge or deploy.

**Goal:** Close the two reproduced P1s on PR #2442 and the explicitly requested cheap fixes, with one round-two push.

**Architecture:** Share the active-challenge predicate between folded peeks and witness writes. Use the canonical agent-member actor and the existing actor/time index to restrict candidates to the ten-minute challenge window. Non-folded reads use a shared idempotent pre/post witness boundary; folded peeks retain their read-snapshot timestamp. Clamp an overlapping read's witness to challenge creation so a challenge that appeared during a read cannot escape the proof fence.

**Tech stack:** TypeScript, Workers D1/SQLite, Vitest with the real migration chain.

**Spec:** Task 7a7cc34a; rejected head 225e6799; Kasra request kasra-2442-r2-fixlist. Reports are agents/kasra/receipts/gate-2442-{adversarial,lens}-225e6799.md on the local mumega.com branch servathadi/kasra-steward-20261109.

## Constraints

- Keep the same draft PR and branch; one new pushed head after local verification.
- No migration, flag, credential, dispatch-policy, merge or deployment changes.
- Idle SSE stays one statement, active challenge two, expired challenge one.
- Bound audit rows by the ten-minute creation window using an existing index; never hide an active challenge behind a row-count LIMIT.
- Preserve tenant/agent/canonical-member confinement and fail closed before exposing a nonce if its witness cannot persist.
- Do not address the visibility, per-seat proof, fleet-write cost, changes-feed or fleet fallback follow-ups.

## Review focus

- Challenge creation between a pre-witness and consume, signed read or lease.
- Delivery between a folded peek snapshot and witness persistence.
- Empty/fenced reads, statement failure, exact expiry and overlapping creation timestamps.
- Deep old audit history and dense recent rows preceding an active challenge.
- A stale attachment's ID/agent and a native credential's exact agent weld.

## Tasks

1. Add failing real-SQLite interleaving regressions in tests/agent-wake-echo.test.ts for consume, signed peek/consume, lease and attempt-lease; assert nonce returned, then echo_roundtrip rather than wake_proven. Add a folded-read timestamp regression and an inactive-snapshot control.
2. Add an EXPLAIN regression on actual folded/observer queries in tests/inbox-stream-poll-cost.test.ts with deep old history and dense recent history. Require an actor/time index range, not an unbounded agent/seq scan.
3. Implement the shared bounded predicate and pre/post witness operation in src/agents/wake-echo-observer.ts; use it from src/agents/messages.ts. Store challenge issue created_at from its logical creation time in src/members/wake-echo.ts. Re-run the regressions after each fix.
4. Pin the observer expiry and stale attachment/agent guards with meaningful fixtures and failing mutations. Rename the doorbell test to state its unproven outcome.
5. Update only the requested connection_check annotation and short dashboard proof copy. Run their existing suites.
6. Run all affected regressions and typecheck/schema/refusal guards; refresh the mutation table against the final source. Commit locally, push one new head, wait for CI green, and submit exact-head evidence to Kasra. The separate gates decide the verdict.

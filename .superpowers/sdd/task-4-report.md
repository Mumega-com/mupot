# Task 4 Report: Durable Marketing Monitor Runs

Plan: `docs/superpowers/plans/2026-07-16-marketing-cro-monitor-v1.md`

Commit range: `56ad535001a6c803fdb0ba26c96570a8324a9f65..c33841ba66387f537e88e5607341a73b2a41f756`

## Delivered

- Added tenant-, installation-, binding-generation-, and window-scoped monitor runs.
- Persisted runs, sources, and observations in one D1 batch with a private `building` state and guarded `completed` finalization.
- Made completed evidence append-only and excluded incomplete rows from all read APIs.
- Added exact-window idempotency for concurrent/repeated monitor requests.
- Added owner/admin POST, latest, and bounded list routes with strict input parsing and redacted responses.
- Added collector-derived source attribution, canonical evidence digests, exact stored outcome re-derivation, and fail-closed stored-row parsing.
- Preserved Task 3 provenance under mutable source code by pinning the verification environment and capturing serialization/encoding intrinsics.
- Enforced canonical source contracts, 31-day windows, 256-character observation IDs, and available-source attribution in service and D1 boundaries.

## Review

Independent review found and the implementation closed:

1. Fabricated stored outcomes and digests could pass shape-only validation.
2. Observation IDs were not bounded before serialization and hashing.
3. Mutable serialization, encoding, and array intrinsics could detach a digest from returned evidence.
4. The source factory ran before the collector pinned its verification environment.
5. Stored windows and source provenance were weaker than the Task 3 contracts.

Final independent review: `APPROVED` with no actionable findings.

## Verification

- Fresh local focused verification: 4 files, 166 tests passed.
- Independent focused verification: 187 tests passed.
- Independent full regression: 207 files, 3,448 tests passed.
- `npm run typecheck`: passed.
- `git diff --check`: clean.

## Residual Gap

Concurrent batch behavior is covered by the SQLite D1 harness. A deployed Cloudflare D1 concurrency check remains part of the Task 8 lifecycle and Mumega pilot receipt.

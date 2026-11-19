# Expired-admission lockout delta — 2026-11-16

Builder: Athena. Parent task78776453-d52b-4b78-a500-2874efb6c3f4; only P2-A plus M30/M43 is active. Base9aed8b036cd8a3f1b844e5776f419f7a74133393 (#2430 squash). New branch athena/expired-admission-lockout-20261116. The merged branch is untouched.

## Repair and proof

Three readers now use the existing shared absolute-expiry predicate: elevation origin liveness, a non-owner's claimed-agent wake card, and claim-link already_claimed classification. The exact-seat attachment lookup first revokes elapsed live approvals occupying that seat, using the existing legal transition and detach/token-revoke trigger. Asking for B can no longer leave expired A blocking the seat; the stale approval is cleaned up instead of leaving a hidden Revoke-only recovery path.

Before production changes, four regressions failed: A-expired to B fresh ask, elevation origin, wake card and claim link. M30 agent-page invalid-duration HTTP400 and M43 zero-row decision-insert rollback passed as controls. The corrected fixture explicitly designates B before proving the lockout; failures were not a missing-designation artifact.

Four PR suites passed340 tests, typecheck exited0. Six fault mutations were caught and source restored: elevation expiry, wake expiry, claim expiry, exact-seat cleanup, agent-page400 mapping and Move decision-row audit fence. Sibling JSON records mutations/assertions/source hashes. Real SQLite D1 and complete migration chain; no SQL-string mocks. Final restored verification is recorded in the builder handoff.

## Limits

The scope is the fresh-ask lockout and four readers, not a new automatic attach retry. A direct B claim whose guarded attach insert loses to an expired A can still report attached:false/guard_refused and require a subsequent seat_attach; it is not falsely reported fully attached. Bounded review identified this edge, which is retained and explicitly disclosed rather than widening the write path.

The parent task's remaining audit row, move notice, flash readback, other mutants and expiry-cap CHECK criteria are NOT completed by this delta. They remain held. No migration,0275, permission change, grant, merge or deployment. Kasra and a fresh Opus lens must independently gate the new exact head; builder cannot clear it.

Restored verification completed across disjoint short groups after longer runs received SIGTERM: seat-attach dashboard60 + its complementary182 =242, plus the other three suites98 = **340 passed**, four unique suites. These selection skips are complementary, not omitted coverage. Typecheck exit0. No uninterrupted post-mutation full-run claim is made.

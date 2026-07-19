# Marketing Monitor Intrinsic-Poison Worker Flake

## Scope

- Base investigated: `2955018ff70907ffabc255d4a14871cf297d81b2`.
- Production contract inspected: `src/addons/marketing/service.ts` captures the relevant constructors and methods at module load and uses them for canonical persistence and digest construction.
- Historical change inspected: `c33841ba66387f537e88e5607341a73b2a41f756` introduced the intrinsic-poisoning test and the captured-intrinsic production hardening.
- No production files were changed.

## Root Cause

The test added in `c33841b` replaced process-wide `TextEncoder.prototype.encode`, `Object.prototype.toJSON`, and `Array.prototype.map`/`filter`/`some` with unconditional throwers in its injected source factory. They remained installed through several `await` boundaries until `runMarketingMonitor` resolved.

Vitest and Vite share those intrinsics in the worker. A one-time diagnostic showed `Array.prototype.map` being called by Vite's `DecodedMap` source-map handling while the test poison was active. That call threw `poisoned map` outside the test's control flow, which explains the reported unhandled worker error. Whether the worker touches those methods during the poison window is scheduler-dependent, so the failure is nondeterministic and the test passes in isolation.

## Fix

The unconditional intrinsic poisoning now runs in a dedicated child process rather than the Vitest worker. The child uses Vite only to load the fixture and production modules before poisoning begins, so the marketing modules capture the real intrinsics exactly as production does. The injected source factory then replaces `TextEncoder.prototype.encode`, `Object.prototype.toJSON`, and `Array.prototype.map`/`filter`/`some` unconditionally until collection, normalization, outcomes, digest construction, JSON persistence, the D1 batch, and stored-row validation complete.

The child fixture directly proves that the poison is active for:

- The raw `SourceObservation[]` before `sourceKey` injection via `map`, `filter`, and `some`.
- `TextEncoder.encode` on fixture input.
- `Object.prototype.toJSON` on an outcome-shaped object.

Because the poison is unconditional in the child, normalized observations, derived outcomes, evidence digest construction, and all persistence JSON remain covered without shape predicates or production instrumentation. Any regression to a live intrinsic on those paths fails the child run.

The Vitest worker installs no wrappers. Deterministic assertions map a cyclic array and an array containing a throwing proxy while verifying that the proxy receives zero property reads. This proves unrelated worker values retain native behavior with no recursive scan, getter/proxy access, cycle risk, or depth risk.

## Verification

- RED against `cb3f704`: cyclic/proxy delegation plus raw-observation and outcome-poison assertions deterministically caused the monitor test to return `collection_failed` under the recursive scoped predicate.
- `npx vitest run tests/marketing-monitor-service.test.ts --reporter=dot`: passed 15 consecutive fresh runs, 51 tests each, 765 total tests.
- `npm test`: passed, 229 test files and 3,794 tests; no worker errors.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Concerns

None.

# Response: Marketing Monitor Intrinsic-Poison Worker Flake Review

## Important 1: Recursive inspection of unrelated worker values

Resolved by removing the process-wide wrappers from the Vitest worker entirely. The worker now delegates all values directly to native intrinsics because the hostile test executes in a dedicated child process.

The regression test exercises a self-referential array and an array containing a throwing proxy before invoking the child. Both map normally, and the proxy records zero property reads. There is no recursive predicate, shape traversal, depth handling, or accessor evaluation in the worker.

## Important 2: Missing raw observation and derived outcome coverage

Resolved by restoring unconditional poisoning inside the isolated child. The fixture loads production first, then the untrusted source factory poisons `map`, `filter`, `some`, `TextEncoder.prototype.encode`, and `Object.prototype.toJSON` for the complete asynchronous monitor run.

Direct checks prove the raw `SourceObservation[]` is poisoned before normalization and that an outcome-shaped object observes the hostile `toJSON`. The successful monitor result and independently recomputed digest prove production continues to use captured intrinsics through normalized evidence, outcome derivation, digest construction, JSON persistence, batch execution, and stored-row validation. Because the poison is unconditional, no fixture-derived shape is selected or omitted by the harness.

## Verification

- RED against `cb3f704`: the added cyclic/proxy, raw-observation, and outcome assertions failed with `collection_failed` under the recursive scoped predicate.
- Focused file: 15 consecutive runs passed, 51 tests per run, 765 total.
- Full suite: 229 files and 3,794 tests passed; no worker errors.
- Typecheck passed.
- Diff check passed.

## Production Scope

No production files changed.

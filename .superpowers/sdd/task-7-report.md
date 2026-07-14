# Task 7 Report: Service-Aware Host-Go and Receipt Bundles

## Result

Implemented Task 7 on `codex/macos-launchd-installer` from base commit
`0d98cfe1a120b84ee88e9dfdbb5306779ba9df68`.

Host-Go now optionally requires live service status, current on-disk definition
hashes, exact node/runtime/config execution arguments, and systemd linger.
Receipt bundles now have a conditional `starter-ready` mode that carries and
verifies singular service, continuous-runtime, and starter receipts while the
flag-free SOS cutover mode remains unchanged.

## Red/Green Chronology

1. Baseline focused run before edits:
   `node --test fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
   passed 37/37 tests.
2. Added host service-required tests first. The host-only RED run discovered 18
   tests: 6 passed and 12 failed for the missing service checks and CLI flags.
3. Added starter-ready bundle, copied-export, compact-status, and fail-closed
   parser/manifest tests. The combined RED run discovered 58 tests: 37 passed
   and 21 failed for the unimplemented Task 7 behavior.
4. Implemented the host slice. The first host run passed 17/18; the remaining
   failure was a test harness error caused by passing a `file:` URL to Node.
   Converted the URL with `fileURLToPath`, then the host suite passed 18/18.
5. Implemented the bundle slice through the existing artifact copy, manifest,
   export, SHA-256, directory-scope, and secret-scanner paths. The bundle suite
   passed 40/40.
6. Re-ran the combined focused suite; it passed 58/58.
7. Ran all fleet-runtime tests; they passed 337/337.
8. Ran the repository Vitest suite; 168/168 files and 2703/2703 tests passed.

## Verification

- `node --test fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 58 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 337 passed, 0 failed.
- `npm test`
  - 168 test files passed; 2703 tests passed.
- `git diff --check`
  - Passed with no whitespace errors.

## Self-Review

- Confirmed all pre-existing host fixtures pass without `requireServices` and
  all pre-existing SOS cutover tests pass without starter flags.
- Confirmed required service failures cover missing definitions, hash drift,
  unloaded/stopped services, wrong node/runtime/config argv, and disabled
  systemd linger.
- Confirmed the normalized service checks are exactly
  `service_definitions_current`, `heartbeat_service_running`,
  `control_service_running`, and `systemd_linger_enabled`.
- Confirmed starter-ready mode requires one exact-type, status-pass receipt for
  each new role and uses the existing secret scanner for source and copied
  artifacts.
- Confirmed copied verification succeeds after deleting both the source bundle
  and the original receipt directory; exported manifest and sidecars contain no
  source-directory dependency.
- Confirmed parser and manifest checks reject contradictory read-only modes,
  duplicate role inputs/paths, drifted hashes, and fabricated mode metadata.
- Confirmed compact status reports service manager, definition hashes,
  heartbeat/control deltas, and starter manifest digest.
- Confirmed no files outside the five user-owned paths were changed.

## Changed Files

- `fleet-runtime/host-receipt.mjs`
- `fleet-runtime/host-receipt.test.mjs`
- `fleet-runtime/receipt-bundle.mjs`
- `fleet-runtime/receipt-bundle.test.mjs`
- `.superpowers/sdd/task-7-report.md`

## Concerns

No blocking concerns. Task 8 remains responsible for producing the starter
receipt; Task 7 consumes its approved v1 type and portable manifest digest.
`npm test` emitted the repository's existing Node experimental SQLite warnings,
with no test failures.

---

## Independent Review Remediation

### Result

Resolved every Critical and Important finding from the Task 7 independent
review in one TDD wave. Host-Go now derives service truth from freshly rendered
definitions, on-disk definitions, and a strictly validated live-service
receipt. Starter-ready bundles now validate and cross-bind the complete service,
continuous-runtime, starter, and Host-Go contracts, export portable normalized
evidence, enforce exact schemas and next-step policy, and repair restrictive
permissions on creation and force overwrite. Flag-free legacy behavior remains
byte/shape compatible at the JSON contract level.

### Red/Green Chronology

1. Re-ran the pre-remediation focused baseline. The existing 58/58 tests passed.
2. Added host regressions before implementation for independent launchd and
   systemd rendering, semantic definition drift with preserved argv, exact
   service envelopes, adversarial fields, duplicate/extra services, wrong
   manager/platform, malformed option values, flag conflicts, and legacy input
   shape. The host RED run discovered 28 tests: 18 passed and 10 failed.
3. Implemented strict host CLI validation, independent renderer/disk/receipt
   hash agreement, structural command validation, exact service receipt schema
   validation, canonical secret scanning, and normalized four-check output. The
   host suite then passed 28/28.
4. Added bundle regressions before implementation using producer-realistic
   receipts for deep contract validation, cross-binding, invalid deltas,
   duplicates, unknown fields, mode tampering, closed next steps, portable
   copied evidence, deleted-source verification, malformed schemas, legacy
   shape, and permission drift. The bundle RED run discovered 59 tests: 39
   passed and 20 failed.
5. Implemented the normalized starter evidence pipeline, exact service,
   continuous-runtime, starter, and host validators, portable projections and
   support files, fail-closed manifest/sidecar schemas, exact next-step policy,
   pre-side-effect CLI validation, and 0700/0600 permission enforcement. The
   focused suite passed 87/87.
6. A compatibility self-review found that new validation check records had
   leaked into flag-free SOS output. Added deep legacy assertions, folded the
   legacy enforcement into existing booleans, and kept the new records strictly
   starter-only. The focused suite remained green at 87/87.
7. Re-ran all required verification from the final tree: focused tests passed
   87/87, all fleet-runtime tests passed 366/366, and the repository test suite
   passed 168/168 files and 2703/2703 tests.

### Verification

- `node --test fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 87 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 366 passed, 0 failed.
- `npm test`
  - 168 test files passed; 2703 tests passed.
- `git diff --check`
  - Passed with no whitespace errors.

### Self-Review

- Host-Go fresh-renders current launchd/systemd definitions and requires exact
  renderer, disk, and validated receipt hash agreement; argv and surrounding
  service semantics are validated structurally.
- Service receipts fail closed on envelope, manager/platform, definitions,
  services, processes, commands, checks, next steps, unknown fields, and
  canonical secret patterns while preserving exactly four normalized checks.
- Starter-ready mode deeply validates and cross-binds all four producer
  contracts, and compact status is derived only from normalized evidence.
- CLI role/value/mode conflicts are rejected before output directory creation
  or mutation.
- Copied evidence uses relative references and survives deletion of the source
  receipts and source bundle; recursive tests reject retained source prefixes.
- Manifest and sidecar schemas reject unknown roles, malformed collections,
  duplicate artifacts, extra/missing files, mode drift, fabricated summaries,
  and unknown metadata without throwing.
- Bundle/export directories are verified at 0700 and JSON/support files at
  0600, including permissive existing inodes replaced through `--force`.
- Exact ordered next-step policies are enforced for each mode and status.
- Legacy Host-Go inputs and SOS-only receipt/check/status/manifest/export
  contracts have snapshot-style shape assertions and do not gain Task 7 fields,
  checks, counts, paths, or next steps.

### Changed Files

- `fleet-runtime/host-receipt.mjs`
- `fleet-runtime/host-receipt.test.mjs`
- `fleet-runtime/receipt-bundle.mjs`
- `fleet-runtime/receipt-bundle.test.mjs`
- `.superpowers/sdd/task-7-report.md` (append-only)

### Concerns

No blocking concerns. The starter validator intentionally implements the
anticipated Task 8 v1 producer contract supplied with this task; Task 8 must
emit that exact contract. `npm test` continues to emit the repository's existing
Node experimental SQLite warnings, with no failures.

---

## Task 7 Recovery: Portable Starter Evidence

### Result

Recovered the interrupted Task 7 remediation while preserving the shared
starter contract and typed projection/provenance chain. Manifest verification
again exposes the legacy hash-drift and self-contained-bundle checks, legacy
export remains compatible with working files beside the source bundle, and
portable export sidecars fail closed on unknown nested copied-entry, sidecar,
summary, and check-record fields.

Runtime artifact validation now accepts the two explicit supported contracts:
the current producer envelope and the compact pre-Task-7 legacy envelope. Both
paths require exact nested keys, so fabricated runtime target fields fail the
`artifact_receipt_schema_exact` check. Force re-export skips stale sidecars only
during the pre-write manifest check, then validates both regenerated sidecars
with the full recursive schema.

### Verification

- `node --test fleet-runtime/starter-contract.test.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 135 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 414 passed, 0 failed.
- `npm test`
  - 168 test files passed; 2703 tests passed.
- `git diff --check`
  - Passed with no whitespace errors.

### Implementation Summary

- Restored checker-derived readiness in `addNextStepChecks`, preserving legacy
  `next_steps_no_attach_when_not_ready` and `next_steps_hold_when_not_ready`
  drift reporting.
- Restored read-only legacy external artifact reporting in
  `resolveArtifactPath` while keeping starter-ready artifacts contained.
- Kept legacy export ungated by source-directory extras; starter-ready export
  still requires a passing source manifest check.
- Added exact runtime check/envelope validation and explicit current/legacy
  runtime contract branches.
- Added recursive typed validation for export copied records, sidecar records,
  summaries, manifest references, secret findings, and checker records.
- Preserved final portable projection/provenance digest and sidecar validation;
  only the force-repair pre-write check ignores stale sidecars.

### Concerns

No residual blocking concern. `npm test` emits the repository's existing Node
experimental SQLite warnings, with no test failures.

---

## Task 7 Final Provenance Correction

### Result

Portable starter exports now retain an exact immutable preimage for every
projected receipt, manifest, and service definition under a contained
`provenance/<role>/` directory. Export rejects secret-bearing preimages instead
of rewriting them. Projection wrappers bind the retained relative path and
source digest, and the checker independently rebuilds every typed projection
and the outer manifest from retained bytes after the original source tree has
been deleted.

Portability applies to filesystem references: every manifest and wrapper path
is contained and relative. Immutable secret-free preimages preserve original
machine observations verbatim but are never used as live filesystem inputs.

### Verification

- `node --test fleet-runtime/starter-contract.test.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 153 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 432 passed, 0 failed.
- `npm test`
  - 168 test files passed; 2703 tests passed.
- `git diff --check`
  - Passed with no whitespace errors.

### Adversarial Coverage

- Direct retained-preimage tampering fails source digest and derivation checks.
- Coordinated edits to retained bytes plus copied source digest fields still
  fail deterministic projection derivation.
- Symlinked preimages and permissive provenance directories fail closed.
- Provenance directories are exact, contained, mode `0700`; retained files are
  regular, mode `0600`, source-digest bound, and secret scanned.

### Concerns

No blocking concern. SHA-256 proves bundle integrity and deterministic
derivation, not publisher authenticity; signed provenance is intentionally
outside this task. `npm test` retains the existing experimental SQLite warning.

---

## Task 7 Cumulative-Review Remediation

### Result

The cumulative review package now accepts the actual launchd and systemd
Host-Go producer contracts, including repeated per-agent key/probe checks,
optional exec-probe checks, and the launchd
`host-services:systemd_linger_enabled` record with `applicable: false`.
Starter readiness requires recomputed passing install, runtime, lifecycle,
probe, cutover, and prior-bundle evidence. Top-level status is bound to the
exact recomputed summary, malformed collections fail closed, and non-string
`next_steps` cannot be filtered into an accepted policy.

Nested starter paths are created one contained parent at a time. Symlinked or
traversing parents are rejected, and `--force` repairs hash-matching reused
support files to mode 0600 only after regular-file containment checks. The
legacy SOS-only serialized check/count/summary surface remains unchanged.

### Provenance Decision

Portability applies only to relative filesystem references used by the live
portable checker. Immutable source observations remain segregated from those
live references: projected wrappers bind the admitted source SHA-256 and the
projected payload SHA-256, while outer starter and manifest bindings are
recomputed after projection. Original source observations are never treated as
portable filesystem paths.

### Verification

- `node --test fleet-runtime/starter-contract.test.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 149 passed, 0 failed (clean checkpoint rerun supplied by the operator).
- `node --test fleet-runtime/*.test.mjs`
  - 428 passed, 0 failed.
- `npm test`
  - 168 test files passed; 2703 tests passed.
- `git diff --check`
  - Passed with no whitespace errors.

### Changed Files

- `fleet-runtime/host-receipt.mjs`
- `fleet-runtime/receipt-bundle.mjs`
- `fleet-runtime/receipt-bundle.test.mjs`
- `fleet-runtime/starter-contract.test.mjs`
- `.superpowers/sdd/task-7-report.md`
- `.superpowers/sdd/task-7-final-review.md` (retained as the durable review
  input)

### Concerns

No test or whitespace failures remain. `npm test` continues to emit Node's
existing experimental SQLite warnings. The portable representation retains
cryptographic source-byte digests and projected evidence, but does not embed a
second copy of every admitted source file; independent verification therefore
establishes the typed digest/projection chain rather than reconstructing the
discarded source checkout byte-for-byte.

---

## Task 7 Final Source-Graph And Sidecar Remediation

### Result

Portable starter verification now anchors every retained preimage to the
original outer manifest's digest graph. Service definitions must agree with
the retained service, install, and Host-Go receipts; install manager and
definition hashes must also agree with observed service evidence. Malformed
outer preimages fail closed without throwing, and provenance reads use one
no-follow file descriptor from type check through byte read.

Starter directory verification supports contained nested evidence paths and
checks the exact recursive tree. Canonical export sidecars are independent of
the sidecar files themselves, and both legacy and starter exports require
semantic evidence completeness rather than accepting any schema-valid passing
receipt.

### Verification

- `node --test fleet-runtime/starter-contract.test.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 157 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 436 passed, 0 failed.
- `npm test`
  - Passed with exit code 0; only the repository's existing experimental
    SQLite warnings were emitted.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `git diff --check`
  - Passed with no whitespace errors.

### Adversarial Coverage

- Coordinated replacement of a retained service definition and its projection
  still fails the original source digest graph.
- A hash-matched malformed retained outer manifest fails closed without an
  exception.
- Passing install evidence with a different manager or definition digest is
  rejected.
- Nested source evidence passes source check, export, and exported-bundle
  verification end to end.
- Schema-valid sidecars with substituted checks or omitted copied evidence are
  rejected by semantic completeness checks.

### Concerns

No blocking concern. SHA-256 establishes deterministic bundle integrity, not
publisher authenticity; signed provenance remains intentionally outside this
task.

---

## Task 7 Second Cumulative-Review Remediation

### Result

The checker now treats malformed portable provenance as absent evidence and
returns a failed receipt instead of dereferencing unchecked paths or arrays.
Activated install receipts must bind both service definitions by manager,
path, and digest to install outputs, which are already bound to observed
service evidence. Every nested starter directory is checked at mode `0700` in
addition to exact recursive tree membership.

Export-receipt semantics are reconstructed check by check from the copied
manifest, retained source provenance, copied artifacts, canonical manifest
check, and current file hashes. The final receipt uses `.` for the discarded
source directory and omits transient hashes for sidecar versions that are
overwritten during finalization. A schema-valid check list with a substituted
path no longer passes.

### Verification

- `node --test fleet-runtime/starter-contract.test.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`
  - 158 passed, 0 failed.
- `node --test fleet-runtime/*.test.mjs`
  - 437 passed, 0 failed.
- `npm test`
  - 168 files passed; 2703 tests passed.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `git diff --check`
  - Passed with no whitespace errors.

### Review Findings Closed

- Malformed portable `provenance: {}` fails closed without throwing.
- Embedded activation definitions cannot disagree with install output or the
  selected service receipt.
- Nested starter evidence directories with mode `0755` are rejected.
- Substituting a passing export check's path is rejected by exact canonical
  check reconstruction.

### Concerns

No blocking concern. The final export receipt deliberately does not claim a
digest for an overwritten intermediate sidecar; only retained or
independently reconstructible evidence is represented as verifiable.

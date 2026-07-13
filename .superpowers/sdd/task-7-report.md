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

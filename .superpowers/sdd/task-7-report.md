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

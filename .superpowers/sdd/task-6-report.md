# Task 6: Continuous-Runtime Receipt Report

## Delivered

Implemented `mupot-fleet-continuous-runtime-receipt/v1` in `fleet-runtime/continuous-runtime-receipt.mjs`.

- Parses every required CLI option, including repeatable `--require-control`, and provides successful complete help output.
- Reads baseline heartbeat and control daemon states, polls through injected dependencies until both counters advance or the heartbeat interval plus grace deadline expires, then performs a final state re-read and service status read.
- Projects only reduced daemon state, selected-agent, and service evidence. It excludes raw configs, command output, request bodies, nonce, signature, tokens, credentials, and private material.
- Produces distinct failure reasons and checks for timeout, stalled counters, stale heartbeat, stopped services, dead probe, non-2xx heartbeat, failed consume, disabled systemd linger, and required-control mismatch.
- Uses the accepted exact linger guidance command when systemd linger is disabled.

## Changed Files

- `fleet-runtime/continuous-runtime-receipt.mjs` (new): CLI, bounded observation, service check, safe evidence projection.
- `fleet-runtime/continuous-runtime-receipt.test.mjs` (new): deterministic injected-clock matrix and argument coverage.
- `package.json`: adds `receipt:continuous-runtime`.

## TDD Evidence

1. Wrote the deterministic matrix before production code.
2. Ran `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`.
   - Initial result: failed as expected with `ERR_MODULE_NOT_FOUND` for `continuous-runtime-receipt.mjs`.
3. Implemented the minimum receipt module and ran the focused test.
   - Result: 13 passed, 0 failed, 50.237708 ms.
4. Added a test expectation for the required final state re-read.
5. Ran the focused test before the implementation update.
   - Result: failed as expected (`2 !== 3` state reads).
6. Added the final re-read and reran the focused test.
   - Result: 13 passed, 0 failed, 48.09475 ms.

## Verification

- `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`
  - 13 passed, 0 failed, 48.09475 ms.
- `npm run receipt:continuous-runtime -- --help`
  - Passed; listed `--agent`, `--heartbeat-state`, `--control-state`, `--service-manager`, `--definition-dir`, `--ttl-sec`, `--grace-sec`, `--poll-ms`, repeatable `--require-control`, and help.
- `node --test fleet-runtime/*.test.mjs`
  - 192 passed, 0 failed, 559.498833 ms.
- `npm test`
  - 168 test files passed; 2,703 tests passed; 5.32 s. Node emitted existing experimental SQLite warnings only.
- `git diff --check`
  - Passed with no whitespace errors.

## Self-Review

- The output projects only known-safe v1 state fields. The tests inject token, nonce, signature, and service command-output values and assert none appear in the serialized receipt.
- Both counters must advance independently. A partial or full timeout retains the actual stalled-counter check rather than overwriting it with a generic timeout.
- Required control accepts only a selected-agent, accepted latest outcome whose verb belongs to the explicitly requested set.
- Service evidence excludes definitions and command output. Disabled systemd linger sets `reason: "linger_disabled"` and emits only the accepted actionable command.
- Polling tests use injected `now`, `sleep`, `readRuntimeState`, and `buildServiceReceipt`; no test performs real waiting.

## Concerns

None.

---

## Independent Review Hardening Fix

### Delivered

- Reused `redactSecretValues` from `service-context.mjs` for option/error handling and recursive final receipt sanitization. Every upstream string that remains in the receipt is now an exact schema/enum, normalized ISO timestamp, canonical service key/name/check, or constrained identifier. Secret-bearing projected fields fail closed without serializing the source value.
- Added exact heartbeat and control v1 parsers with required object shapes, positive/non-negative numeric ranges, producer cadence bounds, selected-agent enums, HTTP status bounds, and normalized timestamps.
- Added exact status service-receipt validation for receipt type, generated timestamp, action, status, manager, the two canonical heartbeat/control entries, unique producer check names, and producer-compatible nullable systemd linger evidence. A bare `{status:'pass'}` no longer proves service health.
- Made deadline expiry irreversible. Poll evidence is timestamped before acceptance, the final read remains evidence-only, and the failure matrix preserves `timeout` for both stalled or both late-advanced counters and the individual counter reason when only one stalls.
- Updated inbox validation to the actual producer vocabulary. `inbox_peek_fail`, `inbox_consume_fail`, and `inbox_handler_fail` fail; all non-failure values emitted by `runtime-state.mjs` remain valid evidence.
- Validated library and CLI paths, agent IDs, managers, controls, finite clocks, TTL/grace/poll bounds, and finite deadlines. Polling has a window-derived iteration bound and rejects a frozen/non-progressing clock immediately.
- Restricted required controls to `start`, `stop`, `restart`, and `status`; option values cannot consume a following flag. Exported an injectable `main` that preserves exit 2 for option errors and exit 1 for failed receipts while canonically redacting actionable errors.
- `package.json` required no correction; the existing `receipt:continuous-runtime` command remains authoritative.

### TDD Evidence

1. Added the adversarial projection, deadline, exact-schema, producer-vocabulary, bounded-clock, option, and CLI regression cases before implementation.
2. First red run of `node --test fleet-runtime/continuous-runtime-receipt.test.mjs` failed with the expected missing `main` export.
3. First implementation run exercised the new suite and failed 2 of 61 tests: the original passing fixture exposed an unnecessary future-timestamp restriction, and unsupported control validation was masked by the missing-agent check.
4. Added a frozen-clock quick-failure expectation before clock-progress validation; the red run failed with `timeout !== invalid_clock`.
5. Added producer-compatible nullable linger and duplicate service-check cases before their implementation; the red run failed both cases as expected.
6. Final focused result: 70 passed, 0 failed, under one second.

### Verification

- `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`
  - Exit 0; 70 passed, 0 failed, 0 skipped; 165.062 ms.
- `npm run receipt:continuous-runtime -- --help`
  - Exit 0; printed all required options and the authoritative `start`, `stop`, `restart`, `status` control vocabulary.
- `node --test fleet-runtime/*.test.mjs`
  - Exit 0; 249 passed, 0 failed, 0 skipped; 613.208042 ms.
- `npm test`
  - Exit 0; 168 test files passed and 2,703 tests passed; 6.93 s. Node emitted the existing experimental SQLite warnings only.
- `git diff --check`
  - Exit 0 with no output before this append; final post-report check recorded below.

### Self-Review

- Critical 1: adversarial secrets now occupy projected schema, heartbeat/control timestamps, selected-agent probe/consume, control agent/result, service manager/key/name, and service check fields. Each case returns a secret-free failed v1 receipt. Final recursive sanitization uses the canonical repository redactor as defense in depth.
- Critical 2: deadline checks occur before evidence reads and again after reads before accepting advancement. A final re-read cannot clear `timed_out`; both late advances still produce `timeout`, while one stalled counter retains its counter-specific reason.
- Critical 3: heartbeat/control/service evidence must match exact producer contracts before it is projected. Read, malformed, status-call, and malformed-service failures return distinct safe reasons and checks without rejection from `buildContinuousRuntimeReceipt`.
- Critical 4: tests use the real daemon values `inbox_consume_fail` and `inbox_handler_fail`, also cover `inbox_peek_fail`, and permit all known non-failure runtime-state values.
- Important 1: CLI and library values share bounded validation. Clocks must be finite, monotonic, and advancing after sleep; deadline arithmetic is finite; a derived iteration bound remains as a secondary stop.
- Important 2: the allowed control verbs exactly match `control-request.mjs`.
- Important 3: missing option values reject following flags, parse errors preserve redacted reasons at exit 2, and read/status failures serialize actionable safe receipts at exit 1 without real waits.
- The original deterministic matrix remains present and green. Focused tests complete in under one second.

### Concerns

- No live launchd/systemd service observation was performed for this review fix; service integration was checked against the unchanged producer implementations and the complete deterministic fleet-runtime suite.

### Final Whitespace Verification

- `git diff --check`
  - Exit 0 with no output after appending the hardening report.

---

## Fresh Re-review Remediation

### Delivered

- Replaced regex-based control result acceptance with the exact tuples produced by `fleet-control-daemon.mjs`, `control-request.mjs`, and `runtime-state.mjs`. Normal `idle`, all four successful verb/result mappings, all requestless failure reasons, and the request-bound failure mappings are explicit; failed outcomes cannot satisfy required control.
- Replaced the fabricated `started` fixture with `start/open`. Added exhaustive producer tuple coverage, wrong-tuple rejection, non-string required-field rejection, and an arbitrary scanner-clean result regression proving the value is neither accepted nor emitted.
- Validated the complete `buildServiceReceipt`/`buildFailedServiceReceipt` status envelope, including exact top-level fields and safe nested definitions, services, commands, preservation claims, next steps, checks, and linger evidence. The full raw receipt is recursively scanned with the canonical repository secret scanner before evidence is accepted.
- Required passing service receipts to match the resolved requested manager, contain both canonical loaded/running services and definitions, and carry successful operational and secret-output checks. Canonical failures with zero or partial services remain typed service evidence and produce `services_not_running` instead of `service_receipt_malformed`.
- Made the iteration cap a clock/progress failure. Only an observed clock value at or beyond the derived deadline can set `timed_out`; a monotonically but too-slow clock with no-op sleep returns bounded `invalid_clock`.
- Made final post-timeout reads best effort and independent. Valid evidence may update, while read or schema failures retain the last valid state and preserve timeout or one-stalled-counter classification. Non-timeout final evidence remains fail closed.
- Removed exact state-read-count assertions. Tests now assert returned start/deadline/completion timestamps, timeout state, status, reasons, and observable bounded termination.

### TDD Evidence

1. Baseline focused suite: 70 passed, 0 failed.
2. Added producer compatibility, service envelope, slow-clock, final-reread, and test-quality regressions before production changes.
3. First red run: 102 tests, 81 passed and 21 failed. Failures matched idle rejection, arbitrary result acceptance, premature timeout, final-reread replacement, incomplete/unsafe service acceptance, wrong-manager acceptance, and canonical failure misclassification.
4. First green implementation run left only the legacy impossible `stop/open` fixture failing; corrected it to producer-realistic `stop/close`.
5. Expanded all finite producer control failure tuples and added incompatible tuple rejection; focused suite reached 122 passed.
6. Self-review added a non-string requestless `agent_id` regression. The targeted red run failed as expected, then strict required-field typing made the final focused suite 123 passed.

### Verification

- `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`
  - Exit 0; 123 passed, 0 failed, 0 skipped; 98.84325 ms.
- `npm run receipt:continuous-runtime -- --help`
  - Exit 0; printed all required options and `start`, `stop`, `restart`, `status` for repeatable `--require-control`.
- `node --test fleet-runtime/*.test.mjs`
  - Exit 0; 302 passed, 0 failed, 0 skipped; 608.09525 ms.
- `npm test`
  - Exit 0; 168 test files passed and 2,703 tests passed; 6.05 s. Only the existing experimental SQLite warnings were emitted.
- `git diff --check`
  - Exit 0 with no output before this append; final post-report result recorded below.

### Self-Review

- Critical control compatibility: accepted evidence is limited to `idle`, `start/open`, `stop/close`, `restart/restart_open`, and `status/status_noop`. The finite producer failure vocabulary is modeled by request presence and verb; arbitrary scanner-clean results fail as `control_state_malformed` without projection.
- Critical service compatibility: every producer-required envelope field and nested safe type is validated after a full recursive secret scan. Launchd/systemd pass fixtures, zero/partial-service failure fixtures, wrong-manager receipts, incomplete passes, and a Bearer-bearing command are covered.
- Important idle behavior: `accepted: true`, null agent/verb, and `result: idle` is valid polling evidence but does not satisfy `--require-control`.
- Important deadline behavior: the safety cap cannot create a timeout before the clock reaches the deadline. Frozen and slowly advancing clocks terminate as `invalid_clock`.
- Important final reread behavior: timeout plus final read throw/malformed cases cover both-stalled and one-stalled observations. The prior valid evidence, timeout flag, deadline, completion timestamp, and reason are retained.
- Minor test brittleness: no assertion constrains exact state read counts. The original 70-case matrix remains present and the expanded 123-case focused suite stays under one second.
- Scope review: only the two owned runtime files and this append-only report changed. No package, producer, or unrelated workspace changes were modified.

### Concerns

- No live launchd/systemd host observation was performed. Compatibility was verified against the unchanged producer implementations, producer-shaped launchd/systemd fixtures, the 302-case fleet-runtime suite, and the repository-wide suite.

### Final Post-report Whitespace Verification

- `git diff --check`
  - Pending final command after this append.

Final result: exit 0 with no output after the complete report append.

---

## Final Independent Review Compatibility Fixes

### Delivered

- Captured heartbeat and control advancement flags at the observed deadline before the best-effort final reread. Final rereads still refresh emitted after-evidence, but timeout classification now remains bound to deadline evidence.
- Accepted producer-valid heartbeat status `0` alongside `null` and HTTP statuses `100..599`, allowing network failures to fail `signed_heartbeat_2xx` as `heartbeat_not_2xx`.
- Kept passing service receipts strict while accepting failed receipts from `buildFailedServiceReceipt` that include safe diagnostic check prefixes before the canonical `service_operation_failed` and `command_output_secret_free` tail. The full raw envelope remains recursively scanned; unrecognized diagnostics are not projected.
- Added injected `auto` manager coverage for darwin/launchd and linux/systemd, including exact manager-specific definition options supplied to `buildServiceReceipt`.

### TDD Evidence

1. Added regressions for one-sided late final rereads, producer network heartbeat status `0`, exported failed-service diagnostic prefixes, malformed/secret diagnostic prefixes, and deterministic auto-manager resolution before changing runtime behavior.
2. Red run: 131 tests total, 126 passed and 5 failed. The failures were the two mutable timeout classifications, status `0` malformed classification, and failed-service diagnostic envelope rejection; the auto-manager coverage passed against the existing injection path.
3. Implemented immutable deadline flags, producer-compatible status validation, and canonical failed-service tail validation. A focused run exposed the existing ordinary failed status-envelope shape, so validation was narrowed to accept that strict canonical form alongside the exported exception envelope.
4. Added explicit malformed and secret-bearing diagnostic-prefix guards. Final focused suite reached 134 passing tests.

### Verification

- `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`
  - Exit 0; 134 passed, 0 failed, 0 skipped; 120.905375 ms.
- `npm run receipt:continuous-runtime -- --help`
  - Exit 0; usage lists `--agent`, both state paths, `--service-manager`, `--definition-dir`, TTL, grace, polling, repeatable `--require-control`, and help.
- `node --test fleet-runtime/*.test.mjs`
  - Exit 0; 313 passed, 0 failed, 0 skipped; 745.911791 ms.
- `npm test`
  - Exit 0; 168 test files passed and 2,703 tests passed; 8.68 s. Node emitted the existing experimental SQLite warnings only.
- `git diff --check`
  - Exit 0 with no output before this report append; final post-append result recorded below.

### Self-Review

- Deadline classification uses explicit pre-reread advancement flags. Valid late evidence changes only projected after counters, never timeout versus one-stalled-counter reasoning. Throwing and malformed final rereads remain covered.
- Heartbeat status `0` is schema-valid but cannot satisfy the 2xx assertion, matching the signed network-failure producer path.
- Service validation recursively scans the full raw envelope, validates all diagnostic prefixes structurally and secret-free, validates the canonical tail, and projects only canonical checks. Passing status envelopes remain exactly two strict checks; ordinary failed status envelopes remain supported.
- Auto-manager tests depend solely on injected `serviceDeps.platformName`; no host manager or platform detection is used.
- Scope is limited to the two assigned runtime files and this append-only report.

### Concerns

- No live launchd or systemd service observation was performed. Coverage is deterministic and producer-shaped, including injected darwin and linux resolution.

### Final Post-report Whitespace Verification

- `git diff --check`
  - Exit 0 with no output after this append.

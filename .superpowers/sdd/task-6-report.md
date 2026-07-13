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

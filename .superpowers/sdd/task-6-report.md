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

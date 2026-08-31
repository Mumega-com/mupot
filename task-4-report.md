# Task 4 Report — v0.30 Neutral Contract

Status: complete within the assigned ownership scope.

Changes:

- Changed `docs/releases/v0.30.0-contract.json` to require
  `mupot-host-go-cutover/v1` for `host-go/cutover-gate.json`.
- Added the v0.30 contract/plan assertion and the v0.23 legacy kill-witness.
- Left `scripts/release-readiness-receipt.mjs` unchanged; its v0.23 default
  remains `mupot-sos-cutover-gate/v1`.

TDD evidence:

- RED: `npx vitest run tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts`
  produced exactly one expected v0.30 neutral-contract failure; v0.23 passed.
- GREEN: the same command passed, 2 files / 11 tests.
- `git diff --check` passed.

Focused readiness command:

- `npx vitest run tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts tests/release-readiness-receipt.test.ts`
  passed the two Task 4 files (11 tests) but had 5 failures in the non-owned
  `tests/release-readiness-receipt.test.ts`. Those fixtures derive v0.30
  contracts from the historical `REQUIRED_RECEIPTS` and derive v0.23 host
  bundles through the neutral producer; correcting them would exceed Task 4
  ownership and changing the readiness checker would violate the brief.

Commit: final `git HEAD` (`fix(release): require neutral Host-Go gate`)

Concern: see the focused readiness command note above; no production or legacy
default change was made to mask those failures.

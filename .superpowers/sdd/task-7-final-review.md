# Task 7 Cumulative Review: 0d98cfe..8f267ef

Status: CHANGES_REQUIRED

## Critical

1. Real launchd Host-Go receipts are rejected. The producer emits
   `systemd_linger_enabled` with `applicable: false` on launchd, while the
   bundle expects an invented `launchd_linger_not_applicable` check. The
   private validator also rejects producer-valid repeated per-agent and
   optional exec-probe checks.
2. Byte-bound artifacts can still represent failed or fabricated required
   evidence. Top-level status is not bound to recomputed summary status;
   install warnings and a self-authored empty prior bundle are accepted where
   Task 8 requires passing evidence.
3. Portable provenance is internally self-consistent but not independently
   verifiable after source deletion. Projection records copy a caller-supplied
   source digest but discard the admitted source preimage, so the checker
   cannot prove that the projection came from those source bytes.

## Important

1. Exact recursive schemas are incomplete for install, probe, control,
   cutover, and sidecar check records; malformed probe collections can throw.
2. Non-string `next_steps` entries are filtered before comparison and can
   bypass the closed ordered policy.
3. Legacy runtime bundles gain a new schema check, changing the historical
   serialized check/count/summary surface.
4. The shared contract permits nested relative artifact paths, but packaging
   does not create their parent directories.
5. `--force` does not repair permissions on hash-matching reused support
   files, although verification requires mode `0600`.

## Confirmed Resolved

- Explicit manager/platform mismatch rejection.
- Producer-valid boolean `enabled` semantics.
- Service PID, cadence, counter, and outcome binding.
- Final-component symlink and regular-file containment.

Review was static and read-only; no tests were run by the reviewer.

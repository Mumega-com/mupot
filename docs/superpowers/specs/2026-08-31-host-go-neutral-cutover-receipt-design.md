# Mupot/Herdr-Neutral Host-Go Cutover Receipt Design

**Status:** Approved design, written specification pending user review

**Date:** 2026-08-31

**Baseline:** `ccfdb4b3247b46108618d5b1c58a5d0f63ed8147`

## Problem

The current Host-Go evidence chain is operationally Mupot-based but still names
and governs itself as an SOS removal workflow:

- `fleet-runtime/cutover-receipt.mjs` emits
  `mupot-sos-cutover-gate/v1`;
- `fleet-runtime/receipt-bundle.mjs` describes itself as an evidence pack for
  SOS cutover;
- passing and failing manifests prescribe whether SOS wiring may be removed;
- the v0.30 release contract requires the SOS-specific receipt type.

The active operating policy is Mupot/Herdr-only. SOS must not be restored or
treated as a required live dependency. At the same time, historical v0.23
evidence and exported bundles must remain verifiable without rewriting their
receipt types, checks, hashes, or next-step policy.

This is a receipt-contract migration, not a text-only rename. The producer,
strict normalizers, manifest verifier, export verifier, status renderer,
release-readiness contracts, fixtures, and operator documentation all depend on
the existing type and policy strings.

## Goals

1. Make the canonical Host-Go cutover receipt Mupot/Herdr-neutral.
2. Prove, fail closed, that the Host-Go evidence chain contains no live SOS
   dependency.
3. Preserve strict parsing and copied-bundle verification of historical
   `mupot-sos-cutover-gate/v1` receipts.
4. Require the neutral receipt for v0.30 prepublication and final readiness.
5. Keep v0.23 historical contracts and evidence valid.
6. Replace current operator instructions that retain or remove SOS wiring with
   neutral Host-Go handoff instructions.
7. Preserve exact schemas, secret redaction, artifact hashes, portable
   provenance, and existing host/runtime/control safety gates.

## Non-goals

- Do not delete or rewrite historical receipt files.
- Do not claim that no SOS artifact exists anywhere on a host.
- Do not scan archived home-directory state, unrelated repositories, or
  unrelated user services.
- Do not restore, stop, start, or remove SOS services.
- Do not deploy, migrate production, rotate credentials, change ACLs, merge the
  resulting PR, or perform live Host-Go control.
- Do not rename `cutover-gate.json` or the manifest artifact role
  `cutover_gate`; retaining both avoids needless packaging breakage.

## Definition of “No Live SOS Wiring”

For this contract, “no live SOS wiring” means that the evidence chain used to
run the selected agents has no SOS dependency:

- no SOS binding key such as `SOS`, `SOS_*`, or `sos_*`;
- no `.sos` or dedicated `/sos/` path in a configured runtime, key, state,
  service, script, probe, or command location;
- no SOS service/unit/launchd label;
- no SOS-backed probe or adapter command;
- no SOS endpoint referenced by the relevant Host-Go receipt fields.

The check is intentionally limited to the host, runtime, and lifecycle-control
receipt chain. Archived files and unrelated host services are outside this
receipt's authority and do not block it.

The result is computed from the parsed source receipts. It is not accepted from
a CLI boolean or copied self-attestation.

## Canonical Neutral Receipt

The canonical producer emits:

```json
{
  "receipt_type": "mupot-host-go-cutover/v1",
  "generated_at": "<ISO-8601>",
  "status": "pass",
  "summary": {
    "status": "pass",
    "passed": 0,
    "failed": 0,
    "warnings": 0
  },
  "inputs": {
    "substrate": "mupot-herdr",
    "live_sos_wiring": false,
    "agents": ["<agent-id>"],
    "host_receipt": "<path>",
    "runtime_receipts": ["<path>"],
    "control_receipts": ["<path>"],
    "required_control_verbs": ["start", "stop"]
  },
  "checks": [
    {
      "ok": true,
      "component": "host-go-cutover",
      "check": "no_live_sos_wiring",
      "substrate": "mupot-herdr",
      "finding_count": 0,
      "findings": []
    }
  ]
}
```

The existing host, runtime, inbox handoff, and lifecycle-control checks remain
in their current order. The new `no_live_sos_wiring` check is appended after all
source receipt and per-agent control checks. Summary values are recomputed from
the complete check array.

If an SOS marker is found, the producer emits the same neutral receipt type with
`status:"fail"`, `inputs.live_sos_wiring:true`, and a failing
`no_live_sos_wiring` check. A failing finding contains only:

```json
{
  "location": "host.checks[4].probe",
  "marker": "sos_path"
}
```

The finding never includes the matched value, command, token, environment
value, or receipt body. Findings are deduplicated and sorted by location then
marker so receipt output is deterministic.

## Evidence-Chain Scanner

The scanner receives the already parsed host, runtime, and control receipts.
It examines keys and values only under fields that can configure or identify a
live runtime dependency:

- `path`, `*_path`, `*_config`, `*_file`, `*_dir`;
- `probe`, `command`, `argv`, `expected_argv`, `script`;
- `service`, `name`, `unit`, `label`, `binding`, `env`;
- `base_url`, endpoint, adapter, and runtime identifiers.

Marker classes are closed and versioned in code:

- `sos_binding` for SOS binding/environment names;
- `sos_path` for `.sos` or dedicated SOS path segments;
- `sos_service` for SOS unit, service, or launchd identifiers;
- `sos_command` for SOS-backed script, probe, adapter, or command names;
- `sos_endpoint` for endpoints explicitly identifying SOS.

Ordinary prose, arbitrary message bodies, unrelated audit text, and the legacy
receipt type itself are not scanner inputs. This avoids false positives while
keeping the operational evidence surface fail closed.

Malformed scanner inputs, unsupported value types at a scanned field, missing
neutral policy fields, non-boolean `live_sos_wiring`, a non-empty finding list
on a passing check, or a finding-count mismatch invalidate the neutral receipt.

## Historical Compatibility

`mupot-sos-cutover-gate/v1` remains an accepted historical input to the general
bundle and copied-manifest verifiers.

Compatibility is parser-only:

- new producers never emit the legacy type;
- no conversion rewrites historical receipts;
- the legacy normalizer retains its current exact top-level keys, input keys,
  check order, and summary rules;
- historical manifests retain their existing SOS-specific next-step strings;
- export and portable-provenance verification preserve the source type and
  source next-step policy.

The general parser returns a mode of `neutral` or `legacy`. Downstream policy is
selected from that mode rather than from one global `EXPECTED.cutover_gate`
constant.

Legacy compatibility must not weaken current release readiness. The v0.30
contract requires `mupot-host-go-cutover/v1`, so a valid legacy bundle remains
historically verifiable but fails the v0.30 receipt-type assertion.

## Bundle and Manifest Policy

New Host-Go bundles use neutral instructions:

- passing: `attach manifest.json and cutover-gate.json to the Host-Go handoff record; handoff is permitted only for the proven agent(s)`;
- failing: `do not complete the Host-Go handoff yet; rerun until manifest.json and cutover-gate.json are status pass`.

Manifest generation, status output, export receipts, copied-bundle checks, and
starter-ready validation choose the expected receipt type and exact next-step
policy from the cutover receipt mode.

For neutral bundles:

- the artifact metadata type must be `mupot-host-go-cutover/v1`;
- the neutral receipt must pass strict normalization;
- the manifest must use exactly the neutral next-step policy;
- export and copied-manifest verification must preserve that type and policy.

For legacy bundles:

- the artifact metadata type may be `mupot-sos-cutover-gate/v1`;
- the legacy receipt must pass its existing strict normalizer;
- the manifest must use exactly the historical SOS policy;
- no neutral policy or no-SOS assertion is synthesized into the old artifact.

Mixed modes fail. For example, a legacy receipt with neutral next steps or a
neutral receipt with legacy next steps is invalid.

## Release Contract Behavior

`docs/releases/v0.30.0-contract.json` changes only the Host-Go cutover receipt
type:

```json
{
  "objective": 2,
  "file": "host-go/cutover-gate.json",
  "receipt_type": "mupot-host-go-cutover/v1",
  "phases": ["prepublication", "final"]
}
```

The legacy v0.23 default in `scripts/release-readiness-receipt.mjs` remains
`mupot-sos-cutover-gate/v1`. Historical v0.23 tests and release documentation
remain unchanged.

The v0.30 contract and rendered plans must contain no SOS-specific receipt type
or instructions. Exact release-SHA/version bindings and canonical SHA validation
remain unchanged.

## Documentation Migration

Current operator documentation is updated to describe Host-Go handoff rather
than SOS removal:

- `fleet-runtime/README.md`;
- `docs/runtime-starter.md`;
- `docs/agent-running-on-mupot.md`;
- `docs/squad-mupot-cutover.md`;
- `docs/releases/v0.30.0.md`.

Where these documents explain historical evidence, they explicitly label
`mupot-sos-cutover-gate/v1` as legacy and link it to the neutral successor.
`docs/releases/v0.23.0-trusted-runtime.md` remains a historical record and is
not rewritten.

Source comments, CLI help, Host-Go plans, status summaries, next actions, and
current examples use neutral terminology.

## Test Strategy

Tests follow strict RED/GREEN cycles.

### Neutral producer

- A valid Host-Go chain emits `mupot-host-go-cutover/v1`.
- The neutral inputs and `no_live_sos_wiring` check are exact.
- Neutral passing/failing next-step policies are exact.

### Fail-closed SOS detection

Each marker class is mutation-tested independently:

- `SOS_TOKEN_FILE` binding;
- `~/.sos/keys/...` path;
- `sos-agent.service` service name;
- SOS-backed probe/command;
- SOS endpoint.

For each mutation, the producer becomes RED and the neutral strict normalizer
rejects a forged pass. Removing the assertion, changing its component/name,
setting `live_sos_wiring` to a non-boolean, lying about finding count, or adding
unknown fields also fails.

Tests assert that sensitive matched values are never emitted.

### Historical parser

- Existing exact legacy fixtures continue to pass.
- Legacy receipt hashes and schemas are not rewritten.
- Near-miss legacy types and malformed legacy schemas still fail.
- Historical export and copied-manifest verification remain green.

### Mode separation

- Neutral receipt plus legacy next steps fails.
- Legacy receipt plus neutral next steps fails.
- Neutral manifest with legacy artifact metadata fails.
- v0.30 rejects a valid legacy cutover receipt.
- v0.23 continues accepting its valid legacy cutover receipt.

### Plans and documentation

- Current Host-Go plans/status text contain no SOS removal/retention wording.
- The v0.30 contract contains only the neutral cutover type.
- Current runbooks name the neutral type.
- Historical v0.23 documents and fixtures retain the legacy type.

## Implementation Surface

Expected production changes:

- `fleet-runtime/cutover-receipt.mjs` — neutral producer and scanner;
- `fleet-runtime/receipt-bundle.mjs` — dual strict normalizers and mode-aware
  bundle/manifest/export/status policy;
- `scripts/release-readiness-receipt.mjs` — preserve legacy v0.23 defaults;
- `docs/releases/v0.30.0-contract.json` — require the neutral type;
- current Host-Go/operator documentation listed above.

Expected tests:

- `fleet-runtime/cutover-receipt.test.mjs`;
- `fleet-runtime/receipt-bundle.test.mjs`;
- `tests/release-v030-contract.test.ts`;
- `tests/release-v023-readiness.test.ts`;
- current documentation/runbook contract tests.

No unrelated runtime, API, database, deployment, authentication, or UI files
are in scope.

## Rollout and Gate

1. Implement on a branch from `ccfdb4b3` using TDD.
2. Run focused cutover/bundle/release-contract tests.
3. Run Fleet, full Vitest, typecheck, audit, and exact code graph.
4. Push a PR without merging it.
5. Request Athena exact-head review with head/tree/diff hashes and RED/GREEN
   evidence.
6. Stop after Athena's verdict. Merge and all live Host-Go/deployment actions
   require separate direct authorization.

## Completion Criteria

The implementation is complete only when:

- new Host-Go evidence emits and strictly verifies the neutral receipt;
- historical SOS receipts still parse and verify without mutation;
- no-live-SOS mutations fail closed;
- v0.30 requires and documents the neutral receipt;
- v0.23 historical behavior remains green;
- current plans and runbooks contain no operational SOS retention/removal
  instructions;
- focused and full gates are green;
- Athena approves the exact PR head;
- no merge, deployment, production migration, live host control, credential, or
  ACL action occurred.

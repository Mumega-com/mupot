# Mupot Connect roadmap and version policy

[Master documentation](docs/MASTER.md) · [Feature catalog](docs/FEATURES.md) · [Changelog](CHANGELOG.md)

Status: proposed application roadmap, documented 2026-09-10. Dates are evidence snapshots, not delivery promises. Hadi approves product scope and releases; ownership/dependency agreement is required before cross-component implementation.

## Independent version tracks

| Track | Baseline / source | Policy |
| --- | --- | --- |
| Rust application | Cargo **0.1.0**; bundle short version **0.1.0**, build **1** | This roadmap owns application versions only |
| Mupot server | Its own [roadmap](../../ROADMAP.md) and [changelog](../../CHANGELOG.md) | Never infer server support from the Rust version |
| Mac seatlink | Manifest 0.2.1 observed; registry metadata still 0.2.0 | Effective source and service configuration outrank cached labels |
| VPS seatlink | Separate 0.3.1 installation reported by Hadi/Dara | Not verified as equivalent to the Mac build |
| Desktop harness/provider | Exact observed build and exposed interface | Version pin and capability test per adapter |

Changing documentation alone does not bump the Cargo application version. A future app release must synchronize Cargo.toml, Cargo.lock, bundle version/build, User-Agent compatibility label, package name, changelog, and release manifest. The current User-Agent is `Mupot-Connect/0.1`; it is not a full build fingerprint.

## Proposed release train

### 0.1.0 — native onboarding developer preview

**Current source, not a stable host release.** Features F-001–F-015: secure app-owned onboarding, boot/context, saved profiles, local discovery, explicit app check-in, native UI/demo and local macOS packaging.

Recorded local tests and review: [VERIFICATION.md](VERIFICATION.md), dated September 9. Live enrollment, OS Keychain integration with a real approved account, desktop delivery, and public distribution were not proven by that record.

### 0.2.0 — desktop operator foundation

**Proposed / contract-dependent.** Features F-020–F-028. Separate the host state from UI views, identify individual desktop working sessions, bind them through the agreed existing authorization path, and integrate one Codex operator adapter with the authoritative ingress owner.

Entry gates: D-001 boot/seat proof; D-002 inbox ownership; D-003 local desktop handoff; D-004 reviewed external dispatch/result behavior; D-005 consumption evidence. These are defined in [Decisions](docs/DECISIONS_AND_FEEDBACK.md).

Exit proof: two distinct operator sessions remain isolated; one Herdr developer request reaches the selected already-existing operator and a correlated result returns through Mupot. Busy and unavailable destinations behave honestly. No second seatlink consumer and no silent substitute execution.

Read-only inventory and isolated fixtures may be developed before live contracts are resolved; that partial work must not be released as completed operator connectivity. Basic durable responsibility and safe duplicate handling are prerequisites for a live exchange, whether provided by the existing ingress or the host. If the existing owner cannot retain that responsibility, the necessary F-030 work moves into the 0.2 prerequisites; it is not deferred at the cost of losing work.

### 0.3.0 — resilience and capacity visibility

**Proposed.** Features F-030–F-036. Durable responsibility across restart, replay/ownership fences, observed version/model/activity, provider-reported usage/reset where supported, account-bucket failure fan-out, and useful diagnostics/attention integration.

Exit proof: controlled crashes at delivery/consumption/response boundaries preserve work; quota-block simulation affects only the correct consumers; diagnostics contain no secrets; loss of model capacity does not stop the independent host from reporting.

### 0.4.0 — additional adapters and host interoperability

**Proposed.** Features F-040–F-041. Add a second selected desktop harness only after inspecting its real interface. Verify Mac/VPS ownership and capability/version compatibility.

Exit proof: the additional adapter passes its own conformance; host disconnect/reconnect does not fork inbox ownership or misroute a reply. A higher plugin version is not evidence of compatible behavior.

### 0.5.0 — governed continuation

**Proposed / policy-dependent.** Features F-043–F-044. Preserve inspectable checkpoints and allow continuation in another suitable environment under explicit policy.

Exit proof: the original assignment, pending effects and artifact version are reconciled; only one writer continues; a returning original runtime cannot complete against stale ownership; approvals remain valid only for their exact scope/version.

### 1.0.0 — repeatable user release

**Target, not an announcement.** Features F-046–F-048, plus any approved F-045 service packaging required by the supported platform.

Exit proof: supported users can install, authorize an existing agent, join work, receive/return a contribution, understand a blockage, and recover or remove the app without developer intervention. The build has approved signing/distribution, version compatibility, support/runbook, accessibility and security evidence. Only platforms actually verified may appear in the support claim.

## Candidates without fixed versions

Linux/Windows distribution (F-042), opt-in background installation (F-045), and compatibility-aware updates (F-049) require platform-specific decisions. They are not implicitly promised by using Rust or by a manifest's minimum OS value.

Automatic fleet optimization, broad account/provider switching, and additional UI products have no committed release scope here. They require a user outcome and an accepted design before inclusion.

## Release numbering rules

- Before 1.0, increment the minor version for a meaningful capability or incompatible persisted/protocol change; patch releases carry compatible repairs. Document every incompatibility explicitly.
- Use prerelease labels such as `0.2.0-alpha.1` and `0.2.0-rc.1` only for actual published candidates. These examples do not create releases.
- Increment bundle build numbers for distributed builds even when a prerelease shares the same marketing version.
- Protocol/schema versions are independent. Record supported minimum/maximum versions and upgrade behavior; never silently reinterpret old state.
- A documentation revision, local binary, signed package, deployment, successful canary, and stable release are separate evidence states.
- Avoid tags that collide with Mupot server tags. The proposed application tag namespace is `mumachine-vX.Y.Z`; adopt it through the release decision, not this document alone.

## Release checklist

1. Freeze scope, feature IDs, exact source and dependency lockfile.
2. Resolve required contracts and independent review findings.
3. Run the documented test/conformance set and approved live canary.
4. Verify package metadata, signature, checksums, dependency/license notices, update/rollback behavior and declared platform support.
5. Update feature status, changelog, user/operations documentation and compatibility matrix.
6. Obtain Hadi's release/publication authorization and applicable independent gate.
7. Record what was actually distributed and verified; retain the prior recoverable release.

Do not renumber unfinished promises into the changelog or describe a source cut as a stable release.

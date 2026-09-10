# Existing documentation and evidence map

[Master](MASTER.md)

This map explains which existing sources were reused, which are historical, and where current implementation authority lives. It prevents this documentation set from becoming a competing description of Mupot or Herdr.

## Authority order

1. Current user-approved scope and applicable repository/host policy.
2. Exact implementation source, effective configuration and fresh observed behavior for the named component.
3. Independent review and acceptance receipts at that exact source/scope.
4. Versioned contracts and current operator runbooks.
5. Dated design documents, peer reports and historical receipts, explicitly labeled.

A README, an old green test record, a registry label or a model response does not override contradictory current evidence. No source here grants permission to run its operational commands automatically.

## Rust application sources

| Source | Role | Treatment |
| --- | --- | --- |
| [Cargo manifest](../Cargo.toml), [lockfile](../Cargo.lock), [bundle metadata](../assets/Info.plist) | Actual application/dependency/build declarations | Current 0.1.0 source; platform minimum is not a compatibility test |
| [Rust source](../src/lib.rs) and modules linked in [Architecture](ARCHITECTURE.md) | Implemented behavior | Primary for code claims |
| [Existing README](../README.md) | Current preview quickstart | Retained and linked, not replaced |
| [Verification](../VERIFICATION.md) | September 9 local evidence | Historical test/build/signing limits retained verbatim |
| [v0.1 design](../../../docs/superpowers/specs/2026-09-09-mumachine-desktop-v01-design.md) | Approved onboarding slice | Does not authorize later desktop receive/control |
| [v0.1 implementation plan](../../../docs/superpowers/plans/2026-09-09-mumachine-desktop-v01.md) | Prior build plan | Historical; source and verification determine what landed |

## Existing Mupot documentation

- [Mupot README](../../../README.md), [roadmap](../../../ROADMAP.md), and [changelog](../../../CHANGELOG.md): server/product release track, independent of this app's version.
- [Runtime adapter contract](../../../docs/runtime-adapter-contract.md): existing attachment and identity boundary.
- [Runtime dispatch operations](../../../docs/operations/runtime-dispatch-v1.md): native consumption/result/failure stages and evidence semantics.
- [Codex exact-delivery status](../../../docs/operations/codex-exact-delivery-status.md): dated September 5 distinction among active-turn plugin, receiver, and activation. Its historical Rust-host absence does not erase the later September 9 onboarding app; that app also does not complete the receiver.
- [Operator-experience record](../../../docs/architecture/operator-experience/README.md), [capability discovery](../../../docs/architecture/operator-experience/capability-discovery.md), [journey validation](../../../docs/architecture/operator-experience/journey-validation.md), and [record-family rules](../../../docs/architecture/operator-experience/operational-records-and-kanban.md): existing UI/service reuse and evidence vocabulary.
- [Seatlink catalog](../../../docs/plugins/mupot-seatlink.md) and [Cursor pager catalog](../../../docs/plugins/cursor-mupot-pager.md): pointers to separate integrations. Some catalog descriptions are older than effective local source; do not use them as a current version or transport proof.

## Earlier host and receiver work

The Mupot records and local sources identified an August 18 Rust-host design flight, C1 receiver-baseline/conformance work, H1 verifier-interface work, adversarial reviews, and an August 19 local receiver cutover. They establish prior engineering effort, not an earlier `mumachine` release or current fleet health.

The canonical earlier Codex receiver/plugin work also includes a separate JavaScript receiver, private route, ledger, App Server client, and reviewed activation constraints. Inspect it before introducing an equivalent path. Historical Herdr/tmux or SOS transport decisions must be reconciled with the current user/owner direction; this document does not revive retired transport.

[Mumega-com/hadi-mac PR #4](https://github.com/Mumega-com/hadi-mac/pull/4) was inspected at `0bc53018e1218dae707b63f286ba0a05d7e6b200`. Its per-turn adapter, lifecycle ledger, receiver and capacity schema may be reusable. Its fixed model/provider labels and scrollback-based estimates are not provider-confirmed desktop telemetry. Tests and current service activation were not independently rerun in that review.

## September 10 operational observations

Mupot MCP reads confirmed an authenticated shared Hadi ChatGPT directory connection, existing scoped project/presence/task/routine/attention data, and differing projection scopes. These do not establish a newly bound Hadi Dev desktop session. Self fleet liveness was unreported despite successful MCP reads.

Read-only local checks confirmed the Mac seatlink linked source/manifest, enabled registry, launchd ownership, a separate disabled older bridge, and the difference between registry 0.2.0 and manifest 0.2.1. Dara's later review supplied additional cached-startup and VPS findings. No restart, new consumer, token extraction or production canary was performed as part of those checks.

The opinion and both reviews were distributed through Mupot as a four-part document. The exact [r2 copy](research/2026-09-10-opinion-and-feedback-r2.md) is preserved; [Decisions](DECISIONS_AND_FEEDBACK.md) records later additions and differing receipt-integrity evidence.

## External reference policy

[Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) was checked for account usage/rate-limit interfaces on September 10. Documented APIs are potential adapter interfaces, not evidence that this app is wired to an existing desktop process.

Other harness support claims require primary vendor documentation plus exact local conformance. Do not infer ordinary desktop control from CLI, cloud, SDK or model-provider capabilities. Preserve version/date/source and an explicit unsupported or experimental status where appropriate.

## Not included or not established

- No exhaustive inventory of every deployment or future feature in the Mupot organization.
- No new commercial, performance, SOC 2, production-readiness or universal cross-platform claim.
- No public GitHub publication or software release implied by the local documentation set.
- No credentials, private desktop route identifiers, or full private conversation exports.

Use the [feature catalog](FEATURES.md) for all currently known application scope and the [roadmap](../ROADMAP.md) for proposals. Extend this map whenever new controlling evidence is introduced.

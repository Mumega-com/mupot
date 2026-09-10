# Feature catalog

[Master documentation](MASTER.md) · [Roadmap](../ROADMAP.md) · [Acceptance](TESTING_AND_ACCEPTANCE.md)

This is the catalog of all currently known Rust desktop-host features and future candidates as of 2026-09-10. It is not a claim to enumerate every future idea. IDs are stable; a changed scope retains history in the decision log and changelog.

## Status and ownership

**Implemented** means present in 0.1.0 source. Its historical verification is in [VERIFICATION.md](../VERIFICATION.md); live enrollment and other stated gaps are not erased by that label. **Planned** is a proposed milestone, not delivered. **Contract-dependent** requires Dara/Kasra/Hadi agreement before the relevant implementation or activation. **Candidate** has no release commitment.

Hadi Dev owns the Rust product lane. Dara owns the effective Herdr/plugin boundary; Kasra owns Mupot engineering contracts. Cross-boundary entries need their review rather than parallel replacement implementations.

## Implemented application features

| ID | Capability | Status / source | Observable boundary |
| --- | --- | --- | --- |
| F-001 | Plain HTTPS Mupot origin validation | Implemented — model (`host/mumachine/src/model.rs`, local source reference) | Reject userinfo, query, fragment, paths and insecure production origins |
| F-002 | Exact existing-agent UUID selection | Implemented — client (`host/mumachine/src/client.rs`, local source reference) | No ambiguous name-based enrollment or agent creation |
| F-003 | Browser-approved device flow | Implemented — device (`host/mumachine/src/device.rs`, local source reference) | Pending/slow-down/denied/expired/cancel states; same-origin approval |
| F-004 | Returned identity/tenant/expiry validation | Implemented — client (`host/mumachine/src/client.rs`, local source reference) | Token response alone is not successful onboarding |
| F-005 | App-owned protected credential storage | Implemented — vault (`host/mumachine/src/vault.rs`, local source reference) | macOS Keychain; unsupported platforms refuse secure storage |
| F-006 | Private profile metadata and transaction locking | Implemented — profiles (`host/mumachine/src/profiles.rs`, local source reference) | Metadata contains no credential; normal failures compensated |
| F-007 | Restore, switch and forget connections | Implemented — UI (`host/mumachine/src/ui.rs`, local source reference) | Forget is local removal, not server revocation |
| F-008 | Boot/orient and accessible roster display | Implemented — client (`host/mumachine/src/client.rs`, local source reference) | Registry context, not runtime launch or idle receive proof |
| F-009 | Explicit app check-in after revalidation | Implemented — client (`host/mumachine/src/client.rs`, local source reference) | Reports this app's seat/harness-unknown metadata only |
| F-010 | Bounded Herdr agent-list discovery | Implemented — discovery (`host/mumachine/src/discovery.rs`, local source reference) | Name/kind/state, not a verified desktop-session binding |
| F-011 | Installed application bundle discovery | Implemented — discovery (`host/mumachine/src/discovery.rs`, local source reference) | Installation does not imply running, connected or supported control |
| F-012 | Native four-page UI, themes, text scaling and labels | Implemented — UI (`host/mumachine/src/ui.rs`, local source reference) | Accessibility tests and historical visual checks are scoped evidence |
| F-013 | Offline labeled demo and launch options | Implemented — main (`host/mumachine/src/main.rs`, local source reference) | Demo disables live network, discovery, profile and Keychain access |
| F-014 | Cancellation and stale-result fences | Implemented — device (`host/mumachine/src/device.rs`, local source reference), UI (`host/mumachine/src/ui.rs`, local source reference) | Late responses cannot change the current operation |
| F-015 | Local macOS development bundle and ZIP | Implemented — bundle script (`host/mumachine/scripts/bundle-macos.sh`, local source reference) | Ad-hoc signature; no installer, automatic launch or notarization |

## Operator foundation — proposed 0.2.0

| ID | Capability | State / dependency | Completion evidence |
| --- | --- | --- | --- |
| F-020 | View-independent host-state engine | Planned | Deterministic session/operation state under UI changes; restart durability is F-030, and no daemon install is implied |
| F-021 | Read-only inventory of individual desktop working sessions | Contract-dependent — harness adapter | Two concurrent sessions distinguished by observed route, not app name |
| F-022 | Authorized Mupot-agent/project-to-working-session association | Contract-dependent — Kasra + Dara | Exact actor, scope and route verified without global connector rebinding |
| F-023 | Handoff from the existing ingress owner to Rust | Contract-dependent — Dara | One consumer/owner; explicit acceptance and failure behavior |
| F-024 | Codex existing-session inbound operator request | Contract-dependent — Codex adapter | Intended session consumes a bounded request; wrong destination refused |
| F-025 | Correlated operator response and artifact return | Contract-dependent — Mupot receipt contract | Original developer/work item receives the actual result, not a generic success |
| F-026 | Busy/paused/disconnected pending-work handling | Planned | No interrupting unrelated work; pending responsibility is explicit |
| F-027 | Supported harness controls | Contract-dependent | Each advertised interrupt/resume/control action has a version-specific test |
| F-028 | Agent/project/squad filtering and status presentation | Planned | Multiple agents in one harness remain distinguishable without leaking other scopes |

## Resilience and capacity — proposed 0.3.0

| ID | Capability | State / dependency | Completion evidence |
| --- | --- | --- | --- |
| F-030 | Durable intake, restart recovery and deduplication | Planned | Restart at each boundary preserves pending work without duplicate effects |
| F-031 | Current route generation, assignment and ownership fencing | Contract-dependent | A stale or returning old worker cannot acquire a second writer role |
| F-032 | Observed harness version/model/activity reporting | Planned | Report identifies source, timestamp and confidence; unknown stays unknown |
| F-033 | Provider-reported account usage/reset collection | Contract-dependent — per harness/provider | No substitution of scrollback estimates or context tokens for quota |
| F-034 | Shared account/quota failure reporting | Contract-dependent — Kasra | Correct affected-agent set; unrelated buckets remain available |
| F-035 | Safe diagnostics and redacted support export | Planned | Useful problem evidence without credentials or private conversation content |
| F-036 | Meaningful attention/status updates across existing surfaces | Planned integration | Mupot web, preferred agent and Mubot distinguish pending, consumed, review and accepted |

## Additional adapters and continuation

| ID | Capability | Proposed window | Dependency / evidence |
| --- | --- | --- | --- |
| F-040 | A second desktop harness adapter | 0.4.0, contract-dependent | Select from actually supported Cursor/Claude/Grok interfaces; separate conformance |
| F-041 | Mac/VPS interoperability and version-aware handoff | 0.4.0, planned | Effective installations, routes and ownership are independently verified |
| F-042 | Linux and Windows user distribution | Candidate; no fixed release | Secure vault, platform control, packaging and accessibility proof on each OS |
| F-043 | Artifact-backed checkpoint and continuation packet | 0.5.0, planned | Current artifacts/decisions/next action survive loss of the original model session |
| F-044 | Policy-authorized continuation in another harness | 0.5.0, contract-dependent | Reconcile effects and transfer ownership; no silent impersonation or duplicate writer |
| F-045 | Opt-in background/start-at-login operation | Candidate for user-release train | Explicit install/uninstall, service ownership, observability and rollback contract |
| F-046 | Signed/notarized supported-user release | 1.0.0 target | Reproducible artifacts, declared platforms, approved release and restore procedure |
| F-047 | Guided eligible-agent selection with minimal technical input | 1.0.0 target | Real users can reuse an authorized identity without entering UUIDs unnecessarily |
| F-048 | Repeatable multi-user/multi-project onboarding | 1.0.0 target | Users remain isolated while contributing across authorized project memberships |
| F-049 | Compatibility-aware updates and safe rollback | Candidate | No silent consumer replacement, destructive state downgrade or unexpected privilege grant |

## Existing dependencies, not new Rust features

Mupot's organization, OAuth/consent, squads, project access, tasks, flights, artifacts, verdicts, Co-Pilot, Studio, Needs You and Telegram channel infrastructure are not being reinvented. Seatlink's Herdr notifications and the existing Codex receiver/plugin work are separate existing integrations, not features already delivered by `mumachine`.

Their current operational state must be verified through their own sources. See [Integrations](INTEGRATIONS.md) and [Sources](SOURCES.md).

## Explicit exclusions

- No replacement LLM runtime, model subscription, or credential broker is included in this roadmap.
- No automatic quota-credit purchase, account reset, spending, publication, deployment or grant expansion.
- No promise that every desktop application's undocumented interface can be fully controlled.
- No automatic transplant of hidden model state or complete private chat history.
- No new SSE/poll consumer for an inbox identity already owned elsewhere without a reviewed ownership migration.
- No new dashboard replacing Mupot's existing web application.

## Change procedure

For each new feature, record an ID, user outcome, evidence state, owner/dependency, acceptance test, data/permission impact, proposed release, and rollback consequence. Promote it to Implemented only with source evidence; promote it to a supported release only with the applicable runtime and release gates. Remove or defer scope explicitly, preserving the decision history.

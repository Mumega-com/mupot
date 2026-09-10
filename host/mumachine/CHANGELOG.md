# Mupot Connect changelog

This changelog covers the `mumachine` Rust application and its documentation, not the Mupot server or Herdr plugins. Application version is currently **0.1.0**. See the [roadmap](ROADMAP.md) for unimplemented future features.

## Unreleased

### Documentation

- Added a master software documentation set covering current behavior, target product, feature catalog, architecture, integrations, user journeys, operations, security/privacy, testing/acceptance, development process, decisions, sources, and proposed versioning.
- Preserved the full Mupot-distributed opinion and Dara/Kasra feedback as an immutable research copy, with later clarifications recorded separately.
- Distinguished the current onboarding preview from the planned desktop operator host and kept Mupot, seatlink, and application version tracks separate.

No runtime behavior, credential, service, server schema, application version, or release status changed with this documentation work.

## 0.1.0 — 2026-09-09 — local developer preview

### Added

- Standalone Rust core crate and native eframe/egui application (`0906412`, `40c2ec2`, `6ea270c`).
- Exact-agent browser device approval, bounded HTTP, identity/tenant verification, expiry and cancellation state, and boot/orient display.
- App-owned macOS Keychain credential storage, private saved-profile metadata, and explicit check-in of the app.
- Read-only Herdr discovery, known installed app inventory, labeled offline demo, theme/text controls, and local macOS bundle/ZIP packaging.

### Corrected before preview handoff

- Bound onboarding to the original requested identity and challenge timeline; rejected non-success redemption and stale results (`a7ec16c`).
- Added profile transaction coordination and normal-failure compensation; tightened exact UUID onboarding and safe saved-profile switching (`a7ec16c`, `32ea72d`).
- Documented startup profile-contention recovery (`243c1e5`) and scoped verification/release limitations (`2597ad9`).

### Evidence and limitations

The [September 9 verification record](VERIFICATION.md) records 31 core tests, 9 UI tests, 2 compile-fail doctests, formatting, linting, local build/review and artifact checks. These are historical results at the documented source, not a fresh test run implied by reading this changelog.

The preview was locally ad-hoc signed, not Developer ID signed or notarized. No production enrollment or real Keychain round trip was claimed. Desktop inbox delivery, harness control, account telemetry, background service, and automatic recovery were not included.

## Before 0.1.0

Earlier Rust-host, exact Codex receiver, Herdr/seatlink and telemetry efforts are separate historical projects, not earlier `mumachine` releases. Their evidence and applicability are mapped in [Sources](docs/SOURCES.md). Do not fabricate an application release history from those project milestones.

# Mupot Connect v0.1 Implementation Plan

> Use subagent-driven-development for execution; user has authorized this local build.

**Goal:** Deliver a launchable Rust app with truthful runtime/agent views, secure browser device enrollment, Keychain storage and verified Mupot boot context.
**Architecture:** Rust library plus native eframe UI; reuse existing Mupot HTTP device and action endpoints. No server change or daemon activation.
**Spec:** ../specs/2026-09-09-mumachine-desktop-v01-design.md

## Global constraints

Preserve all other WIP and shared connectors. No production token/grant/agent changes during development. No live enrollment/check-in during verification. All secret handling stays in memory/Keychain with redacted errors. Fixed endpoint/tool allowlist, HTTPS/identity/same-origin validation, no redirects. No falsely booted runtime or receive-ready badges. Tests must prove behavior rather than source text. Keep one writer at a time for a file; workers do not delegate or review themselves. Local commits allowed; no pushes/merges/deployments.

### Task 1: Tested onboarding core

Ownership: `host/mumachine/Cargo.toml`, Cargo.lock, `.gitignore`, `src/lib.rs`, `src/model.rs`, `src/client.rs`, `src/device.rs`, `src/vault.rs`, `src/profiles.rs`, `src/discovery.rs`, and core/integration tests. No UI/main/bundle files.

Read the spec. Implement a small robust core and publish public API in the report for the UI worker. Put meaningful security/device/client tests first, run RED, then implement and run GREEN. Cargo library tests should compile independently before UI exists. Use `cargo test --lib`/integration test with no live network beyond dependency fetch.

Required capabilities: validated PotOrigin; redacted Secret; typed public Health/Agent/BootSnapshot; synchronous bounded MupotClient health/start_device/poll_device/boot/check_in (boot validates identity); device pending/expiry polling state; macOS credential vault; owner-only metadata repository with no plaintext secrets; read-only Herdr/app discovery with timeout and output bound. Prefer `/actions/boot_context`, `/actions/orient`, `/actions/check_in` after inspecting server route shapes. Existing device endpoints are `/device/code` {agent} and `/device/token` {device_code}, raw JSON response. Verify returned token_type and expiry; exact requested UUID must agree with redeemed agent and boot/brief (name-based enrollment removed after cross-squad ambiguity review). BootSnapshot includes actual agent/squad/name/tenant/channel/brief/roster and safe public verification state. Do not expose raw server errors. No generic arbitrary MCP method.

Device flow API must let UI begin once, poll only when due, cancel, and receive a verified connection without saving stale results. Use opaque operation generations so cancel/change-origin/forget invalidates background completions. Persist verified tokens only on accepted UI result, never automatically inside uncancellable HTTP work. Document precise types/signatures in report.

Core tests include actual local TCP fixture interaction for paths/header/no redirect/malformed/oversize/identity refusal; redacted Debug; no secret serialization; profile symlink/permission/write failure handling and app-only forget via test vault; discovery failures don't fabricate runtimes. No real keychain or bot/agent mutation. Provide safe fixtures not actual private identifiers.

Report test evidence, public API and concerns, commit owned files.

### Task 2: Native desktop interface and app bundle

Ownership: `host/mumachine/src/main.rs`, `src/ui.rs` or `src/ui/*`, bundle script, Info.plist/icon assets, README; Cargo UI dependencies/binary declarations with coordination after Task1. No security core changes without request to core owner.

Build eframe0.36.2 (App trait uses ui, inspect cached docs) window with sidebar Network, Connect, Boot context, Activity. Dark slate/emerald accent; optional light theme, comfortable spacing, clear type hierarchy, native keyboard buttons. Use current real discovery by explicit refresh and clearly separate registry agents and local runtimes. Default disconnected state should still show local agents and onboarding CTA; don't fake online data. A clearly marked Demo mode may illustrate fake agent cards for offline QA but cannot use real network/Keychain.

Implement wizard endpoint/tenant/exact agent UUID -> user code/browser approval -> validation -> connected. Explain where to copy the existing agent ID; name-only enrollment awaits server ambiguity repair. Background workers and UI-safe operation generations must keep UI responsive; disable duplicate action, honor cancel and expiry, use no automatic device-code restart after failure. Same-origin browser URL only. Never display/copy device_code/access_token; display only user_code. Buttons load saved profile, refresh verified boot, check in this app explicitly, forget only app connection, show read-only brief with no execution. Show runtime receive not enabled. Checkin only after reproof; directory state not admin. Credential saving occurs only for current successful operation, and UI must report storage failures truthfully. Persistent profiles provide reconnection after restart with locally enforced expiry; stored expired tokens not silently used.

Bundle release executable into local `dist/Mupot Connect.app`; provide a reproducible build command and no installation under /Applications. Use official eframe screenshot mechanism or native UI for QA, never capture other apps. No screenshot of entered live secrets. Add focused UI-state tests for stale worker results, cancellation/forget and connected label truthfulness if not already in core. Run fmt/test/clippy/release build. Report and commit owned files.

### Task 3: Independent integration/security and visual gate

Controller produces whole diff and test evidence; independent reviewers evaluate source/behavior against spec. Cover credential/exfiltration boundaries, app-only storage, TLS/redirect, malicious metadata, identity mismatch, stale callbacks, actual boot semantics, keyboard/error states and screenshots. Assign fixes to original owner and re-review changed code. Open the final app locally and provide .app/source/README and exact verified limits. No network credential use required for demonstration; real enrollment is a later explicit user action in app.

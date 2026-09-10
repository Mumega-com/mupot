# Mupot Connect operations

This runbook covers the current 0.1.0 local macOS developer preview. It is a manually launched foreground application, not a daemon, login item, auto-updater, inbox receiver or fleet controller. Product-wide architecture and integration ownership are documented in the [master guide](MASTER.md); planned work belongs in the [roadmap](../ROADMAP.md), and shipped changes in the [changelog](../CHANGELOG.md).

## Build, run and package

Development requires a current stable Rust toolchain and macOS build tools. The built application has no Node.js or Python runtime dependency.

Operational sources are the Cargo manifest (`host/mumachine/Cargo.toml`, local source reference), bundle script (`host/mumachine/scripts/bundle-macos.sh`, local source reference), profile repository (`host/mumachine/src/profiles.rs`, local source reference) and Keychain vault (`host/mumachine/src/vault.rs`, local source reference).

```sh
cd host/mumachine
cargo run --features gui
```

For safe UI inspection without network, discovery, profiles or Keychain access:

```sh
cargo run --features gui -- --demo
cargo run --features gui -- --demo --page=connect --compact --light
```

The supported local packaging path is:

```sh
sh scripts/bundle-macos.sh
open "dist/Mupot Connect.app"
```

The script performs a locked release build, creates the `.app`, generates its icon, applies an ad-hoc signature, verifies that signature and creates a zip. It deliberately does not install into `/Applications`, launch the app, create a startup entry or change any service.

## Verification and safe diagnostics

Run checks from `host/mumachine`:

```sh
cargo fmt --check
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release --features gui
codesign --verify --deep --strict --verbose=2 "dist/Mupot Connect.app"
```

`herdr agent list` is the same read-only class of runtime discovery the app attempts, with a three-second app-side bound. It is safe for diagnosis but may expose local agent names and states, so sanitize captured output. Do not run an inbox, prompt, install, enable, send, mint, revoke or configuration command as a “diagnostic.” Do not inspect or export Keychain values.

The recorded 2026-09-09 review reported 31 core tests, 9 UI tests and 2 compile-fail doctests passing, plus formatting, clippy, release build and ad-hoc signature checks. Those are historical results, not a claim about the current checkout; see [verification evidence](../VERIFICATION.md) and the durable [acceptance guide](TESTING_AND_ACCEPTANCE.md). Live enrollment and Keychain integration were not exercised by the development agents.

Useful interpretation rules:

- Public health proves reachability and server metadata, not agent authentication.
- Herdr output proves only what that local command observed, not Mupot identity or inbox readiness.
- Boot and check-in prove this app's bound identity/presence, not model launch, task consumption or completion.
- A local bundle, zip or passing test does not prove distribution signing, deployment or installation.

## Local data and action boundaries

Public profile metadata is stored in the current user's Mupot Connect Application Support area with owner-only permissions and bounded, atomic writes. It includes origin, tenant, exact agent identity/slug and expiry—not a token. Credentials live separately in an app-specific macOS Keychain service, keyed to the origin and exact agent. Build caches and package outputs stay under the crate's `target` and `dist` directories and can be regenerated.

Never copy profile or Keychain material into source control, logs, tickets or support messages. Never borrow OAuth/session secrets from another desktop harness. Normal save/forget failures are compensated, but Application Support and Keychain are separate stores; a process crash is not a cross-store transaction guarantee. The app rejects unsafe ownership, permission, symlink and hard-link conditions rather than repairing them automatically.

Consequential actions remain outside the read-only diagnostic workflow: live approval, server revocation, role/capability changes, inbox consumption, harness control, service changes, deployment, production signing-identity use, notarization and distribution require their owning workflow and authorization. The documented local development bundle's ad-hoc signature is not production signing. See [Security and privacy](SECURITY_AND_PRIVACY.md).

## Coexistence and single-owner rule

Mupot Connect v0.1 does not manage existing bridges. Current operational inventory says the Mac seatlink 0.2.1 is under launchd with one `--serve` owner and no `[[startup]]` entries; Mupot Connect also has no startup entry. The older Herdr bridge is installed but disabled. A VPS-side 0.3.1 component is separate and unverified from this Mac. Recheck these volatile states in their owning surfaces before any change.

For each canonical inbox or explicitly authorized partition, designate exactly one consumer; different seat labels do not create separate ownership. Do not enable the older bridge beside seatlink, add Mupot Connect as another receiver, or change a VPS watcher merely because the desktop app discovered a runtime. Ownership must be transferred deliberately under a reviewed handoff, with the former owner fenced/stopped as required, durable cursor/state preserved, and receipt semantics independently accepted. This preview provides none of those controls.

## Manual upgrade and rollback

There is no automatic update channel. Treat each bundle as a manually reviewed artifact:

1. Record the source revision, checks and artifact hash. Keep the prior `.app`/zip as a recoverable artifact.
2. Quit the app before switching versions for predictable operator behavior. Packaging uses atomic executable replacement, so a still-running preview continues its old process until it exits.
3. Replace only the application bundle. Preserve the per-user Application Support data and app Keychain items; an application replacement is not an instruction to forget or revoke profiles.
4. Launch the new version and explicitly **Load and verify** the chosen profile. Recheck identity, tenant, boot context and the visible “receive not enabled” boundary.

For rollback, restore the prior bundle while leaving forward profile state untouched. Current metadata is strict: an older build may refuse a future schema rather than safely downgrade it. If that occurs, do not edit/delete metadata or Keychain items to force compatibility; stop using the old build, retain the newer state, and return to the compatible version. Exercise a rollback build in demo mode when identity verification is not required.

Future background-service releases must define install/uninstall, startup ownership, health, upgrade fencing, state migration and rollback before activation. They must adopt—not compete with—the designated inbox owner.

## Platform and release limits

The current bundle declares macOS 12.0 minimum. The 2026-09-09 artifact was built and inspected as a local macOS arm64 preview. Source portability does not equal product support: secure persistent credential storage intentionally returns unsupported outside macOS, and the bundle script is macOS-only.

Ad-hoc signing proves local bundle integrity only. It is not Apple Developer ID signing, notarization, Gatekeeper distribution acceptance, universal-binary validation or a production release. Those remain explicit release gates, along with live nonproduction enrollment/Keychain testing and the broader items in [Feature status](FEATURES.md).

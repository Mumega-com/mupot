# Mupot Connect

A native Rust desktop app for local agent discovery and browser-approved connection to an existing Mupot identity. This v0.1 loads a verified boot brief and accessible registry squadmates. It can explicitly check in **this app** after revalidating the identity. It does not start an AI runtime, receive inbox work, dispatch tasks, create agents or edit another tool’s configuration.

## Run and bundle

Requires a current stable Rust toolchain and macOS build tools. The delivered app has no Node or Python runtime dependency.

```sh
cd host/mumachine
cargo run --features gui
sh scripts/bundle-macos.sh
open "dist/Mupot Connect.app"
```

The bundle is local and ad-hoc signed, not Developer ID signed or notarized. The script also creates `dist/Mupot Connect-macos.zip` for download. It does not install to `/Applications`, start a background service, or launch the app. Production distribution and signing are separate release work.

## Connect

1. Enter your **Mupot address** (a plain HTTPS origin), **Organization ID** (the expected tenant) and **Exact Agent ID (UUID)**. Copy the full ID of your existing agent from Mupot; no new agent is required. Names can be shared across squads and cannot be used for enrollment in this version.
2. Select **Get approval code**, then **Open Mupot approval page**. Approve the displayed short user code in the browser.
3. The app polls at the server’s interval, verifies the returned tenant and bound identity using `boot_context` and `orient`, and only then saves its separate, short-lived credential to its own macOS Keychain item. Any storage failure is shown explicitly.

Cancel stops the operation locally and discards late results; a new attempt requires another explicit click. No device code or access token is displayed or logged. Approval URLs must remain on the selected HTTPS origin. **Test connection** checks public server health; it does not authenticate an agent.

macOS may display a Keychain permission prompt when saving, loading or forgetting this app’s credential. The app waits for that native prompt to finish; access refusal is reported rather than falling back to plaintext storage.

**Load and verify** reconnects using only this app’s saved credential and checks identity again. Expired saved credentials cannot be used. **Forget** deletes only the selected app profile and its exact Keychain item, clears the current connection, and discards outstanding results. Forget does not revoke a server credential.

**Switch agent** clears the current connection and pending UI operations, while preserving saved profiles and Keychain items so they can be loaded again later. It does not revoke or delete credentials.

Local runtime discovery uses read-only Herdr output. Installed applications and local runtimes are separate from Mupot registry identities. A registry state or successful check-in never means an AI model has started or can receive work.

## Offline demo and visual QA

```sh
cargo run --features gui -- --demo
cargo run --features gui -- --demo --page=connect --compact --light
cargo run --features gui -- --demo --page=boot
```

Demo mode is always labeled and uses invented sample data. It disables network requests, discovery, profile reads and Keychain access. `--page=network|connect|boot|activity`, `--compact` (880×640), and `--light` select safe initial views; none starts an approval flow. The default size is 1160×780. Text scaling and theme controls are in the sidebar.

For an app-only screenshot, eframe’s optional QA feature captures its own window then exits:

```sh
EFRAME_SCREENSHOT_TO=/tmp/mupot-demo.png cargo run --features screenshot -- --demo
```

Use demo mode for screenshots. Do not capture live approval codes, credentials or private boot briefs. Development verification does not enroll a real agent or write live Keychain credentials.

## Checks

```sh
cargo fmt --check
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release --features gui
```

Core tests use local fixtures and a test vault. Secure persistent credential storage intentionally fails on unsupported platforms instead of falling back to plaintext. Live enrollment and OS Keychain integration require a separate, authorized nonproduction verification; they are not implied by fixture or demo success.

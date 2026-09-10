# Mupot Connect native Rust app v0.1

User-authorized build: a Rust desktop app that shows agents, securely onboards an existing agent and loads its boot context from Mupot. Native macOS first, source portable where practical. Implements the onboarding slice of the Hadi-CC desktop plan, not its entire swarm daemon.

## Product behavior

- Launchable native window named Mupot Connect, default 1160×780, usable at 880×640, light/dark themes, calm slate/emerald palette, readable 16px body, text labels and keyboard-operable controls.
- Home shows locally detected Herdr runtimes (read-only `herdr agent list`) and installed supported desktop apps with honest labels. It must distinguish a local runtime from a verified Mupot agent. No fabricated online roster or sample data unless explicitly labeled Demo mode.
- Connect wizard: select an HTTPS Mupot origin and expected tenant, enter the existing agent's exact UUID, begin the server's existing device code flow, display the short user code and expiry, open the same-origin `/device` browser page, poll at the advertised interval, permit cancellation, then verify the returned identity through boot_context and orient. Names remain display labels; server name lookup is currently ambiguous across squads, so name-based enrollment awaits server repair.
- A browser approval issues a short-lived device credential for an existing agent. App does not create agents, elevate roles, change caps, or modify any existing ChatGPT/Claude MCP config. Do not call live device enrollment during development; exercise it against a fixture server until the user clicks it in the delivered app.
- Store a verified credential only after identity/tenant checks, in macOS Keychain under app-specific service + origin/agent account. Public profile metadata is owner-only, atomic, and contains no token/device_code. No automatic reads of other tools' credential files. Non-macOS credential storage must fail explicitly rather than fall back to plaintext.
- Connected view shows the actual bound agent, squad, tenant, channel, loaded boot brief and accessible squadmates. Label registry state separately from local runtime state. Do not infer target authority from orient's capability display (#1356).
- Explicit Refresh boot fetches fresh boot_context and orient. Explicit Check in records presence of this app only, after revalidating the same tenant/agent; do not claim the model/runtime is launched or can receive. Runtime receive and swarm dispatch remain visibly not enabled.
- Forget connection removes only this app's Keychain item/profile, clears in-memory secrets and current verified state, and explains it does not revoke the server credential; no broad Keychain deletes.
- Public health check, demo/fixture mode and local discovery work without credentials. Fixture mode is visibly separate and never leaks fixture credentials to a real server.

## Security contract

- TLS verification on, production HTTPS only; reject URL userinfo/query/fragment/path ambiguity and redirects. Cross-origin verification_uri rejected. Test-only loopback HTTP construction cannot be enabled through normal profile/UI input.
- Bound every request (timeouts, response body size), handle JSON and Mupot envelopes; use fixed endpoints and fixed MCP tool allowlist only. No generic arbitrary-tool execution.
- Device code and access token implement redacted Debug and zeroization on drop; own secret staging buffers also zeroize. Do not claim control of unavoidable HTTP/TLS library buffer copies. Never print raw HTTP bodies/error details that could contain secrets. No tokens in URLs/command args/logs/profile.
- Poll interval respected; expire locally; handle pending/denied/expired/slow-down/malformed/error status safely; only 2xx can yield a token. Bound redeemed credential expiry against the original challenge-request timeline because the existing server returns a constant lifetime after delayed redemption. Cancellation prevents stale results being applied or saved.
- Desired agent, redeemed agent, boot bound ID, orient agent ID/slug and expected tenant must agree. Identity mismatch or non-minted/unbound credentials fail closed. Directory channel may load read context; it must not be presented as elevated authority or a persistent per-task binding.
- App has no always-on service, no inbox consumer, no launch/stop agent command, and no privileged APIs in v0.1. No production migration/merge/deploy or account grant changes are part of this build.

## Architecture

Crate `host/mumachine` with Rust library for security/client/device-state/discovery/profile storage, eframe/egui native UI, and small macOS bundle script. Use eframe 0.36.2, reqwest 0.13.5 blocking client on background workers, serde/serde_json, URL validation, zeroize and macOS security-framework 3.7.0. Keep the native UI separate from tested domain code. No runtime Node/Python requirement for end users.

Root controls Cargo.toml/public interface decisions via task ownership. No server TypeScript changes. App bundle is local and unsigned/ad-hoc for testing; distribution signing/notarization stays a later release step.

## Verification

Rust tests must demonstrate rejection of insecure/cross-origin endpoints; token redaction; device expiry/cancel/stale-result behavior; identity mismatches; bounded malformed/error responses; actual request paths and headers through a local TCP fixture; public profile contains no secret; exact app-only forget behavior using a test vault. Keychain OS integration requires a dedicated nonproduction test item, never a real user's existing key. UI must be launched and visually checked. Check release build, rustfmt and clippy. Independent security/spec and final UI review before handoff; no claim of live enrollment success without a real user-approved round trip.

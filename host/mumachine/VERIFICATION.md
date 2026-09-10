# Local developer preview verification

Date: 2026-09-09 America/Toronto.
Rust implementation reviewed at `32ea72d` (core fixes `a7ec16c`); later `243c1e5` changes README only.

## Verified

- Root fresh `cargo test --all-features`: 31 core tests, 9 UI tests and 2 compile-fail serialization doctests passed.
- Root fresh `cargo clippy --all-targets --all-features -- -D warnings` and `cargo fmt --check`: passed.
- Release build and local macOS arm64 application bundle created. Root `codesign --verify --deep --strict --verbose=2` reported valid on disk and satisfying its designated requirement. This is ad-hoc signing, not Developer ID/notarization.
- Native launch of the preceding preview showed nine real Herdr runtimes and explicitly disconnected Mupot state. Its HTTP/path input rejection was observed. The user then began interacting; the application was left running and subsequent packaging used atomic executable replacement.
- Dark/light and compact/default demo screenshots were inspected. Later field labels and Switch agent behavior were checked through headless UI/AccessKit tests and source review; the final bundle was not reopened over the user's active preview.
- Independent core review initially held six issues. Corrections were re-reviewed and passed: exact UUID enrollment, original-challenge expiry bounds, successful HTTP status for redemption, accurate secret-buffer handling, interprocess profile transactions/forget compensation, and complete known Grok Bot/Antigravity discovery.
- Separate UI gate passed. Final independent whole-branch source review passed for a local developer preview, with no remaining concrete release-blocking finding.

## Artifact fingerprints

- `dist/Mupot Connect-macos.zip`: SHA-256 `f338a81c94dea6d64180bacad88a1054d285ce5b85146f46c798cf7d781c4233`.
- Ad-hoc signed `dist/Mupot Connect.app/Contents/MacOS/mumachine`: SHA-256 `a1a53ee64b444a9dc53b979fd4e899adf84966b25fc696aae8176076c525f6f6`.

## Limits

No real device grant, enrollment approval, credential refresh/check-in, or Keychain item was exercised by the development agents. OS Keychain and live enrollment remain a user-approved verification step. No server change, role/cap change, shared MCP configuration update, deployment or background inbox receiver was introduced.

Runtime discovery is not Mupot identity proof. Boot context and explicit app presence are not AI runtime launch or receive capability. The app requires an exact existing agent UUID because name lookup is currently ambiguous across squads. If profile loading meets transient storage contention at startup, restart after it clears; a dedicated reload control is a nonblocking follow-up.

The existing device approval protocol is reused rather than replaced. Own secret wrappers/staging buffers zeroize; the program cannot promise erasure of every HTTP/TLS/OS copy. Keychain and metadata are separate resources: normal failures are compensated, but process-crash recovery across both is not a transactional database guarantee. These are development-preview boundaries, not SOC 2 certification.

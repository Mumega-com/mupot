# Architecture

[Master documentation](MASTER.md) · [Integrations](INTEGRATIONS.md) · [Feature catalog](FEATURES.md)

## Scope and baseline

This document separates the **implemented 0.1.0 architecture** from the **planned desktop operator host**. It records boundaries, not approval to introduce a new daemon, identity type, or transport. The existing eframe application remains the baseline; no framework migration is planned here.

## 1. System context

| Component | Owns | Does not establish by itself |
| --- | --- | --- |
| Human | Purpose, account consent, project priorities, consequential-action authority | That every application on the machine is participating in every project |
| Mupot | Organization, agent identity, membership, work, dispatch policy, receipts, gates | That a locally running app is the intended receiving operator |
| Herdr and seatlink | Herdr seat discovery/events and the effective Herdr notification route | A generic route into every desktop application's conversations |
| Rust host, planned | Local desktop-session observation, approved handoff, adapter controls and reporting | Additional server authority or permission to consume an inbox already owned elsewhere |
| Desktop harness | Its model session, tools, permissions, application state, and supported control interface | Permission to present a different agent identity or override a project assignment |
| Provider/account | Reported model capacity, usage limits, reset windows and service availability | The status of a particular Mupot task or the correctness of its output |

The common developer–operator path is a project contribution moving between existing working environments. Neither the CLI agent nor the desktop operator must acquire the other's credentials to request its contribution.

## 2. Implemented code map

```text
host/mumachine/
  src/main.rs       native window and launch flags
  src/ui.rs         four-page UI, background jobs, operation-generation fences
  src/model.rs      validated origin, domain records, errors, redacted secrets
  src/client.rs     bounded fixed-endpoint HTTP client and identity validation
  src/device.rs     device-approval state machine and cancellation/expiry
  src/discovery.rs  installed-bundle inventory and bounded Herdr agent-list read
  src/profiles.rs   private public-metadata storage and cross-process locking
  src/vault.rs      app-specific Keychain abstraction; no plaintext fallback
  src/tests.rs      core fixture tests
  assets/          application metadata
  scripts/         local macOS bundle creation
```

The library uses blocking HTTP on background workers; the UI receives results through events and rejects late/stale operations. Domain logic can be tested without opening a native window. The default feature set is empty; the executable requires the `gui` feature.

### Actual data model

The current `LocalRuntime` carries name, kind, and state. `InstalledApp` carries name and path. Neither is an authenticated Mupot agent binding or a desktop conversation record. `DiscoverySnapshot` separates the Herdr discovery status from the returned app/runtime lists.

`VerifiedConnection` holds the app's private credential, origin, verified boot snapshot, and expiry. Its secret is not serializable. A saved `Profile` contains origin, agent ID/slug, tenant, and expiry only. Multiple saved profiles are possible, but the current UI's selected connection is not a many-agent desktop router.

`BootSnapshot` holds the returned agent, squad, tenant, channel, brief, roster, and identity-verification outcome. It does not contain a runtime lease, desktop route, quota bucket, or proof of message handling. See model.rs (`host/mumachine/src/model.rs`, local source reference).

### Persisted data and retention

`profiles.json` is a JSON array of strict `Profile` objects, not a versioned server-session database. Each object has `origin: string`, `agent_id: string`, `agent_slug: string`, `tenant: string`, and `expires_unix: unsigned integer`. Unknown fields are rejected. Reads/writes are bounded to 100 profiles and 262,144 bytes. The app uses `.profiles.lock` and exclusive temporary files before a synced atomic replacement.

Credentials are stored separately under the app Keychain service `com.mumega.mupot-connect.credentials.v1`, with the account key derived from origin and agent ID. This service identifier is not a credential. Do not change it during a rename/update without a reviewed migration. Profiles remain until explicitly forgotten; expiry makes them unusable rather than silently deleting them. Activity is session-only and bounded to 40 messages. Future route, spool and observation storage needs a separately specified schema, retention and migration policy before use.

## 3. Implemented lifecycle

### Device approval

The app validates the input origin and exact agent UUID, requests a device challenge, and freezes origin/agent/start time/deadline into the pending operation. Only the same-origin device approval page is accepted. Polling honors the interval, increases delay when required, and stops on denial, expiry, cancellation, or invalid response.

A successful token response is insufficient: agent ID, slug, tenant, boot binding, and orient identity must agree before the app saves a connection. Lifetime is conservatively bounded against the original challenge timeline. Later UI operations cannot accept results from a superseded generation.

### Storage and reconnection

The profile repository uses owner-private files, strict field validation, bounded reads, symlink rejection for the opened resources, and a nonblocking transaction lock. Keychain and metadata updates have compensation on ordinary failures. They are not one crash-atomic database transaction.

Restoration uses only this app's saved credential and re-verifies the server identity. Switch clears the selected connection without deleting saved profiles. Forget removes only the exact app-owned profile/Keychain item; server revocation is separate.

### Discovery and check-in

Discovery looks for known app bundles and reads `herdr agent list` with a bounded process, timeout, and output size. It does not inspect another app's private conversation database or secrets. Explicit check-in revalidates identity and reports `mumachine` / `mupot-connect` / `unknown`; it represents the app, not an AI runtime launched by it.

## 4. Planned host decomposition

These are proposed responsibilities, not modules or APIs already implemented:

1. **Host state engine:** maintains observed harness/session inventory, pending handoffs, and recovery state independently of a particular UI view. Outliving a closed UI requires an explicit service-lifecycle design; 0.1.0 does not do so.
2. **Participation resolver:** composes authorized identity, project/assignment, observed destination, and approved route evidence. Reuse existing records first. It must not rebind a shared connector globally.
3. **Ingress handoff adapter:** receives work from the agreed existing ingress owner. Its protocol, authentication, acknowledgment, and durability boundary are contract-dependent.
4. **Desktop adapters:** implement only controls proven for the exact harness/version. Codex is the initial target; later adapters must pass their own conformance.
5. **Observation reporters:** publish measured status/version/model and available account-limit signals with provenance and freshness.
6. **UI projection:** presents the engine's state and allowed actions using the current app and existing Mupot interfaces. It is not a second work database.

The process boundary must be explicit before implementation. “Rust owns the host” does not mean it automatically owns every existing SSE stream or Herdr service.

## 5. Proposed delivery lifecycle

The following is an acceptance model, not the current Rust state machine:

| Stage | Required evidence | Interruption behavior |
| --- | --- | --- |
| Offered | Authorized work, intended recipient, correlation and current assignment | Invalid/ambiguous offers do not execute |
| Pending locally | Durable intake by the agreed owner before acknowledging its responsibility | Retain across restart; preserve ordering/correlation |
| Waiting for destination | Busy, paused, disconnected or explicitly unsupported state | Do not switch identity or start an unapproved replacement |
| Delivery attempted | Exact destination and current route/generation | An uncertain outcome requires reconciliation, not blind replay |
| Consumed | Harness-specific machine-observed proof under the approved receipt contract | Persist the evidence before later transitions |
| Responded | Correlated result and artifact references | Retrying publication must reuse the same logical result |
| Reviewed | Independent eligible verdict on the exact result/version | A changed artifact invalidates stale approval |
| Closed | Mupot's appropriate terminal state | Preserve history; completion does not imply deployment |

There is no promise of universal exactly-once effects. The target is durable, retry-safe processing with idempotency, explicit uncertainty, and no duplicate writer after recovery.

## 6. Identity and failure domains

Preserve the difference between human account, Mupot agent, credential session, seven-axis presence seat, flight runtime seat, desktop conversation, and provider quota bucket. A display label may identify a selection for the user; it must not authenticate the caller.

A provider/account block can affect multiple agents. A failure report should name its observed scope and freshness, allowing Mupot to identify affected consumers. Context usage is not a subscription quota. A missing usage field is not zero. The app must not infer a universal account failure from one tool or one model error.

## 7. Compatibility and extension

Adapters should expose supported operations and limitations separately from observed state. A harness may support inventory and status without reliable idle delivery; another may support controlled launch without attachment to existing conversations. UI actions must reflect that distinction.

For the initial desktop adapter, preserve the user's existing conversation and permissions. Document whether each entry point is supported, experimental, or unavailable. A public App Server capability is not evidence that the same connection controls an already-open desktop task. No unsupported private interface becomes a stable product promise merely because a local probe succeeded.

## 8. Unresolved architecture decisions

The binding/boot-attestation mechanism, ingress-to-Rust handoff, authoritative stream owner per identity, current external-runtime dispatch policy, exact consumption proof, and shared quota reporting contract remain open. See [Decisions and feedback](DECISIONS_AND_FEEDBACK.md). Implementing these requires a separately approved, testable interface specification.

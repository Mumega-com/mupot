# Security and privacy

[Master documentation](MASTER.md) · [Architecture](ARCHITECTURE.md) · [Testing and acceptance](TESTING_AND_ACCEPTANCE.md)

This document distinguishes the controls implemented in Mupot Connect v0.1.0 from requirements for a future desktop-to-runtime product. It is a design and operator reference, not a compliance certification.

## v0.1.0: implemented boundary

Mupot Connect is a foreground macOS developer preview for onboarding an existing Mupot identity into this app. It discovers installed apps and Herdr rows, obtains a browser-approved credential, loads boot context, and can check in **this app**. It does not start/control a model, consume an inbox, deliver prompts, operate a harness, grant capabilities, collect telemetry, or spend. See the [product boundary](../README.md) and [dated verification record](../VERIFICATION.md).

### Network and identity controls

- Only a plain HTTPS origin is accepted: no credentials, paths, query, fragment, ambiguous slash, whitespace, controls, or backslash. Redirects and system proxies are disabled; timeouts and a 1 MiB response limit apply (model (`host/mumachine/src/model.rs`, local source reference), client (`host/mumachine/src/client.rs`, local source reference)).
- The UI exposes only health, device authorization, `boot_context`, `orient`, and this app's `check_in`, not arbitrary actions or MCP methods.
- Enrollment requires the exact lowercase agent UUID and tenant. Redemption, minted `boot_context`, and `orient` must agree; a name/slug cannot substitute.
- The approval URL must be the selected origin's `/device`. Polling has a bounded interval, one in-flight request, slowdown handling, expiry/cancel stops, and stale-result fencing (device flow (`host/mumachine/src/device.rs`, local source reference)).
- Refresh, restore, and check-in re-prove identity. Check-in requires the expected agent and fixed `mupot-connect` seat. Health proves only reachability.

These checks prove that an app credential was bound to the requested logical Mupot agent. They do not prove which human authenticated, which provider account pays for a model, which Herdr seat should receive work, or which runtime is executing.

### Local secrets and metadata

The access token is stored in this app's macOS Keychain service, indexed by origin plus agent ID (vault (`host/mumachine/src/vault.rs`, local source reference)). Profiles hold only origin, agent ID/slug, tenant, and expiry. Secret types cannot be serialized, debug is redacted, and app-owned secret/staging buffers zeroize on drop. This cannot promise erasure of TLS, HTTP, OS, allocator, crash-report, or swap copies.

Profile storage enforces owner-only `0700`/`0600`, current-user ownership, symlink rejection for the opened final directory/metadata/lock resources, single-link files, and size/count bounds. It does not claim validation of every ancestor path against same-user tampering. Atomic, synced replacement and a nonblocking cross-process lock protect metadata/Keychain updates. Normal failures compensate the Keychain item; a crash cannot make Keychain and JSON one transaction (profiles (`host/mumachine/src/profiles.rs`, local source reference)).

**Forget is not revoke.** Forget removes only the selected app profile and its exact Keychain item, then clears this session. Switch Agent clears the session but preserves saved items. Neither invalidates the server credential. A server-revocation action is not implemented in this app's v0.1.0 UI; use the authoritative Mupot surface for revocation. Expired profiles are refused, but are not documented as automatically deleted.

### Discovery, UI, and logs

Discovery checks fixed app bundles and runs a resolved `herdr agent list` with no stdin, discarded stderr, a three-second timeout, 256 KiB limit, strict JSON, and process-group termination. Its rows are not identity or receive proof (discovery (`host/mumachine/src/discovery.rs`, local source reference)).

Demo mode disables network, discovery, profile reads, and Keychain. UI fencing rejects canceled, forgotten, switched, or superseded results. Activity retains at most 40 in-memory app messages and does not intentionally include the app's credentials, approval secrets, or raw HTTP error bodies. Public health tenant/version values are included as returned; Activity is not a general-purpose sanitization boundary for arbitrary server metadata. There is no product telemetry, analytics upload, persistent app log, or retention setting. OS/network/server logs are outside this claim; screenshots must exclude codes, private briefs, and credentials.

### Known limits

The bundle is ad-hoc signed, not Developer ID signed/notarized, and is not hardened against same-user malware. Secure persistence is macOS-only. Verification did not exercise a real grant, Keychain item, live check-in, or runtime route. There is no receiver lock, message spool, runtime adapter, revocation UI, quota enforcement, or consumer-ownership protocol. Tests imply no compliance or production-readiness claim.

## Future product: proposed threat model and required controls

The planned product connects many desktop agents/projects/squads to exact Herdr developer seats through Mupot, retaining the web UI and supporting a favorite agent or Mubot coordinator. This section is **future work**.

Four identities must remain distinct and auditable:

1. **Logical agent**: the Mupot identity receiving policy, tasks, and evidence.
2. **Authenticated human**: the person approving enrollment or a consequential action.
3. **Provider account**: the model/vendor account that owns subscription, quota, or spend.
4. **Seat route**: the exact host, Herdr process, harness, and desktop task that may consume work.

Authentication is never a caller-supplied agent UUID. Where the existing consent policy allows it, one human login may authorize several separately bound seats; the current shared directory grant must not be assumed to confer that authority automatically. Favorite-agent choice is preference, not capability; Mubot must not become a second consumer or an implicit privileged executor.

Threats include cross-tenant/wrong-squad routing, stale or wrong desktop targets, crash replay, dual consumers, same-user state/IPC tampering, untrusted text becoming privileged instructions, confused-deputy logins, credential extraction, forged completion, and unbounded spend.

Required controls are:

- an approved identity/route association using the existing server and host proof contracts, covering tenant, agent, authorized project/squad, host/harness, public route, protocol/build, generation and sender policy; the exact mechanism is D-001, and private desktop task/route identifiers stay local rather than becoming server credentials;
- fresh boot and host proof before each receive session, with expiry/revocation checked before consumption and before effects;
- exactly one consumer lease per resource and a resource-level single writer for configuration, inbox cursor, pending effect, and result;
- a documented delivery/recovery state machine with durable pending responsibility, idempotency and quarantine after ambiguity; final transition/schema names belong to the approved integration contract rather than this threat-model summary;
- fixed trusted framing that labels external bodies as untrusted data, never inserts them into a privileged system/developer prompt, and never permits them to change approvals, credentials, routing, or tool policy;
- no credential extraction from Codex, Herdr, providers, or other apps; only an app-scoped secret and supported IPC contract;
- separate receipts for transport acceptance, exact runtime consumption, execution, artifact/result, independent review, and operator-visible delivery. One receipt cannot stand in for another;
- separate server revoke, local Forget, and route disable actions and evidence;
- provider-reported quota visibility where supported, correct account/bucket failure scope, and the existing Mupot budget/authority enforcement before dispatch; read-only usage APIs are not reservation APIs and the host cannot promise to enforce a vendor's quota. Spending, reset-credit use and consequential actions remain within explicit approved policy, with no automatic purchases or silent quota sharing.

Future logs must be structured, redacted, bounded, and split between local events and server audit receipts. Record identifiers/digests, transitions, decisions, and times—not credentials, cookies, keys, approval codes, or full prompts by default. Retention/export/deletion/legal-hold policy and message-body expiry must be explicit before production, including secure-deletion limits.

## Ownership and unresolved integration contract

The Herdr/seat link is external. The Mac seatlink manifest is described as version 0.2.1 under launchd with one `--serve` owner, no `[[startup]]`, and the old bridge disabled; the VPS seatlink uses a separate 0.3.1 installation. These are plugin versions, not Herdr versions. Server boot binding/dispatch/results are separately owned, and exact host proof is unresolved. Do not add a second consumer, infer control from discovery, or ship receive until one compatible contract exists.

# Testing and acceptance

[Master documentation](MASTER.md) · [Security and privacy](SECURITY_AND_PRIVACY.md) · [Operations](OPERATIONS.md)

This document records the v0.1.0 test surface and defines future acceptance work. Historical evidence is not current execution evidence, and future vectors are specifications rather than passing tests.

## v0.1.0 test inventory

The [verification record](../VERIFICATION.md) reports 31 core, 9 UI, and 2 compile-fail tests passing on 2026-09-09, plus format, clippy, release build, bundle, signature, screenshot, and review checks. They were not rerun for this documentation change.

The 31 tests in core tests (`host/mumachine/src/tests.rs`, local source reference) cover:

- HTTPS parsing, secret redaction, fixed paths/headers, health, redirect refusal, response/error bounds, and same-origin device approval;
- exact UUID/tenant/minted agreement across redemption, `boot_context`, and `orient`; bearer/expiry and pending/slowdown/denial behavior;
- interval, one-in-flight, cancellation, original expiry, stale completion, and cross-origin fencing;
- secret-free owner-only profiles, symlink/hardlink defenses, bounded atomic writes, compensation, and nonblocking process locks;
- re-proof before restore/refresh/check-in, exact check-in seat, bounded Herdr parsing/execution, and non-fabricated app discovery.

The 9 UI tests (`host/mumachine/src/ui.rs`, local source reference) cover fencing/cancel/Forget/origin change, expiry, demo isolation, truthful labels, stale refresh, Switch Agent, and form accessibility. Two compile-fail examples prevent serialization of credentials (`host/mumachine/src/model.rs`, local source reference) and poll context (`host/mumachine/src/device.rs`, local source reference).

Automated network tests use loopback fixtures and a fake vault. They do not contact Mupot, mutate an inbox, touch Keychain, deliver to a desktop, or start Herdr.

### Normal developer commands

Run these manually from `host/mumachine` when source or dependencies change:

```sh
cargo fmt --check
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release --features gui
```

For docs-only review, inspect the diff, resolve relative links, scan for credentials/private IDs, and compare [README](../README.md), source (`host/mumachine/src/lib.rs`, local source reference), and [verification limits](../VERIFICATION.md). This does not refresh Rust/bundle evidence.

No workflow under the repository's `.github/workflows` referenced `mumachine` or `cargo` in this documentation snapshot. Treat the commands above as manual checks, not as tests guaranteed by Mupot's existing CI. A maintained Rust CI/conformance job is a release-engineering requirement before broader support claims.

## Future receive and runtime acceptance

Before testing, bind **Route 1** and **Route 2** to concrete nonproduction tenant, agent, project, squad, host, seat, harness, desktop task, protocol/build, sender allowlist, and generation. Keep private values out of source/reports.

### Permission stages

- **S0 simulated (default):** fixtures, fake storage/clock, and fake framed desktop/Herdr endpoint; no credentials, IPC, services, inbox, provider, or spend.
- **S1 authorized nonproduction canary:** action-time approval for named route/sender/payload; dedicated inbox, zero/prepaid quota, read-only proof first, then one reversible delivery.
- **S2 production:** excluded. It needs independent approval, compatible owner contracts, signed distribution, rollback, retention policy, and separate authorization.

### Acceptance vectors

| ID | Stage | Vector | Required result/evidence |
|---|---|---|---|
| A-01 | S0, S1 | Exact Route 1 | Only its host/seat/harness/task accepts; other runtimes remain untouched. |
| A-02 | S0, S1 | Exact Route 2 | Distinct project/squad delivery and independently correlated receipts. |
| A-03 | S0 | Cross-route isolation | Any mismatched binding field fails closed before delivery. |
| A-04 | S0, S1 | Same OAuth, multiple seats | One authenticated human may authorize both seats, but each receives a separate scoped route; the OAuth subject is never used as the agent or route ID. |
| A-05 | S0 | Wrong recipient/sender/kind | A sender, recipient or message kind outside the route's approved policy causes no unauthorized submission or cursor loss. |
| A-06 | S0, S1 | Busy runtime | Durable deferral; no duplicate, fallback, or premature ACK. |
| A-07 | S0 | Duplicate and hash conflict | Same message/idempotency key is delivered once; same ID with different bytes is quarantined and surfaced for review. |
| A-08 | S0 | Crash and replay | Reconcile pending; `submitting` becomes `needs_review`, never blind retry/completion. |
| A-09 | S0, S1 | Revocation and Forget | Server revoke stops receive/effects promptly; route disable stops that route; local Forget removes only app state. UI and receipts distinguish all three. |
| A-10 | S0 | Stale generation | Pause, Switch Agent, route edit, expiry, or rebind invalidates callbacks and leases from the old generation. |
| A-11 | S0, S1 | Host control | Proof matches owner, manifest, PID, protocol/build, and generation; discovery/load alone fails. |
| A-12 | S0 | Single consumer/writer | A second window/bridge/harness cannot claim the resource; contention is visible. |
| A-13 | S0 | Untrusted request content | Fixed framing keeps text from changing identity, tools, approvals, credentials, route, or privileged prompt. |
| A-14 | S0 | Credential separation | No browser/provider/Herdr/other-app credential access or log leakage. |
| A-15 | S0, S1 | Shared quota bucket | A simulated or authorized observed limit event affects only its dependent routes; usage/reset/source/age are accurate and unknowns remain explicit. No automatic purchase, reset-credit use or quota reservation is implied. |
| A-16 | S0 | No wrong-runtime fallback | An unavailable external operator is not silently replaced by Agent DO, generic CLI, favorite agent, Mubot or another runtime. A separately authorized continuation is a new, explicitly fenced action. |
| A-17 | S0, S1 | Result and review | Transport acceptance, runtime consumption, execution result/artifact, reviewer verdict, and operator-visible result are separate correlated states. Missing review never appears complete. |
| A-18 | S0 | Pending effects | One owner, key, precondition, durable pending record, receipt, reconciliation, and visible unresolved state. |
| A-19 | S0 | Limits and retention | Bounds fail closed; logs expire per policy and deletion limits are disclosed. |
| A-20 | S1 | Two-route interference | Simultaneous harmless canaries for Routes 1 and 2 remain correctly isolated under busy, retry, cancellation, and result delivery. |
| A-21 | S0, S1 | Observation provenance | Installed/loaded version, model, activity, source and timestamp remain distinct; stale or absent values are not fabricated from a fixed harness table. |
| A-22 | S0, S1 | Cross-interface state | App, MCP, web and approved Mubot presentation identify the same work/result and disclose visibility scope; limited views do not claim global readiness. |
| A-23 | S0, S1 | Mac/VPS ownership | Separate installations cannot subscribe to or act on an identity they do not own; a reviewed ownership handoff preserves forward state. |
| A-24 | S0, S1 | Additional platform | Each claimed OS passes native vault, path/permission, control, accessibility and packaging tests; unsupported storage never falls back to plaintext. |
| A-25 | S0, S1 | Governed continuation | A checkpoint names the artifact/version, last confirmed action and pending effects; reassignment fences the old writer and does not inherit stale approvals. |
| A-26 | S0, S1 | Service/update lifecycle | Background operation is opt-in; install/remove/update/rollback have one service owner, preserve compatible state, and do not widen permissions. |
| A-27 | S1 | Guided multi-user onboarding | Eligible existing identities can be selected without unnecessary UUID entry; different humans/projects remain isolated and revocation is effective. |
| A-28 | S1 | User release evidence | Package version/build/hash/signing, documented platform support, support export and recovery agree with the approved release manifest. |

S1 stops on owner ambiguity, extra consumer, version mismatch, data leakage, uncertain effect, or quota uncertainty. A canary proves only its named route/payload/time/versions.

### Feature-to-test traceability

| Feature IDs | Minimum verification coverage |
| --- | --- |
| F-001–F-015 | Current core/UI/doctest inventory above, plus approved live enrollment/Keychain and artifact checks before broader claims |
| F-020 | A-08, A-10, A-11, A-18 |
| F-021–F-025 | A-01–A-05, A-13, A-14, A-16, A-17, A-20 |
| F-026–F-028 | A-03, A-06, A-09–A-12, A-20, A-22 |
| F-030–F-031 | A-06–A-12, A-18, A-19 |
| F-032–F-036 | A-14, A-15, A-19, A-21, A-22 |
| F-040–F-041 | A-01–A-23 on each claimed adapter/host combination |
| F-042 | A-24 plus the common adapter and security suite |
| F-043–F-044 | A-08–A-10, A-12, A-16–A-18, A-25 |
| F-045–F-049 | A-09, A-14, A-19, A-24, A-26–A-28 as applicable to the approved scope |

These vectors are acceptance requirements, not new tests already written or passing. Each implementation plan must turn the relevant rows into exact fixtures, assertions, expected failures and reviewable code.

## Independent release gates and proof levels

Gates are cumulative but independent; a higher observation cannot repair missing lower proof.

| Level | Gate | Minimum proof |
|---|---|---|
| V0 | Source | Reviewed exact revision; tests and threat controls trace to source; no private identifiers or secret material. |
| V1 | Local artifact | Reproducible release build, hashes, signature/notarization status, dependency inventory, and clean bundle inspection. |
| V2 | Static/runtime protocol | Fixture conformance for schemas, framing, redaction, compatibility, idempotency, crash recovery, and negative routes. |
| V3 | Live host | Fresh exact host/owner/service/process/protocol/build/generation proof. Mere reachability or discovery is insufficient. |
| V4 | Consumer | One authorized consumer and resource-level writer; no unapproved legacy/parallel consumer or overlapping credential ownership. |
| V5 | Delivery | Correlated transport acceptance and exact runtime consumption for the named route, without silent fallback. |
| V6 | Outcome | Durable result or artifact, independent review verdict, and operator-visible delivery; failures and unresolved effects remain explicit. |
| V7 | Production authorization | Separate owner approval for production scope, quota/spend, retention, rollback, and customer impact. Never inferred from V0-V6. |

## External prerequisites and uncertainties

The Mac Herdr owner describes a seatlink 0.2.1 manifest with one launchd `--serve` owner, no `[[startup]]`, and the old bridge disabled; the separate VPS seatlink 0.3.1 installation differs. Server boot/dispatch/results and exact host proof remain separately owned and unresolved. Until compatible contracts/fixtures exist, V3-V6 are blocked: do not add a competing consumer, scrape credentials, start services, or silently substitute another interface/runtime for the intended recipient.

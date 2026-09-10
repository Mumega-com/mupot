# Development and delivery process

[Master](MASTER.md) · [Decisions](DECISIONS_AND_FEEDBACK.md) · [Acceptance](TESTING_AND_ACCEPTANCE.md) · [Roadmap](../ROADMAP.md)

This is the full lifecycle for changing the Rust desktop-host product. It is not an executable implementation plan for unresolved APIs. A coding plan must follow an approved bounded specification with exact interfaces and test cases.

## 1. Intake and reuse check

Capture the user's outcome, affected agents/harnesses, expected artifact or operation, existing project scope, and consequential-action boundaries. Inspect Mupot's current work and the relevant code/docs before inventing a replacement. Check the feature catalog and earlier host/receiver decisions; avoid a second watcher, identity or task system.

Output: one bounded problem statement, source/evidence inventory, feature IDs, exclusions and owner/dependencies. Describe a missing capability separately from a permission-limited or untested one.

## 2. Reconcile the contract

Close the relevant D-series decisions with Dara/Kasra and the designated reviewer. For an adapter, specify its exact input, output, authentication, destination resolution, supported controls, durability responsibility, error states, idempotency and recovery behavior. For UI-only changes, name the existing state/action being presented rather than inventing new authority.

Output: accepted specification and conformance examples. If the current host/server cannot satisfy the contract, record the blocker and independently deliverable work. Do not fabricate a final API signature to make the plan appear complete.

## 3. Plan and isolate

Use an isolated worktree or the already assigned one. Read repository instructions, preserve unrelated dirty changes, and assign one writer per file/component. Divide work by independently testable deliverables: Rust core/adapter, Herdr integration, Mupot engineering, and independent verification.

Output: exact file responsibilities, consumed/produced interfaces, tests and expected results, review checkpoints, and rollback conditions. A documentation task may proceed without authorizing runtime changes; a source-only adapter may proceed against fixtures without authorizing service activation.

## 4. Implement with evidence

For behavior changes, first demonstrate the failing case, make the smallest implementation, and run the relevant regression set. Keep unknown states explicit. Preserve current origins, profile/Keychain boundaries and existing infrastructure ownership. Do not hide failures with optimistic status labels or weakening a gate.

Output: reviewable changes and reproducible checks tied to exact source. New dependencies or protocol requirements must be reflected in architecture, integrations and the version policy.

## 5. Independent review

Review identity/authorization, scope, transport, persistence, restart behavior, native control safety, secret handling, telemetry truth, UX and documentation. The author is not the independent gate. Resolve findings at the reviewed source and rerun affected tests.

Output: a verdict on the exact artifact and scope. “Source reviewed” remains distinct from “installed,” “connected,” “consumed,” and “accepted work.”

## 6. Controlled integration

Use isolated fixtures and synthetic identities first. A live canary requires its own approved target, sender/recipient, host route, service owner, test artifact, rollback boundary and observation plan. Never restart a shared service, enroll a real identity, consume production inboxes, or submit a consequential operation merely because a test would benefit.

For the developer–operator loop, observe both directions. Include wrong recipient, busy receiver, duplicate/retry, disconnect/restart, stale identity/assignment and quota-block simulation. Reconcile effects before repeating uncertain writes.

Output: the stage-specific evidence described in [Testing and acceptance](TESTING_AND_ACCEPTANCE.md), including the named gaps. Successful message transport alone cannot close the feature.

## 7. Package and release

Freeze source, dependency lockfile, app/build version and compatibility matrix. Build the platform artifact and inspect metadata, signing, checksums and upgrade behavior. Keep the prior recoverable artifact. Update the changelog only with actual changes and the roadmap only with explicitly accepted scope changes.

Obtain the applicable independent gate and Hadi's release/publication authorization. Documentation or a local commit is not that authorization. Only tested platform/harness combinations become supported release claims.

Output: source pin, package/hash, signing/distribution status, test/review/canary evidence, known limitations, rollback instructions and support owner.

## 8. Operate and learn

Report current observed availability and failures to Mupot through the agreed interface. Keep the host observable when a model is unavailable. Escalate actionable exceptions with one clear next step; do not create a repetitive stream of unchanged status messages.

When a failure occurs, record its scope and last confirmed stage. Preserve pending work and forward-only evidence. Reassign or resume only under current policy and ownership. Reconcile stale tasks/reviews without relabeling abandoned or superseded work as completed.

Output: an incident/decision record, exact reproducible evidence, any safe recovery performed, and a small follow-up change if justified. Feed verified lessons into tests and docs; do not create permanent work merely to keep agents busy.

## 9. Documentation requirements for every change

- Update the relevant F-series feature state and D-series decisions.
- Keep current user instructions separate from planned behavior.
- Update architecture/integration constraints when data or protocol shapes change.
- State migration, retention and rollback effects.
- Record what tests and runtime checks actually ran, at which source.
- Keep roadmap promises out of the shipped changelog.
- Verify relative links, referenced commands, feature-ID coverage, and version consistency.
- Preserve immutable evidence snapshots and add later corrections separately.

## Ownership handoff format

Every cross-lane handoff should identify the outcome, scope, exact source/artifact, applicable contract version, required recipient capability, current evidence stage, unresolved issue, next owner, and permitted action. It must not rely on a task title, pane label, or copied conversation text as authorization.

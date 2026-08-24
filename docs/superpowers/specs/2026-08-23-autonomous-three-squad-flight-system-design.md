# Autonomous Three-Squad Flight System

Date: 2026-08-23
Status: proposed governing design
Program owner and Codex Desktop principal: `hadi-codex` (`087a816b-ab9f-400f-8d53-f6f97b94a725`)

## Objective

Deliver and prove three autonomous squads—Mumega HQ, Hadi-Mac, and Mupot OS—operated from Codex Desktop under the canonical `hadi-codex` identity.

The system is complete only when each squad can:

1. receive an objective;
2. compose fresh parallel worker lanes;
3. execute through real, identity-bound runtimes;
4. produce inspectable artifacts;
5. pass one independent gate;
6. recover from interruption without a manual pane push; and
7. land a governed Mupot flight with distinct authorization, acceptance, delivery, consumption, correlated ACK, artifact, verdict, completion, and cost receipts.

Completion also requires one cross-squad flight and one Codex Desktop portfolio view that escalates only genuine authority or business decisions.

## Non-goals

- Presence, registration, a transport receipt, prose, or a pre-populated metadata reference is not completion.
- Codex Desktop is not a background inbox consumer and must not race a host receiver for the same messages.
- `hadi-codex-cli` remains a host-local runtime label. It is not silently promoted into a second Mupot identity.
- SOS is not the authoritative flight ledger. It may remain a bounded compatibility transport while a runtime migrates, but the proof path must terminate in Mupot receipts.
- The program does not revive historical flight or task IDs. Every proof flight starts from fresh IDs.
- A dashboard that reports stale board rows is not the required portfolio view.

## Current authoritative baseline

The audit was performed against current Mupot state and clean repository heads on 2026-08-23.

### Control identity

- Codex Desktop's installed Mupot app connector is currently bound to `hadi-chatgpt`, not `hadi-codex`.
- Canonical Mupot `hadi-codex` is active at UUID `087a816b-ab9f-400f-8d53-f6f97b94a725`.
- The direct Codex MCP configuration references `MUPOT_HADI_CODEX_TOKEN`, but the token's bound identity is not proven in the current task.
- `hadi-codex-cli` is the correct local runtime label and has no separate Mupot agent record.

### Mumega HQ

- Canonical squad: `mumega hq` / `mmhq`, UUID `813ca010-87db-43ff-8422-bada52f255f9`.
- The squad has no running flight or runner.
- Only one agent body was proven live during the audit, which is insufficient for a worker plus independent gate.
- `hadi-codex` is not a squad agent; Codex Desktop must operate through portfolio authority and a squad-local flight coordinator.

### Hadi-Mac

- Canonical squad UUID: `3674d955-067f-4821-86a0-c2fa03e30ff9`.
- Fourteen historical flights exist; none is running.
- Canonical Dara is `95b5ba06-72a7-4c17-ab4b-c95ed8ff2dd3`. Its profile names Qwen 3.8, but the observed body remains Grok Build. A Prime-Agent Dara runtime has not been proven.
- Duty Officer draft PR `Mumega-com/hadi-mac#5` is mergeable at `b42339aeb1a57999c19c3c788843ada565fe71c3`, with 49 local tests reported, but it has no GitHub review/check evidence and no runtime wiring.

### Mupot OS

- Canonical squad UUID: `f713c4f8-210f-448b-b20c-1b7796aee71c`.
- Canonical candidates are `mupot-os-dev` `6c555311-c89b-4a90-9cd7-23468b8c83a7` and `mupot-os-tester` `33779651-19d6-4786-94d7-8c6d1564eef8`.
- A legacy Hadi-Mac `mupot-os-dev` record also exists at `28b0de30-7514-4469-a5fc-68d0984f83e0`; it must not receive the proof flight.
- The NixOS VM, Hermes, Kolu, health endpoint, and backup timer work locally, but none proves a bound Mupot receive/act/reply loop.
- The dedicated squad has no tasks, flights, runners, or live presence.

### Shared Mupot defects

Current clean Mupot main is `66d857b4ec87fb715d9928a906ed1dbd869d2c19`.

1. **External result false-green:** MCP `task_update` accepts and validates `result`, but `persistTaskUpdate` omits it from the durable SQL update. A task can enter review while `tasks.result` remains null. There is no dedicated external-runtime result-reporting path.
2. **Production at-most-once consumption:** `inbox_lease` and `inbox_ack` exist and have server tests, but repository-backed production consumers still use peek followed by destructive count-based consume.
3. **No effect journal:** the fleet daemon spools before execution but has no terminal-effect journal or startup reconciliation. A crash after execution and before consume can repeat effects.
4. **Circuit/runner gap:** workflow circuits are explicitly schematics, not routers. They enforce topology and gate state but do not deliver work or advance themselves.
5. **Evidence bytes:** the current artifact gate validates text shape. It does not establish that referenced artifact bytes are centrally inspectable and immutable.

## Design decision

Build one Mupot-native flight spine with squad-local coordinators, a server-issued execution receipt ledger, and host-local fenced runtime adapters.

`hadi-codex` is the portfolio principal and Codex Desktop command surface. It accepts the operator objective, reads authoritative state, and creates the initial command receipt. Squad-local coordinator identities own decomposition and flight execution. This preserves squad ownership while keeping the whole program operable from one canonical Codex identity.

The same canonical agent may have multiple seats, such as `codex-desktop-command` and `herdr-hadi-codex-cli`, but every message targets one exact seat and only that seat may lease it. The command seat never runs a background inbox consumer.

Each squad has:

- one coordinator that derives a composition from a newly accepted objective;
- two or more workers on independent, useful outputs;
- one integrator where a combined deliverable is required; and
- one independent gate with a distinct principal, credential, process/seat, and read-only candidate access.

## Architecture

```text
Codex Desktop / canonical hadi-codex
              |
              | objective.accepted + command receipt
              v
      objective store and policy
              |
              v
     squad coordinator composition
              |
              | composition receipt
              v
     flight controller and circuit
              |
   +----------+-----------+
   |          |           |
   v          v           v
HQ lanes   Hadi-Mac     Mupot-OS
   |          |           |
   +---- fenced exact-seat adapters ----+
              |                         |
              v                         v
        real runtimes            execution receipts
              |                         |
              +--> R2/Git artifacts ----+
                                        |
                               independent verdict
                                        |
                               verified atomic landing
                                        |
                               portfolio projection
                                        |
                               Codex Desktop view
```

## Components

### 1. Canonical Codex Desktop command surface

Codex Desktop boots through a direct workspace-channel, agent-bound connector as `hadi-codex`.

Flight 1 can prove only what the current system supports:

- `boot_context.bound_agent_id` equals `087a816b-ab9f-400f-8d53-f6f97b94a725`;
- `orient.agent.slug` equals `hadi-codex`;
- the local label remains `herdr-hadi-codex-cli`; before Flight 2 this is untrusted local configuration, not authoritative seat registration or lease proof.

After Flight 2's schema is implemented and authority-gated for deployment, Codex Desktop must additionally obtain a Mupot-issued token-binding attestation naming the same member, agent, workspace channel, and safe credential fingerprint; register `codex-desktop-command` with its host/process generation; and submit the first `objective.accepted` mutation. The live system returns the authoritative objective and command receipt. Flight 1 reconnaissance does not substitute for this post-schema proof.

### 2. Objective intake and automatic composition

Objectives are first-class immutable rows rather than opaque strings in flight metadata. Each records creator, squad scope, success contract, authority envelope, budget ceiling, accepted timestamp, and payload digest.

After acceptance, the selected squad coordinator receives only the objective and a composition template. The coordinator derives:

- two to five useful worker outputs;
- dependencies and true parallelism opportunities;
- coordinator, worker, integrator, and gate role assignments;
- immutable `done_when` predicates;
- artifact requirements;
- retry, TTL, budget, and stop policies; and
- the interruption test point.

The coordinator emits a signed composition proposal. The controller validates it and atomically materializes fresh tasks, circuit nodes, lane-role assignments, and flight links. Templates define required roles and policy; they cannot contain precomputed lane results.

The autonomy proof requires a novel objective accepted after the proof window begins, no post-acceptance human task edits, distinct worker seats, overlapping worker lease/execution intervals, and an integrated output that behaviorally depends on both worker outputs.

### 3. Authoritative seat registry and fencing

`runtime_seats` binds an agent to an exact seat, host, adapter, process generation, public connection key, safe token fingerprint, capabilities, and heartbeat. An agent family may have several seats, but one target seat has one active consumer lease and monotonically increasing fencing epoch.

An attested host key broker—not the adapter—launches the runtime under a distinct noninteractive UID and sandbox. The broker verifies an approved executable or code-signature digest, allocates PID/process generation and seat epoch, generates the process key inside the isolated runtime namespace, and registers the public half through a host-bound signing key. The adapter cannot register process keys, read the runtime private key, ptrace the runtime, or share its UID. Mupot verifies the broker attestation before using the process public key for one-time consumption challenges.

Every dispatch snapshots:

- agent and assignment epoch;
- target seat and process generation;
- consumer fencing epoch;
- project/squad authority; and
- payload digest.

A stale process, similar label, wrong seat, expired generation, or old assignment fails before leasing or reporting. Seat claims are Mupot-issued attestations, not runtime labels or self-assertions.

### 4. Unified execution receipt ledger

Mupot owns an append-only execution receipt ledger. Every receipt has a server sequence, type, issuer, actor and seat generation, objective/flight/task/message IDs, assignment epoch, lease/fencing token hash, payload digest, predecessor receipt, server timestamp, and receipt hash.

Authoritative issuers are explicit:

- Mupot issues authorization, acceptance, assignment, lease, source ACK, task completion, cost, and landing receipts.
- A fenced adapter may submit host persistence and injection claims. Runtime consumption advances only when the exact runtime process answers a one-time delivery challenge through a direct seat-bound MCP call signed by the ephemeral process key attested at seat registration. The adapter credential cannot issue this receipt.
- A provider effect advances only after Mupot or an independent read-only verifier queries the provider/tool of record by the reserved effect key and verifies the returned digest or provider receipt. Adapter or model prose never advances consumption or effect state.
- A fenced runtime connection may submit the correlated runtime ACK and result report only after those independently validated receipts exist.
- The artifact service issues storage and retrieval receipts.
- The independent gate issues verdict receipts from its dedicated principal and read-only retrieval session.

Cardinality and ordering constraints prevent a task from inventing or skipping receipts. Source-inbox ACK is distinct from the runtime's correlated ACK. Landing validates the complete linked chain, not references copied into flight metadata.

### 5. Journaled runtime adapter and effect contract

One versioned adapter contract is implemented first for the fleet daemon and then ported to Herdr, Prime-Agent, Hermes, Cursor, OpenCode, and other proof-flight harnesses.

```text
leased
-> envelope-persisted
-> effect-intent-reserved
-> injected
-> runtime-consumed
-> provider-effect-observed-or-reconciled
-> effect-receipt-recorded
-> correlated-runtime-ack-recorded
-> exact-source-id-acked
```

An exactly-once terminal effect is claimable only when the destination supports one of:

- an idempotency key reserved before execution;
- a conditional create/write using the task effect key; or
- authoritative reconciliation by that key after an ambiguous timeout.

If the provider cannot deduplicate or be queried, that effect is ineligible for an autonomy proof. A crash after provider success but before local recording triggers provider reconciliation; it never blindly repeats the effect.

The adapter persists the envelope and effect intent before injection, renews long leases, ACKs only exact IDs with terminal journal entries, and reconciles nonterminal entries before leasing new work. Count-based destructive consume is forbidden.

### 6. Immutable inspectable artifact service

Artifact bytes and their metadata are stored under content-addressed R2 keys with create-only semantics and a D1 receipt. Engineering artifacts also name a canonical remote Git repository and a retained evidence ref. A local commit or force-pushable branch alone is insufficient.

Artifacts are overwrite/delete protected for at least 30 days after landing. An artifact receipt records object digest, size, visibility, retention deadline, repository/commit/path where applicable, producing task/agent/seat, assignment epoch, and storage receipt. Gate and the landing verifier independently retrieve the bytes and recompute the digest. The final retrieval receipt is created before landing and validated inside the guarded landing transaction. Any post-landing retrieval is observational and cannot repair a missing pre-landing receipt. Policy tests prove early overwrite/delete rejection and the fixed retention horizon.

### 7. External result reporting

`task_report_result` is the sole external-runtime completion-evidence path. Generic `task_update(result=...)` is rejected.

The tool requires the current agent-bound assignee, exact seat and fencing epoch, `in_progress` task, current assignment epoch, valid dispatch and runtime-consumption receipts, immutable artifact receipts, and an idempotency key bound to task, epoch, assignee, dispatch ID, and canonical payload digest.

The gate is declared before dispatch; the reporter cannot select or change it. Authorization is rechecked even when returning a cached idempotent receipt.

One transaction writes the durable result, artifact links, attributed result receipt, outbox event, and transition to `review`. Replays with identical bytes return the original receipt. Wrong agent/seat, stale epoch, mismatched receipt, overwritten result, missing artifact, or different replay bytes fail closed.

### 8. Independent gate

Lane roles and gate identity are fixed before dispatch. The gate must have:

- a distinct agent principal, credential, host process/seat, and runtime generation;
- no author, coordinator, integrator, reporter, or shared automation-owner role on the candidate;
- Mupot gate capability and task-squad membership; and
- read-only access to the candidate repository/object store.

The gate retrieves artifact bytes independently and binds its immutable PASS/BLOCK to task, flight, assignment epoch, artifact digests, test evidence, and runtime seat. A BLOCK is append-only; remediation produces a new digest and verdict.

### 9. Verified atomic landing and flight dependencies

Landing is one guarded D1 transaction. It verifies the current flight epoch/status, lane roles, task completions, external results, artifact retrieval receipts, independent verdicts, full execution chains, child-flight dependencies, recovery receipt, and server-computed usage cost. It writes the landing row, completion receipt, and outbox event atomically and idempotently.

The caller does not self-report authoritative cost. Usage receipts are aggregated by the server and include metered units, meter/provider reference, pricing-table version and digest, currency, calculation, and final amount. Zero-cost or unmetered work has an explicit provider/meter reason and verification record. A transitioned flight with a missing receipt is impossible.

Cross-squad parent/child relationships are durable rows, not unvalidated metadata. Parent landing requires children created after the parent objective, current child PASS receipts, and explicitly consumed child artifacts.

### 10. Controller, bootstrap, and recovery

The final controller leases actionable circuit nodes, dispatches to exact seats, validates receipts, advances legal states, enforces retry/budget policy, and checkpoints after every mutation. Two controller instances use a controller lease and fencing epoch so only one may mutate a flight.

The controller is itself missing at program start. Therefore the shared spine is built through **supervised bootstrap flights**: fresh Mupot tasks, budgets, gates, branches, artifacts, and verdicts are used, while `hadi-codex` temporarily performs controller calls through the Mupot API. Bootstrap flights are governed implementation records but do not count as autonomy proofs. They never require manual pane injection.

After the controller exists, restart recovery reconstructs state from Mupot and the controller journal without model conversation context.

### 11. Principal-attributed mutation and host-control audit

Every Mupot mutation route—MCP, REST, Worker callback, scheduled job, controller action, and admin UI—passes through one audit writer that records principal type and ID, credential/seat generation where applicable, operation, target, before/after version, objective/flight/task correlation, request/idempotency key, and timestamp. The proof environment denies direct database mutation outside an auditable migration principal.

Runtime starts, stops, restarts, signals, process replacement, and fault injection use a signed host-control wrapper. It records the automation principal, host, unit/process generation, requested action, reason, task/flight correlation, and observed result. Direct pane or shell control is outside the proof contract and invalidates the run.

Proof tasks run in ephemeral workspaces owned by a noninteractive service account. Only the fenced adapter/runner can execute processes or write candidate files; agent Git operations use a dedicated installation credential, and human shell credentials are absent. The signed runner records executable, argv digest, parent process, UID, working directory, environment-name allowlist, filesystem changes, Git actor, and remote write receipt. Landing rejects any candidate mutation from an unrecognized process, UID, credential, PTY, shell, filesystem writer, or Git actor during the proof window.

The audit is append-only and queryable by proof-window cursor. Route-coverage tests enumerate every registered Mupot mutation handler and fail when a handler lacks an audit declaration and emitted receipt. Process/filesystem coverage tests deliberately attempt an interactive shell edit and unaudited Git write and require landing to fail.

### 12. Decision policy and Duty Officer portfolio

The controller records operational failures and follows declared retry/fallback rules without escalating them to Hadi. A structured `decision_request` is created only when progress requires:

- a credential mint/rotation or new authority;
- production deployment or migration approval;
- destructive or irreversible action;
- spending beyond an approved ceiling;
- cross-tenant expansion; or
- a business choice with materially different outcomes.

Each request has a dedupe key, decision class, exact authority required, options, consequences, evidence, expiry, and resolution receipt. Exhausted retries alone are an operational BLOCK, not a Hadi decision, unless recovery requires one of the categories above.

The portfolio projection returns one row per squad plus cross-squad state, with per-source `as_of` cursor/version, generated/display timestamps, maximum age, explicit stale/error flags, oldest unacknowledged delivery, evidence gaps, budget, unresolved decision requests, and next automatic action plus its later execution receipt.

Codex Desktop renders this projection through the Duty Officer skill. Stale sources fail visibly; they are never silently summarized as current.

## Receipt chain

```text
objective-authorized
-> objective-accepted
-> composition-proposed
-> flight/tasks/circuit-materialized
-> task-assigned-to-agent+seat+epoch
-> message-accepted
-> exact-seat-leased
-> host-envelope-persisted
-> effect-intent-reserved
-> runtime-injected
-> runtime-consumed
-> provider-effect-observed-or-reconciled
-> correlated-runtime-ACK
-> exact-source-ID-ACK
-> artifact-stored
-> result-reported
-> independent-artifact-retrieval
-> independent-verdict
-> task-completed
-> cost-finalized
-> flight-landed
```

Absence, self-attestation, stale state, or a copied metadata reference never advances the chain.

## Proof window and no-manual-mutation rule

For the three squad canaries and cross-squad canary, the proof window begins at `objective.accepted` and ends at `flight.landed`.

After the initial objective/authority call, no human may mutate tasks, messages, retries, assignments, runtimes, artifacts, gates, workspaces, source files, Git refs, or flight state through a pane, shell, CLI, API, filesystem, or UI. Fault injection uses a named automation principal and produces a signed host-control receipt. Compliance is verified from Mupot mutation, process-exec, filesystem, Git-provider, artifact-store, and host-control audits—not an observation note.

## Frozen proof policy

Each proof objective stores this policy before dispatch, using server time:

- runtime heartbeat age at dispatch: at most 30 seconds; stale after 60 seconds;
- message lease: 60 seconds; renewal must arrive at least 20 seconds before expiry;
- runtime consumption challenge: at most 60 seconds after injection;
- worker recovery after injected failure: at most 180 seconds;
- controller fenced takeover: at most 30 seconds;
- automatic attempts: at most 3, with fixed 5/15/45-second backoff;
- squad canary proof window: at most 30 minutes;
- cross-squad proof window: at most 60 minutes;
- portfolio refresh: every 30 seconds; source is stale after 90 seconds;
- portfolio/escalation acceptance: at least 10 minutes and 3 complete refresh/action cycles; and
- evidence retention: at least 30 days after landing.

Policy changes after objective acceptance invalidate the proof. Every deadline produces a server-issued PASS or timeout/BLOCK receipt.

## Ordered flight portfolio

### Flight 1 — `FLIGHT-CONTROL-IDENTITY-01`

Identity-only reconnaissance: current `boot_context` must return canonical UUID `087a816b...` and current `orient` must return slug `hadi-codex`. It claims no authoritative token attestation, seat registration, check-in, objective mutation, or delivery proof because those capabilities do not exist yet. Flight 2's post-deployment phase owns those proofs.

### Flight 2 — `FLIGHT-SPINE-SCHEMA-02`

Supervised bootstrap flight: implement objective rows, assignment epochs, lane roles, runtime seats/fencing, unified execution receipts, artifact receipts, flight dependencies, principal-attributed mutation audit, host-control receipt schema, and decision requests using additive migrations numbered above current head `0120`. An independent gate reviews the exact immutable candidate. After an explicit Hadi migration/deployment decision and a successful deployment receipt, Codex Desktop obtains its token/seat attestation and submits the first test objective as canonical `hadi-codex`; the live system must return the first authoritative objective and command receipt before Flight 3 begins.

### Flight 3 — `FLIGHT-SPINE-DELIVERY-03`

Supervised bootstrap flight: implement the attested launcher/key-broker boundary, signed seat-bound lease/renew/release/exact-ACK, dispatch-to-seat, runtime receipt submission, signed host-control reporting, and one journaled fleet reference adapter. Prove executable/PID/UID/sandbox/seat-epoch binding, adapter inability to mint or read a runtime signer, all crash windows, two-consumer fencing, effect reconciliation, audited fault injection, and zero unsafe consume paths in migrated proof consumers.

### Flight 4 — `FLIGHT-SPINE-RESULT-ARTIFACT-04`

Supervised bootstrap flight: implement create-only artifact storage/retrieval and `task_report_result`. Prove durable database reread, immutable bytes, idempotent replay, stale/wrong identity rejection, and result-to-review atomicity.

### Flight 5 — `FLIGHT-SPINE-GATE-LAND-05`

Supervised bootstrap flight: implement enriched independent verdicts, server-computed cost receipts, guarded atomic landing, parent/child flight dependencies, and mutation-audit instrumentation for task/verdict/landing routes. Prove no orphan verdict/status window and no `landed` state without the complete receipt set.

### Flight 6 — `FLIGHT-SPINE-CONTROLLER-06`

Supervised bootstrap flight: implement objective composition/materialization, restartable/fenced controller execution, retry/budget policies, minimal portfolio projection, decision classification, complete mutation-route coverage, and proof-window audit queries. Kill the active controller through the signed fault-injector after a checkpoint and prove a second instance resumes without duplicate mutations.

### Flight 7 — `FLIGHT-ADAPTER-CONFORMANCE-07`

Port the reference adapter contract through governed lanes to every runtime used by the autonomy proofs: Herdr, Prime-Agent, Hermes/Mupot OS, OpenCode, Cursor where selected, and the independent gate harnesses. Each adapter must pass the same seat attestation, lease fencing, effect-journal, provider reconciliation, runtime-consumption, correlated-ACK, exact-source-ACK, restart, and signed host-control conformance suite before it may appear in a proof circuit.

### Flight 8 — `FLIGHT-HADI-MAC-AUTONOMY-08`

Accept a fresh, non-precomputed Codex objective after the proof window begins. Dara automatically composes at least two useful lanes on distinct live seats with overlapping execution. A squad-local integrator produces a behaviorally testable deliverable from both outputs. Hadi Grok independently retrieves and gates it. The fault injector kills one worker after provider effect success but before source ACK; provider-key reconciliation proves one effect. Land without a human mutation.

The existing Duty Officer candidate may be one input, but reviewing a pre-existing PR cannot by itself satisfy the fresh-output requirement.

### Flight 9 — `FLIGHT-MUMEGA-HQ-AUTONOMY-09`

Accept a fresh objective. A live HQ coordinator composes parallel useful lanes for `mupot-dev` and `inkwell-dev`; Athena is predeclared as the independent read-only gate. The integrated deliverable must alter behavior and pass tests, not merely contain a marker or evidence manifest. Inject the required post-effect/pre-source-ACK failure and land autonomously.

### Flight 10 — `FLIGHT-MUPOT-OS-AUTONOMY-10`

Prove VM binding to canonical dev UUID `6c555311...`, tester UUID `33779651...`, and exclusion of legacy `28b0de30...`. The coordinator composes two useful parallel VM/runtime outputs. Athena receives explicit task-squad membership plus gate capability and gates the integrated behaviorally testable artifact through a read-only credential. Restart `mupot-agent` after provider success but before source ACK, reconcile by effect key, and land autonomously.

### Flight 11 — `FLIGHT-CROSS-SQUAD-AUTONOMY-11`

The parent objective creates all three child flights after acceptance. Their worker intervals overlap. Each squad produces a current independently gated artifact through Mupot-routed deliveries. Integration triggers automatically from the three current PASS receipts, produces a fresh portfolio artifact, and receives its own independent verdict. While at least one child is active, the signed fault injector kills the controller; a second controller must acquire the next fencing epoch within 30 seconds, resume dispatch, and emit takeover/no-duplicate receipts. Parent landing requires all linked chains and contains no reused or manually attached child evidence.

### Flight 12 — `FLIGHT-CODEX-PORTFOLIO-12`

Wire the verified portfolio projection into the Duty Officer Codex Desktop view. Over the acceptance window, ordinary injected failures recover with zero Hadi escalations, an injected authority decision and business decision each produce exactly one deduplicated request, stale sources render stale, and every reported next automatic action later emits its execution receipt.

## Failure handling

- **Identity or seat mismatch:** fail before lease; never rename or reuse a similar credential.
- **Lease expires before effect:** re-lease under a new fencing epoch and resume from persisted intent.
- **Ambiguous provider outcome:** query by effect key; record the found effect or BLOCK. Never blindly retry.
- **Non-idempotent/unqueryable provider:** exclude the effect from autonomous execution.
- **Gate unavailable:** remain in review; never substitute an author, coordinator, integrator, reporter, or shared automation owner.
- **Artifact not retrievable:** BLOCK even when a digest or prose reference exists.
- **Controller timeout:** fenced takeover resumes from the last committed checkpoint.
- **Budget exhausted:** stop new work; create a decision request only if more spending authority is genuinely required.

## Verification strategy

Shared tests include:

- objective acceptance and automatic composition from a novel objective;
- assignment epoch and stale receipt rejection;
- exact seat/process-generation/fencing checks;
- receipt issuer, sequence, predecessor hash, uniqueness, and cardinality checks;
- signed lease/renew/release/exact-ACK transport;
- crash before persist, after persist, after effect intent, and after provider success before local receipt;
- provider reconciliation with no duplicate effect;
- partial-batch exact ACK and lease expiry/redelivery;
- two consumer and two controller fencing;
- create-only artifact storage, independent retrieval, digest recomputation, and retention;
- durable external result database reread and replay/overwrite rejection;
- gate role/credential/seat independence and immutable BLOCK/remediation behavior;
- parent-created child dependencies and current artifact consumption;
- atomic task completion, cost finalization, landing receipt, and outbox write;
- portfolio freshness, decision dedupe, noise suppression, and next-action execution.
- mutation-handler audit coverage and proof-window detection of any human/API/UI/shell mutation;
- signed host-control start/stop/restart/fault receipts and rejection of unaudited control.
- runtime-process one-time challenge signatures and rejection of adapter-issued consumption claims;
- provider/tool-of-record effect reconciliation independent of adapter/model prose;
- server-enforced frozen freshness, retry, recovery, takeover, portfolio, and retention deadlines;
- usage-cost unit/provider/pricing-version/currency calculations and verified zero/unmetered handling.

Every live proof records fresh objective, composition, flight, circuit, lane-role, task, message, lease, runtime, ACK, artifact, result, verdict, completion, cost, recovery, and landing receipts. Worker leases/execution overlap, lane outputs are independently useful, and the integrated deliverable behaviorally depends on them.

## Completion audit

| Requirement | Authoritative required proof |
|---|---|
| Canonical command identity | Mupot token attestation, boot/orient/check-in, seat generation, objective acceptance and command receipt for `hadi-codex` |
| Automatic composition | Post-objective composition receipt, fresh task materialization, no human mutations, distinct seats, overlapping worker intervals |
| Authorization | Server-issued objective/flight/task authority receipts tied to current squad/project grants |
| Exact delivery | Message acceptance, target-seat lease/fencing, host persistence, injection and runtime consumption receipts |
| Runtime ACK | Correlated runtime ACK tied to message/task/epoch |
| Source ACK | Separate server-issued exact-message ACK after durable terminal journal state |
| Artifact | Create-only storage receipt, retained canonical Git ref where applicable, independent retrieval and digest recomputation |
| Durable result | `task_report_result` receipt plus database reread under current assignment epoch |
| Independent verdict | Predeclared distinct principal/credential/seat, read-only retrieval, immutable digest-bound verdict |
| Completion | Server-issued task completion receipt after result and verdict validation |
| Cost | Server-computed usage/cost receipt within immutable budget |
| Recovery | Automated post-effect/pre-source-ACK interruption, reconciliation by effect key, one terminal effect, bounded SLA |
| Atomic landing | Single transaction proves full receipt set and writes landing plus outbox receipt |
| Mumega HQ autonomy | One fresh landed flight satisfying every row above with parallel useful lanes |
| Hadi-Mac autonomy | One fresh landed flight satisfying every row above with parallel useful lanes |
| Mupot OS autonomy | One fresh landed flight satisfying every row above with parallel useful lanes |
| Cross-squad autonomy | Parent-created overlapping child flights, three current gated artifacts, independently gated integration, autonomous parent landing |
| No manual operation | Mupot mutation and host-control audits contain only allowed controller/agent/fault-injector principals after objective acceptance |
| Portfolio | Fresh cursor-stamped Codex Desktop view; stale/error behavior; exact decision-only escalations; next-action receipts |

No historical flight, registration, presence, copied receipt reference, self-attestation, absence of errors, or plausible state substitutes for these proofs.

## Delivery boundaries

- Bootstrap source work uses fresh governed Mupot flights on isolated branches/worktrees but does not count as autonomy proof.
- One writer owns each shared implementation surface; workers own separate files or artifacts.
- A gate reviews immutable bytes with a distinct read-only credential and never authors the candidate.
- No merge, deployment, database migration, credential mint/rotation, or destructive runtime cutover occurs without its declared gate and applicable Hadi authority.
- Lab-mode simplifications may reduce ceremony, but identity attribution, secret non-disclosure, immutable artifacts, independent gates, durable receipts, and effect idempotency remain correctness properties of the goal.

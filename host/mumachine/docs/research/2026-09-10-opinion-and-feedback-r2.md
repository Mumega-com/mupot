# Mupot desktop operator host: opinion and request for review

- Date: 2026-09-10
- Prepared by: Hadi Dev at Hadi's request, following Hadi's product clarification
- Requested reviewers: Dara — Herdr plugin and local transport; Kasra — Mupot engineering
- Status: discussion draft; not an approved implementation specification or release authorization
- Distribution: full-text review copy through Mupot, as requested by Hadi; this file is the local mirror

## Executive opinion

Mupot already has substantial organizational, authorization, project, task, flight, presence, messaging, and review machinery. It also has an existing web application, Co-Pilot, Studio, and attention/review interfaces. The desktop work should connect those capabilities to the agents already operating inside users' desktop harnesses.

The primary outcome Hadi wants is a dependable **Herdr developer ↔ desktop operator** loop. A CLI agent develops and produces an artifact or change; a specific Codex or other desktop agent checks it or operates through its existing tools; the result returns through Mupot. The user should not have to forward every message between them.

The Rust app is intended to become the local desktop-harness host for that participation: exact-agent message routing, harness discovery and supported controls, operational reporting, and recovery support. It is not a replacement for Mupot's web application, not another task system, and not a new AI runtime that replaces the user's favorite agent.

My recommendation is to reconcile and extend the existing host and plugin work before inventing another session API, identity type, receiver, or dashboard. This document asks Dara and Kasra to correct that assessment and identify the smallest sound integration boundary.

## 1. Product intent confirmed by Hadi

- A desktop harness can contain many logical agents across different projects and squads. Hadi's example of roughly fifty Codex agents is a product scenario, not a measured inventory in this review.
- Desktop harnesses are operator seats in the intended developer–operator workflow. They bring the applications, browser access, connected tools, context, and human involvement already available in that environment.
- The contributing setup can be a human working with their established assistant. The designer–ChatGPT example describes an already-productive working relationship, not a request to launch a replacement designer agent.
- The preferred agent is an important user interface. Mubot on Telegram is another entrance. The existing Mupot web application remains part of the product.
- Existing human OAuth is legitimate authentication. Normal participation should not become a repeated manual credential exercise. Exact permission and agent-selection behavior must nevertheless follow Mupot's actual authorization contract.
- The Rust process should be able to report a blocked or unavailable harness even when the agents inside that harness cannot make further model calls.
- Harness version, model, observed activity, usage, and provider-reported quota/reset information are useful signals. Unknown values must remain unknown.
- If a shared usage limit blocks a group of agents, Mupot should know which agents are affected. Continuation elsewhere is useful when safe and authorized; accurate interruption reporting is valuable even before automatic continuation exists.

This is a Mupot product effort. STEM Minds and the designer example illustrate use cases; neither defines the implementation scope.

## 2. Existing work to preserve and reconcile

| Component | Evidence inspected | Boundary or caveat |
| --- | --- | --- |
| Mupot control plane | Live MCP boot, project context, project/squad access, presence, routines, attention, tasks, and flights; supporting source | The current OAuth caller has scoped visibility. This is not a tenant-wide operational census. |
| Mupot web | Signed-in Home, Co-Pilot, and Studio inspected read-only | Rendering controls does not prove every operation or downstream runtime works. No chat or dispatch was submitted. |
| Mac `mupot-seatlink` | Linked manifest and source; registry enabled; launchd running the named source with `--serve` | Running process and source inspection are not a fresh end-to-end delivery canary. |
| Older `herdr-mupot-bridge` | Installed source and registry-disabled state | Its startup runs board/reporting loops. Its manual inbox action could duplicate injection if used against the same inbox as seatlink. Do not enable it as part of this review. |
| Rust `Mupot Connect` v0.1 | Local app source, tests, package, and verification record from the earlier build | Discovery, browser-approved connection, boot/orientation, and app check-in exist. Desktop inbox delivery and harness control are not implemented in this app version. |
| Earlier Rust-host design | August 18 design-flight document and Mupot review records | Design approval and historical receipts do not establish a finished Rust host. Historical transport choices must be reconciled with current direction. |
| `hadi-mac` PR #4 | Exact source snapshot `0bc53018e1218dae707b63f286ba0a05d7e6b200` | Receiver, telemetry, and ledger work are useful references. Much of the capacity view uses estimates or fixed harness assumptions; it is not authoritative desktop quota telemetry. |
| VPS seatlink | Hadi identifies a separate installation at version 0.3.1 | Not remotely inspected in this review. Do not equate it with the Mac version or service configuration. |

### Mac seatlink facts

The inspected linked manifest is version **0.2.1**. The local plugin registry records **0.2.0**, demonstrating that registry metadata and linked source version can differ. The serving process is owned by launchd `com.mumega.mupot-seatlink`; the manifest deliberately has no `[[startup]]`. Adding one would create a competing service owner.

The implementation subscribes to Herdr topology and pane events, builds a live seat map, opens Mupot inbox event streams, and prompts an exact Herdr seat with an inbox notification. Busy/blocked seats defer the notification until a suitable state transition. The agent is then expected to read its own Mupot inbox and produce the appropriate response. The bridge notification itself is not proof of consumption or completion.

The plugin configuration directory exists but was empty. The inspected implementation reads its colocated `bridge/seats.json` and its separate runtime-state directory. Credential references were inspected only as references; credential contents were not read.

Several README statements are stale, including staged/link status, startup ownership, and the older account of remote push support. Effective source, actual launch configuration, and fresh runtime evidence must control integration decisions.

## 3. Corrections to my earlier assumptions

I initially proposed changes before sufficiently reconciling the existing product. These corrections matter to the review:

1. Mupot already has web and conversational interfaces; a new coordination dashboard is not the starting requirement.
2. Multiple seats sharing a member credential already persist independently in presence. Credential-centric `agent_sessions` must not be mistaken for the whole seat model.
3. Project presence and agent-level online capability-aware routing already exist. Exact desktop-session routing remains unproven; the remaining question is how the existing mechanisms compose with it, not whether to recreate them.
4. A new centrally persisted conversation/session abstraction is a hypothesis, not an established requirement. The existing host may already own the appropriate private routing state.
5. A desktop app brand does not establish all supported operations. Claude Code, an ordinary desktop conversation, a CLI process, and a vendor-hosted agent are different execution surfaces.
6. The recent stateless `agent_context` read patch is not a complete host or session solution. It does not implement message consumption, host wake, assignment ownership, or desktop control. It remains a separate, locally reviewed change, not a deployed integration.

## 4. Proposed operating contract for discussion

### Developer–operator exchange

1. A developer or coordinator submits a bounded request through Mupot, naming the intended recipient and project/work context.
2. The local host resolves the authorized recipient to the correct existing desktop working session. A caller-supplied display name or conversation ID is not authority by itself.
3. Delivery respects busy, paused, disconnected, and unsupported states. Pending work remains identifiable and recoverable.
4. The operator receives the request as external task data, checks or operates within the authorized scope, and returns a correlated result.
5. Mupot associates the result and artifact with the original work. Required independent review and consequential-action approval remain distinct from transport and ordinary collaboration.

This is the outcome to prove. It is not a proposal to replace the existing bus, create another organization model, or mandate a fresh model session for each message.

### Distinguish agent, harness, and shared capacity

The implementation needs to preserve these distinct facts, wherever the existing records already hold them:

- **Agent/work identity:** participant, squad, project, assignment, and owned output.
- **Working destination:** exact host, harness instance, and local workspace/conversation route.
- **Operational facts:** observed version/model, working state, last report, and supported controls.
- **Shared capacity:** provider/account/quota bucket, reported usage/reset, affected consumers, and evidence freshness.

Context-token headroom, per-turn token use, subscription quota, and a provider outage are not interchangeable. A quota event should affect the agents actually sharing that limit, not every agent with the same application name.

Codex exposes account rate-limit and usage interfaces, and the app's current account usage read succeeded during research. That proves a signal is exposed in the app; it does not prove a Rust collector is connected to it or that every harness exposes equivalent data.

### Recovery and continuation

The first useful outcome is accurate failure reporting plus preserved work. A later continuation should use inspectable artifacts, decisions, completed checks, outstanding questions, next steps, and the last confirmed action. It must not promise a perfect transfer of opaque model state.

Before resuming elsewhere, reconcile assignment ownership, pending external effects, duplicate-delivery risk, and the possibility that the original harness returns. Moving an agent to another harness and reassigning its task to another agent are different actions and should remain attributable.

## 5. Current Mupot observations requiring Kasra's interpretation

These are bounded observations from 2026-09-10, not instructions to change production:

- The shared desktop OAuth connection successfully reads Mupot as Hadi ChatGPT. Its self fleet record reports an empty runtime and no current runtime report. Authentication is working; that particular operational presence is unreported.
- `project_context` for Mupot Development returns caller-squad-scoped readiness and an empty work summary, while project-scoped `needs_you_list` and `routine_list` return attention items and enabled routines.
- Source inspection explains the last difference: the context snapshot filters by readable squads; the other lists use broader project visibility and separately restrict actions. The issue for product review is what readiness means and how scope/unknowns are disclosed, not permission to widen access.
- The enabled harness-follow-up sweep's latest five checked attempts were skipped with `overlap`. A separate older run remains waiting for budget. The causal relationship between those records was not established.
- Historical review and proof records remain visible, including earlier Rust-host work. They need reconciliation with current implementation and ownership before being treated as new work or current blockers. Do not automatically close them as completed.

## 6. Where I would concentrate effort

1. Reconcile this document against the effective Mac and VPS plugin implementations, existing host contracts, and current Mupot engineering work.
2. Prove the exact bidirectional Herdr-developer/desktop-operator exchange using existing identities and infrastructure.
3. Connect truthful operational reporting, including shared quota failures and explicit stale/unknown states.
4. Prove interruption/restart behavior and artifact-backed return/review of work.
5. Package the verified path into the Rust app and existing interfaces so users do not need to understand transport or service-management details for ordinary participation.

This is an opinion about sequence, not an assignment or authorization. Dara and Kasra may identify existing implementations that change it.

## 7. Questions for Dara

1. Which source, launch configuration, and state contract are authoritative for Mac seatlink today? Which differences in the VPS 0.3.1 copy matter?
2. What portion of the developer–operator route already exists beyond the Herdr notification path inspected here? Please point to exact adapters and evidence.
3. Should the Rust app initially interoperate with seatlink, host an adapter beside it, or eventually replace a defined component? What is the safe single-consumer/service-ownership boundary?
4. What are the current guarantees for deferred delivery, cursor persistence, reconnect, duplicate suppression, consumption, and reply correlation? Which conformance vectors should be reused?
5. What can the current harness adapters observe about model, version, usage blocks, and current working state without guessing or extracting credentials?

## 8. Questions for Kasra

1. Which existing Mupot contracts should connect an authorized desktop participant to project presence, task/flight assignment, and an exact host route? Is any proposed association already implemented?
2. How should the current OAuth directory/consent flow support the user experience Hadi describes? Please distinguish a genuine authorization boundary from an enrollment defect or misleading capability label.
3. Which receipt and assignment interfaces should desktop operators use for receiving requests and returning work? What has already been deployed and verified?
4. What scope should project readiness advertise, given the differences between context and attention/routine projections?
5. Where should harness/account capacity and shared failure events enter the existing Mupot model? Which routine/recovery work already addresses this?

## 9. Requested feedback format

For each relevant section, please return:

- **Agree / correct / reject**, with the reason.
- Existing implementation or approved decision we should reuse, with a source pointer and its evidence state.
- The smallest unresolved integration or conformance question.
- Ownership or dependency conflicts with your current work.
- The first bounded proof you recommend, and what it would and would not establish.

Feedback is requested, not a new implementation assignment. This document does not authorize code changes, a second inbox consumer, credentials or grant changes, service restarts, remote deployment, publication, spending, or a new flight.

## Sources and evidence boundaries

- Mupot MCP: `boot_context`, `orient`, `project_list`, `project_context`, `project_squad_list`, `presence_list`, `fleet_agent_get`, `task_list`, `needs_you_list`, `routine_list`, `routine_run_get`, `routine_run_list`, `flight_list`, and scoped recall. Reads were performed as the actual shared Hadi ChatGPT OAuth identity, not by impersonating Hadi Dev's intended agent binding. Inbox messages were not consumed.
- Existing web surfaces: [Mupot](https://mupot.mumega.com/), [Co-Pilot](https://mupot.mumega.com/copilot), and [Studio](https://mupot.mumega.com/studio), inspected without submitting chat, dispatch, or approval actions.
- Mupot source snapshot: [`65758b44`](https://github.com/Mumega-com/mupot/tree/65758b44c5f22bb7555df1698bb9ae9c7c2a46cb); relevant source families include `src/mcp/projects.ts`, `src/mcp/presence.ts`, `src/projects/situation.ts`, `src/attention/service.ts`, `src/auth/agent-sessions.ts`, and `src/flight-spine/`.
- Mac-local seatlink: Dara's `designs/herdr-event-bus/plugin/mupot-seatlink/`, particularly `herdr-plugin.toml` and `bridge/seatlink.mjs`. Local process inspection showed launchd owning `--serve`; no delivery canary or restart was performed.
- Earlier design: `daily-notes/2026-08-18-rust-host-runtime-flight.md`; related Mupot records include “RUST HOST RUNTIME — reconcile design contract before implementation,” C1 receiver-baseline work, H1 verifier-interface work, and FLIGHT-09 cutover evidence. These are historical records, not a fresh fleet-health claim.
- Earlier host/telemetry work: [Mumega-com/hadi-mac PR #4](https://github.com/Mumega-com/hadi-mac/pull/4), inspected at `0bc53018e1218dae707b63f286ba0a05d7e6b200`.
- Codex documented interfaces: [account usage and rate limits](https://learn.chatgpt.com/docs/app-server#api-overview-1). Documented capability does not establish integration into the Rust application.
- Telegram work should reuse the existing bot and canonical Mupot channel/review contracts. No bot was installed, configured, or messaged during the research; the separately requested sharing of this document is outside that research snapshot.

## Review round 1 — Kasra, received 2026-09-10

Kasra acknowledged the request and returned substantive feedback through Mupot. His overall verdict is **agree, with corrections**. The points below are attributed to his review; they are not automatically accepted implementation decisions.

### Agreements and corrections

- Reuse the existing identity, project, task, flight, presence, and review services. Do not introduce storage or a session API before tracing the contracts.
- Exact desktop identity is an outcome to establish, not a capability already available. Kasra identifies separate seat configuration, credential binding, connector consent, and signed fleet attachment as sources that can disagree. He proposes one boot-attestation contract as the point to investigate.
- Trustworthy host reporting also depends on the receiving server path. Kasra reports inconsistent model labels, heartbeat sequence reuse being treated as a successful no-op, and a usage-meter omission on an artifact-failure path. These require source-specific verification and coordination with his current lane.
- Project-context readiness is scoped by design; do not widen access as a response to differing attention views.
- Shared account-block reporting has no dedicated home in the paths Kasra reviewed. Existing blocked/presence and per-agent budget mechanisms are related but not equivalent.

### Existing interfaces Kasra identifies for reuse

`boot_context`, `orient`, `register_agent_key`, `token_binding_attest`, signed fleet attachment, pending runtime-seat registration, exact task runtime receipts, seat-bound `runner_record`, and the canonical `task_verdict` gate.

These names are Kasra's supplied implementation pointers. Availability and authorization through every desktop connector have not been independently established by this document.

### Engineering dependencies and source freshness

Kasra identifies [#1388](https://github.com/Mumega-com/mupot/issues/1388) / [PR #1393](https://github.com/Mumega-com/mupot/pull/1393), [#1390](https://github.com/Mumega-com/mupot/issues/1390), and [#1389](https://github.com/Mumega-com/mupot/issues/1389) as his current engineering sequence. The host proposal must not create overlapping implementations.

The highest-impact dependency for this proposal is **#1390**: the recorded dispatch path can fall back to in-Worker execution when an external seat's heartbeat is stale. An intended desktop operator must not silently be replaced by another execution environment under the same agent identity.

After receiving the review, Hadi Dev independently confirmed the repository main at `76b5b95c871a60c52e46de97213a8f732067b759`, #1390 open, and PR #1393 open/unmerged at `66222adc504bd7b78b36208b249baede368ec9b7`. These are repository checks, not an independent replay of Kasra's production smoke. The initial research used the earlier `65758b44` snapshot; both are retained here to avoid erasing the chronology.

### Author response and unresolved decision

I agree that exactness must be derived and verified rather than asserted by display labels. I also agree not to build against the dispatch behavior being changed in #1390.

The open question is which existing host proof and server seat-binding contracts should carry desktop participation, and whether a narrowly scoped new boot-attestation contract is needed. This needs Dara's effective-host assessment and Kasra's server-contract review together. Hadi's product constraint remains an existing OAuth-led user experience without unnecessary manual credential handling; it does not predetermine the internal host proof mechanism.

No choice between signed boot attestation, existing bearer/session composition, or additional association storage is approved by this response.

### Review delivery and document destination

Both Dara and Kasra acknowledged the review request and returned substantive feedback. The initially named `mupot-internal` repository could not be resolved, and no similarly named repository was substituted. Hadi subsequently directed distribution on Mupot itself. This review copy is therefore prepared for full-text delivery through Mupot, with this file retained as a local mirror; GitHub publication is not a prerequisite for this review.

## Review round 1 — Dara, received 2026-09-10

Dara's verdict is **correct the assessment and amend the sequence**. Her review covers the effective Herdr/plugin side; the following VPS and live-path assertions are attributed to Dara unless explicitly noted as independently inspected above.

### Effective installation and ownership

- Dara confirms the Mac source tree, 0.2.1 manifest, launchd ownership, colocated seat map, and separate state directory identified in this document.
- She additionally reports a cached startup entry remaining in the 0.2.0 plugin registry metadata. This was not covered by the author's earlier registry-field inspection. It must be reconciled with the current no-startup manifest before any plugin relink or lifecycle change.
- The VPS 0.3.1 installation is separate, with different subscription/reconnect behavior. Dara flags possible Mac/VPS inbox-ownership overlap for River and Hermes identities. That is a prerequisite to inspect, not a reason to start another consumer.

### Delivery and telemetry limits

- The remote seatlink path is notification-only. The agent performs its own inbox handling and acknowledgment. Local sentinel-based seat messaging is a different path.
- Dara reports that this review request reached her through the Mac seatlink notification path. The author independently observed her correlated ACK and feedback through Mupot. This is not proof that the Rust app can deliver into an idle Codex Desktop conversation; the author read replies during an active turn.
- Busy/blocked deferral, stream cursors, subscriptions, and sentinel deduplication exist. Dara does not claim a durable deferred queue across process death, guaranteed runtime consumption, or stronger reply correlation than the current request/offer identifiers.
- Herdr exposes useful observed state such as kind, status, working directory, pane, readiness, and harness session information. That does not establish provider quota/reset information or per-turn token measurements. PR #4's estimated capacity figures must not be relabeled as quota truth.
- Existing harness weld skills and the Cursor pager should be included in the integration inventory. They must not be mistaken for equivalent delivery mechanisms.

### Proposed boundary and first proof

Dara recommends **interoperation first**, retaining one authorized stream consumer per inbox identity. Rust should not add an independent stream/polling consumer to an identity already owned by seatlink, nor add a plugin startup service beside launchd. Any eventual replacement requires a separate migration proof.

Her proposed first proof is the Mac notification loop: named request → exact idle Herdr seat notified → agent handles and acknowledges → result associated in Mupot. It does not establish desktop delivery, quota-failure fan-out, the VPS installation, or Cursor Cloud operation.

Reusable and requested conformance coverage includes subscription order, busy deferral, cursor/restart behavior, replacement-socket reconnect, one-consumer ownership, duplicate-identity refusal, and notification-without-consumption semantics.

## Joint questions remaining after both reviews

1. **Host proof and route ownership:** How should an authorized desktop working session be derived and bound using the existing Mupot contracts, and how does that binding connect to the effective host route?
2. **Single inbox owner across hosts:** Which existing process owns each relevant stream on Mac and VPS? Resolve possible overlap before Rust participates in delivery.
3. **The actual desktop boundary:** Dara's proposed Herdr-only first proof is useful groundwork, but the product still needs a later exact desktop-operator exchange. Which adapter owns that final delivery without taking a second inbox subscription?
4. **Server sequencing:** Kasra's #1390 route behavior and related result/meter work are active dependencies. Freeze the interface against his reviewed outcome before a host implementation relies on it.
5. **Telemetry:** Specify the source and freshness of every model/version/usage fact; identify a home for shared quota failures without confusing them with per-agent budgets.

### Author's revised opinion

Both reviews strengthen the reuse-first direction and narrow the unresolved work. I support reconciling effective bindings and stream ownership first, preserving seatlink, then proving the developer–desktop-operator exchange against Kasra's corrected dispatch contract. I do not treat a Herdr-only proof as the completed desktop product.

The boot-attestation mechanism, exact desktop adapter, and any schema/API additions remain decisions for a reconciled specification. Neither review is an instruction to begin implementation. Hadi retains the final scope and release decision.

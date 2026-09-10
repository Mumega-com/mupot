# Mupot Connect — master software documentation

Documentation baseline: 2026-09-10. Software baseline: `mumachine` **0.1.0**, a local developer preview. Future release scopes below are proposed, not shipped or approved for activation.

This is the primary documentation entry point for the Rust desktop-harness product and its Mupot/Herdr integrations. It does not replace Mupot's server documentation, Dara's effective Herdr/plugin contracts, or a release gate. The product name currently used by the application is **Mupot Connect**; the Rust crate/binary is **mumachine**. No rename to `mupot-hostd`, Tauri migration, or new product identity is implied.

## 1. Purpose

Connect the agents already working inside a user's desktop harnesses to Mupot's organization. The first operational outcome is a **Herdr developer ↔ desktop operator** exchange: a CLI agent develops and supplies an artifact; an exact desktop agent checks or operates through its existing tools; a correlated result returns to the project.

The participating setup can include a human and their established assistant, tools, working context, and account. It is not necessarily an unattended model process. A designer working with ChatGPT is one example; it does not define a new identity type. Many such agents may coexist in one desktop application across different squads and projects.

The Rust app is intended to supply local session discovery, authorized routing, supported harness controls, health/capacity reporting, and recovery support. It must continue to observe and report when the monitored model cannot make another call. Mupot remains responsible for organization, authorization, work ownership, coordination, and accepted evidence.

This is a general Mupot product. STEM Minds and other customer examples are not default implementation targets.

## 2. Read the right document

| Need | Document |
| --- | --- |
| Run the current preview quickly | [Existing quickstart](../README.md) |
| Understand current and intended system boundaries | [Architecture](ARCHITECTURE.md) |
| See every currently known implemented/planned/candidate feature | [Feature catalog](FEATURES.md) |
| Understand APIs, adapters, compatibility, and unresolved contracts | [Integrations](INTEGRATIONS.md) |
| Connect, use, switch, and recover the app | [User guide](USER_GUIDE.md) |
| Build, package, diagnose, upgrade, and operate | [Operations](OPERATIONS.md) |
| Understand credentials, permissions, privacy, and threat boundaries | [Security and privacy](SECURITY_AND_PRIVACY.md) |
| Verify current behavior and future releases | [Testing and acceptance](TESTING_AND_ACCEPTANCE.md) |
| Take work from request through implementation and release | [Development and delivery process](DEVELOPMENT_PROCESS.md) |
| Resolve decisions and Dara/Kasra feedback | [Decisions and feedback](DECISIONS_AND_FEEDBACK.md) |
| Track proposed versions and release gates | [Roadmap](../ROADMAP.md) |
| See changes that actually occurred | [Changelog](../CHANGELOG.md) |
| Find authoritative sources and historical conflicts | [Sources and existing documentation](SOURCES.md) |
| Read the original distributed opinion/reviews unchanged | [Review copy r2](research/2026-09-10-opinion-and-feedback-r2.md) |

## 3. Current release truth

The 0.1.0 source implements native onboarding, local discovery, and boot-context display. It does **not** implement the complete desktop host described by the product direction.

| Available in the current source | Not available in this app version |
| --- | --- |
| Detect known installed app bundles and read Herdr's agent list | Enumerate individual Codex/Claude/Cursor desktop conversations |
| Validate a Mupot HTTPS origin and expected tenant | Automatically connect every discovered desktop agent |
| Request browser approval for an exact existing agent UUID | Create an agent, broaden grants, or replace another app's OAuth login |
| Validate returned identity and store the app's own credential in Keychain | Read credentials from another harness or configure its connector |
| Load/refresh boot and roster context; explicitly check in this app | Receive desktop inbox work, launch/stop harnesses, or claim their liveness |
| Save/switch/forget profiles; cancel stale operations; labeled offline demo | Background host service, account-quota telemetry, failover, or automatic updates |

The recorded September 9 verification is in [VERIFICATION.md](../VERIFICATION.md). Its test and artifact results are historical evidence at named commits, not a claim that this documentation pass reran the suite or performed live enrollment.

## 4. Evidence vocabulary

Feature status and proof are separate. Use the following terms consistently:

- **Implemented:** present in the current source at the identified baseline.
- **Locally verified:** a named local test or manual observation exists; state its date and scope.
- **Peer-reported:** Dara or Kasra supplied the claim; keep attribution until independently verified where necessary.
- **Planned:** part of a proposed product milestone, with an acceptance condition.
- **Candidate:** a possible later feature whose scope/support is not approved.
- **Contract-dependent:** implementation or activation depends on an unresolved integration/authority decision.
- **Unknown:** not observed or not accessible. Unknown is neither absent nor healthy.

Never compress configured identity, authenticated caller, reported presence, actual runtime availability, message delivery, consumption, reply, artifact, review, and publication into one “connected” or “done” indicator. A roadmap item is not a changelog entry.

## 5. Ownership and interfaces

| Area | Working owner | Boundary |
| --- | --- | --- |
| Mupot engineering | Kasra | Server identity/consent, dispatch, receipt, project, permission, and gate contracts |
| Herdr/plugin integration | Dara | Effective seatlink configuration, single consumer ownership, host events, Mac/VPS differences |
| Rust desktop product | Hadi Dev | App source, desktop adapters, local operating state and UI, integration/conformance documentation |
| Product scope and consequential actions | Hadi | Priority, approved autonomy, credentials/grants, spending, service cutover, publication and release decisions |
| Independent review | Designated eligible reviewer | Verify the exact artifact and scope; not self-approval by the implementer |

These roles describe the coordination agreed in discussion, not new task assignments. Dara's and Kasra's current work must not be duplicated by a Rust implementation. Publishing this documentation does not activate a host or authorize production changes.

## 6. End-to-end product process

### A. Connect and orient

For 0.1.0, follow the [user guide](USER_GUIDE.md): enter the expected origin, tenant, and exact existing agent; approve the app's device request in the browser; verify the returned binding; load the boot brief. This authenticates the app's selected connection, not a fleet of desktop sessions.

For the planned host, an approved connection process must associate authorized Mupot identity/project context with an observed desktop working destination. Existing OAuth should remain a valid human-led entrance. The internal proof/seat issuance contract is unresolved; this documentation does not choose it by assumption.

### B. Report participation

The planned host reports what it observes: harness instance/version, working-session state, supported controls, last observation, and model/capacity signals when available. Reported descriptors do not grant authority. A blocked account can affect several agents; an app-specific or account-specific block must not mark unrelated agents unavailable.

### C. Deliver and operate

A developer or coordinator sends a bounded project request through Mupot. The authorized ingress owner hands the request to the exact desktop adapter. Busy or disconnected destinations retain a recoverable pending state. The operator receives external task data, acts within the authorized scope, and returns a correlated response and artifact.

The receiving adapter must not start a substitute model under the intended operator's identity just because the operator is unavailable. The relevant server contract and current engineering dependencies are listed in [Decisions and feedback](DECISIONS_AND_FEEDBACK.md).

### D. Review and complete

Mupot records the return-work receipt, checks required evidence, and obtains the designated independent verdict. A task may be accepted while deployment/publication remains separately unauthorized. The existing Mupot web interface, preferred agent, and Mubot should expose the same underlying facts with clear visibility scope.

### E. Interrupt and recover

Keep the last confirmed action, artifacts, decisions, pending effects, and outstanding questions. Resume only after validating current ownership and permissions. A returning original harness must not become a second writer after reassignment. Full model-state transplantation is not promised; artifact-backed continuation is the target.

## 7. Roadmap boundaries

The proposed application train is 0.2 operator foundation, 0.3 resilience/capacity, 0.4 additional adapters and host interoperability, 0.5 governed continuation, and 1.0 repeatable user distribution. See the [roadmap](../ROADMAP.md) for exact acceptance gates and prerequisite decisions.

This train is independent of Mupot server and seatlink versions. The user asked for all future features; the [catalog](FEATURES.md) records **all currently known plans and candidates**. It does not claim to predict every future requirement. Add future scope through a dated decision and catalog entry, not an undocumented promise.

## 8. Immediate coordination gate

Before a live desktop receive path is implemented or activated, resolve:

1. Which existing Mupot proof binds a desktop operator to an exact working destination?
2. Which process owns each relevant inbox stream on each host, including Mac/VPS overlaps?
3. Which local interface hands work from that ingress to the desktop adapter?
4. Which reviewed server dispatch and result contracts does the adapter consume?
5. What machine-observed event proves consumption in the selected harness version?

Read-only discovery, documentation, and isolated adapter fixtures can be prepared without deciding these prematurely. Do not call simulated or active-turn MCP communication an idle-desktop delivery proof.

## 9. Maintaining this documentation

Update the feature catalog, decisions, roadmap, changelog, and relevant user/operations/test pages together when behavior changes. Preserve the immutable r2 review copy as history. Record later decisions in the decision log rather than rewriting what reviewers originally said. Root Mupot documentation remains authoritative for server behavior, with date/head checks before use.

The documentation set is complete as a baseline description and proposed lifecycle; the software product is not complete merely because its documentation exists.

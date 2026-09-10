# Decisions and review log

[Master](MASTER.md) · [Roadmap](../ROADMAP.md) · [Immutable review copy](research/2026-09-10-opinion-and-feedback-r2.md)

Baseline: 2026-09-10. “Confirmed direction” below reflects Hadi's product instructions. “Open” is a decision with an owner and required evidence, not authorization for an engineer to fill it by assumption.

## Confirmed product direction

- Mupot is the existing organization/control plane, including its web/MCP interfaces.
- The Rust app is intended to connect many agents in desktop harnesses, report their operating conditions, and support their participation in Mupot.
- Herdr CLI developers and desktop operators must exchange useful requests/results without manual message forwarding.
- The user's favorite agent and Mubot are valid conversational interfaces; no replacement dashboard or AI runtime is requested.
- Existing human OAuth is a legitimate entrance. Preserve authorized identities and do not turn normal participation into repeated manual credential setup.
- Usage blocks can affect groups of agents sharing an account limit; honest interruption reporting is valuable before automatic continuation.
- Reuse prior receiver/plugin/host work. Keep Mac and VPS deployments separate until verified.

## Open decisions and acceptance conditions

| ID | Question | Owner of resolution | Evidence required before activation |
| --- | --- | --- | --- |
| D-001 | How is an exact desktop participant derived from authorized identity, project and observed host session? | Kasra + Dara; Hadi approves scope | Trace existing consent/key/seat contracts; demonstrate wrong identity, stale proof and shared-connector cases |
| D-002 | Who owns each relevant inbox stream across Mac and VPS? | Dara + Kasra | Effective process/configuration inventory and a one-owner or explicitly fenced handoff proof |
| D-003 | How does existing ingress hand work to the Rust desktop adapter? | Dara + Hadi Dev | Versioned local handoff, trust boundary, durable responsibility and retry/error contract |
| D-004 | Which server dispatch and return-work behavior is the adapter allowed to depend on? | Kasra | Exact reviewed source/schema and tests, including no unintended replacement execution |
| D-005 | What proves consumption and response for the first desktop adapter? | Hadi Dev + independent reviewer | Exact harness/version event chain and correlated receipt, not assistant prose alone |
| D-006 | Where do shared provider-account quota failures belong in Mupot? | Kasra + Hadi Dev | Source/age/scope definitions; affected-agent fan-out and unknown-state tests |
| D-007 | When may another harness or agent continue interrupted work? | Hadi + Kasra + Dara | Authorized policy, checkpoint/effect reconciliation and single-writer recovery proof |
| D-008 | Which OS/service/update model is supported for a user release? | Hadi Dev + Dara; Hadi release decision | Opt-in install/remove, platform vault, signing, compatibility and rollback evidence |
| D-009 | How should scoped readiness be described consistently across interfaces? | Kasra + product review | Reconcile project/squad visibility semantics without widening permissions or turning unknown into zero |

No decision here requires a new database entity by default. If existing records cannot express an invariant, document the specific deficiency and the smallest additive contract before proposing schema changes.

## Review round 1: 2026-09-10

The [r2 document](research/2026-09-10-opinion-and-feedback-r2.md) preserves the opinion, questions, both reviewers' responses as attributed summaries, and the author's revised position. Its exact UTF-8 SHA-256 is `1233a5c0046fed2dd30d92fc1efe57db9b371db20faa6502a393ef47f0dfd4b1` (26,707 bytes).

### Dara: Herdr/plugin boundary

Dara recommends interoperation first and preserving the existing stream owner. She confirms the Mac manifest/launchd split and identifies stale registry/startup metadata, a separate VPS installation, possible cross-host identity overlap, notify-only semantics, and unproven deferred-queue durability across process death.

Her first proposed proof covers a Mac Herdr notification, agent handling/ACK, and a result on Mupot. It does not complete the desktop-operator product. The later exact desktop handoff remains D-003/D-005.

Dara confirmed assembly of all four transmitted r2 parts and recomputed the whole-document hash successfully. That is receipt/integrity evidence for the discussion copy, not approval to implement or deploy a host.

### Kasra: Mupot engineering boundary

Kasra agrees with reusing existing services and avoiding a new session API/storage until the contracts are traced. He identifies mismatched static binding sources and proposes investigating a signed boot-attestation contract. That mechanism is a review proposal, not an accepted design decision.

He identifies active engineering dependencies in [#1388](https://github.com/Mumega-com/mupot/issues/1388), [#1390](https://github.com/Mumega-com/mupot/issues/1390), [#1389](https://github.com/Mumega-com/mupot/issues/1389), and [PR #1393](https://github.com/Mumega-com/mupot/pull/1393). The initial reviewer source snapshot was `76b5b95c`; issue/PR states must be refreshed before execution.

Kasra later confirmed all four r2 parts assembled with their individual server checksums intact. He explicitly did not recompute the whole-document SHA. His round-1 review was represented accurately.

### Additions after the immutable r2 copy

At 16:09 UTC on September 10, Kasra flagged [#1394](https://github.com/Mumega-com/mupot/issues/1394), a same-call assignee/artifact-gate concern, and [#1395](https://github.com/Mumega-com/mupot/issues/1395), a conditional runtime-receipt gate concern. He asked that the return-work contract be frozen against the outcomes of #1388/#1390/#1394. These are attributed review additions; this documentation pass does not independently reproduce them or imply their current resolution state.

## Changes in understanding

| Earlier assumption | Correction retained in the design |
| --- | --- |
| Need another coordination/review UI | Existing Mupot web, Co-Pilot, Studio and review views already exist |
| All desktop seats collapse under shared OAuth | Credential-session scope differs from existing multi-seat presence/runtime-seat records |
| Project presence/capability routing is missing | Existing mechanisms must be composed with exact desktop routing |
| Rust should own another inbox consumer | Resolve ownership and interoperate with seatlink first |
| A local process or successful boot proves availability | Report actual runtime/route capability separately |
| A new warm-session API/storage is necessarily required | Trace existing contracts and record an explicit deficiency first |
| STEM is the initial product scope | It is an example; the product is general desktop-harness participation |

## Decision maintenance

When a decision closes, retain its prior question and add the date, owner, accepted alternative, rejected alternatives, evidence/source pin, affected feature IDs, migration/rollback effect and approval boundary. Never rewrite review history into a claim of implementation. Acknowledgment of a document is not agreement with its architecture.

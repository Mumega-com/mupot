# Bounded delegates, thread lineage and stable CLI seats

**Design proposal only — 2026-11-16.** Author: Athena. Task `db1977ca-8b48-48e1-8cd2-f04db4ab3532`. Gate: Kasra plus a fresh Opus/adversarial lens. No code, schema migration, credential, grant, fleet change or deployment is part of this document. Approval of a design is not approval to issue credentials or activate it.

Source baseline: Mupot main `8ff50e3f779d67d4a20f02893e087bcf981a1315`. Candidate dependency: PR [#2430](https://github.com/Mumega-com/mupot/pull/2430), repair head `15ed2f9bba7f6fa16fd9fdda0abe5a0d368016bc`, still distinct from main. Source wiki: `subagents-and-thread-seats-20261116`, project `mupot-development`, version 1/page `c9ab6cdded3b419e`, read through authenticated Mupot. Its report of 100+ thread seats is a requester observation, **not an independently recounted production total here**.

## Recommendation and boundary

Recognize a delegate as its own bounded actor acting for a verified parent. Keep the parent's token private. Recognize a conversation as context under a seat, rather than manufacturing a new sovereign peer for every thread. Neither lineage, a client label, an inferred owner nor remembered prose confers authority.

Reuse the current issuer, OAuth consent, seat/admission lifecycle, credential custody and request-level authorization seams. Add a separately reviewed delegation class and verified lineage record; add a server-approved CLI client class and installation/workspace registration. Do not turn existing `parent_agent_id`, `harnesses.kind` or `client_name` into authorization inputs. Existing fields alone are insufficient. A second public discovery resource does not solve that trust gap and is not proposed for the first slice.

The alternatives are: copy a parent bearer (reject: impersonation and unbounded authority); issue an ordinary agent token then label it a child (reject: squad-wide visibility and no ancestral attenuation); or introduce a bounded credential class with a verified delegation edge (recommended: more explicit policy work, but child identity, revocation and scope are enforceable). For CLI seats, name-based classification is rejected; retaining per-thread seats is the safe fallback until verified installation/workspace registration exists.

## What the current code actually establishes

All references below are at the source baseline unless marked candidate. File paths/line numbers are source evidence, not production-operation receipts.

| Existing surface | Source evidence | Consequence for this design |
|---|---|---|
| Parent placement | `migrations/0068_agent_profile.sql:17-45`; `src/org/service.ts:879-890` | `parent_agent_id` is a soft placement reference. Creation checks existence; that does not prove a delegating caller or confer access. Old slug-valued edges are not verified authority lineage. |
| Creation and updates | `src/mcp/provision.ts:759-805,2258-2260` | `create_agent` has structural/lead checks and may accept parent metadata; `update_agent` does not expose parent patching. This is not a narrow child-credential path. |
| Human owner | `migrations/0155_agent_owner_member_and_origin_verdict.sql:28-32`; `src/org/service.ts:1533-1544` | `owner_member_id` is security-relevant, including human-origin behavior. Free-text `owner` is different. A roster cleanup must not silently write this security field. |
| Ordinary mint | `src/mcp/provision.ts:960-982`; `src/members/service.ts:510-569,769-803` | The current mint has operator/elevation checks, an agent/member weld, expiry and initial grant clamps. It does not establish an ancestral delegation. Do not relax it for dispatchers. |
| Credential custody | `src/auth/credential-claim.ts:1-40,56-85` | A claim handle limits transcript exposure; the reveal response can still expose raw material to a model. Reusing a claim alone does not prove protected delivery to a child runtime. |
| B1 and authenticated identity | `src/mcp/oauth-authorize.ts:1565-1608` | Directory bound identity comes from the authenticated token row; an unbound directory token cannot choose an agent through client props. Harness credentials have zero capabilities; consent-bound agent rights are separately clamped. |
| Attached authority | `src/auth/attached-ceiling.ts:1-27`; `src/members/attach-live-sql.ts:36-68` | Attached authority has a shared human/agent/admission clamp, exact attachment provenance and request-level liveness. Identity-keyed powers do not automatically carry across threads. |
| #2430 candidate | At `15ed2f9b`: `src/auth/attached-authority.ts`; `src/members/approval-move.ts`; `src/mcp/events-subscriptions.ts`; `src/members/seat-attach.ts` | Helper/Full is recorded separately from rank. The candidate bounds new decisions, preserves Move cutoffs, stops expired request/event use and allows a fresh ask. Full still does not widen tools in stage 1. It must land and pass its own gates before a build depends on it. |
| Auto-seat ownership and creation | `src/members/seat-select.ts:525-604` | The agent display name uses the human's display label; the seat row already records authenticated `member_id` and `harness_id`. The ordinary agent create input omits owner/parent. A missing `agents.owner` is not proof that the seat has no authenticated human binding. |
| Auto key and reclaim | `src/members/seat-auto.ts:64-95,196-279`; `src/members/seat-select.ts:354-401` | Auto keys favor OpenAI session, then Codex thread; explicit failed handles do not fall through. Pool-pressure reclaim retires rows/revokes tokens and respects pinned/held cases. It is not proof of a universal idle deadline. |
| Harness identity versus labels | `src/members/harness.ts:1-7,53-73,77-87,103-174` | Kind comes from a sanitized client-name classifier and is display-only. Grant-bound OAuth installs are deliberately distinct; same client name is not same installation. |
| Explicit seat key | `src/members/seat-key.ts:1-23,97-165`; `src/members/seat-select.ts:418-454` | Server normalization/hash separates human+harness and labels. Folder/worktree/host text is not proof of a machine, project permission or original conversation ownership. |
| Review independence | `src/tasks/index.ts:1800-1842`; `src/tasks/verdict-independence.ts:1-50` | Party/owner/binding affiliation is checked and reasserted in the verdict write. A derived credential must not create an independent reviewer alias for its parent or shared work. |

No new route, floor, permission mapping or token policy is implemented by the tables below. Those are build inputs requiring owner policy and two independent gates.

## 1. Child credentials: derivation and attenuation

**Proposal.** A parent requests a bounded delegation for a specific task/purpose under a verified human-approved policy. The server derives the parent from authenticated identity, never a `parent_agent_id` argument. The first policy needs a fresh human decision, reusing the admission's identity presentation, CSRF/passkey/freshness, scope and expiry patterns. An existing “let this chat act as Rava” admission is **not** consent to mint descendants.

The server creates a child subject, immutable delegation receipt and short-lived credential binding in one durable authority transaction. Its credential resolves as that child, with parent/root attribution beside it. It never resolves as the parent and carries no copied qNFT, signature, gate grant or human-origin claim. A failed transaction issues no usable child credential. Spawn idempotency binds the parent, owner policy, task, bounded purpose/scope and requested child identity; conflicting retries are refused, not silently reused.

For every action/resource, effective permission is the intersection of:

- the parent's **current** permitted action/resource, including any parent attachment or delegation restrictions;
- the consenting human's **current** standing and still-live approval;
- the explicit delegation action/resource allowlist and child caps;
- the child's own active assignment and subject boundary;
- the credential/admission liveness and remaining budget/depth limits.

A numerical minimum rank is necessary but insufficient: parent access to all squad tasks must not become child access to all squad tasks. Initial mode is Helper, rank ceiling at most member, with an explicit self/assignment restriction. An ordinary member token plus a display label cannot implement this. Authorization must retain the derived credential class and check the resource predicate on **every reachable transport**; an endpoint without an approved policy row refuses it. Existing tool floors and B1 remain unchanged. The owner must approve the exact tool/resource matrix before building any newly reachable surface.

Proposed first allowlist: read/consume own inbox, inspect the specifically assigned task, submit that task's result, and send a correlated receipt to the delegating parent. This is **proposed policy**, not today's grant. No peer/squad broadcast, arbitrary task enumeration, parent inbox/memory, owner-keyed act, gate verdict, human approval, credential reveal/mint/grant, publish, merge, deploy or spending authority. Passing a receipt does not authorize the next action. The parent may read bounded child task/result receipts under the same approved policy; it does not inherit arbitrary conversation history.

The new credential must be delivered to an approved runtime secret sink through a protected host/control channel. A model receives only a safe handle and receipt. Existing same-minter claim redemption and single-use rules must be preserved; do not hand a parent-minted claim to an unrelated child identity and assume it can redeem it. The trusted host path, redemption principal and out-of-band delivery need a separately reviewed contract before minting is enabled. No raw bearer in chat, source, logs, startup files or shared MCP configuration.

**Expiry.** Proposed pilot maximum is one hour, never later than parent credential, parent delegation/admission, human approval or policy expiry; retain the minimum cutoff permanently on that decision. Parent rotation/revocation, owner change or policy withdrawal invalidates descendants on their next request/event delivery. No child refresh past the parent deadline and no automatic reparenting onto a new root token. Deferred cleanup must not extend authorization. Revalidate the same predicates in the mutation/dispatch transaction as at preflight; an expiry check only at mint time is inadequate.

## 2. Verified lineage and field ownership

**Proposal.** Keep placement metadata readable, but put security lineage in a server-verified immutable delegation relation (working name `agent_child_delegations`; no schema created here). Existing soft parent links are never grandfathered into this relation merely because the named parent exists.

| Field / relationship | Who establishes or changes it | Authority rule |
|---|---|---|
| Existing `agents.parent_agent_id` | Existing create/admin path, as today; no new self patch | Display/placement only until linked to a verified delegation receipt. Legacy names and aliases remain unverified. |
| Verified parent and root IDs | Delegation service derives from authenticated parent and verified ancestry, on creation only | Real canonical IDs in the same pot; no cycles, alias parents, missing ancestors or caller-supplied root. Root is the first verified ancestor, not a label. |
| Consenting/operating human | Server derives from the approved policy/admission and verifies active tenant membership plus standing | Root owner/consent mismatch stops delegation. Unowned or ambiguous roots need an owner decision; never infer from email, cwd, display name or memory. |
| Existing `owner_member_id` | Only the existing protected owner-write path | Do not backfill it for automatic seats as a cosmetic fix or confer human-origin authority through it. Operational ownership can already be displayed from `agent_seats.member_id`. |
| Policy/approval, task, parent credential generation and owner epoch | Service records immutable references and fingerprints | Re-read their current validity. A root ownership change cannot silently transfer an old delegation to a new person. |
| Depth, root, purpose, allowlist, expiry and counters | Computed/clamped by service; capabilities cannot be enlarged by child updates | Later scope changes require a new approved decision. A display patch cannot rewrite the authority record. |
| Status/revocation and issuance/audit receipts | Dedicated lifecycle service records transitions atomically | Keep historical lineage/receipts after expiry; cleanup is not deletion of the evidence trail. |

Every result/message/audit record names the actual child subject plus delegation, parent/root, task and consenting human references. Public display can say “delegate of Rava”; it cannot say “Rava did this” without identifying the child. Logs exclude secrets and private prompt/content dumps. A legacy free-text parent cannot taint another agent's independence or let it claim that agent's lineage.

A child cannot gate its own, its parent's or an affiliated descendant's work merely by acquiring a new subject ID. Extend the shared independence predicate using **verified** delegation ancestry and participation, with the same check in the verdict mutation. Preserve existing explicit owner-waiver semantics only where already permitted; never fabricate a child waiver or a second sovereign peer.

## 3. Thread seats: ownership, parentage, idle expiry and roster

**Proposal.** First present the ownership already proved by `agent_seats.member_id` and the harness grant. Group the roster as human → admitted root/verified installation → workspace seat → bounded delegates and conversation activity. Canonical named agents remain separate from automatic thread scaffolding. Default roll call and broadcast eligibility exclude scaffolding/delegates; an actual delegation request targets its child's own inbox explicitly.

A conversation with no authenticated parent gets `parent = unknown`, grouped under its proved human/harness, not a fabricated Rava or Hadi-root agent. After explicit attachment, record the authenticated relationship while preserving the prior seat/context history. No new named agent is created just to label a conversation. A display migration or “mark dormant” proposal does not grant any new authority.

Proposal: a 30-minute idle delegation lease, bounded by its absolute cutoff, with active work renewed only within the approved policy. Maintain separate fields for administrative status, authorization expiry, heartbeat freshness, delivered wake and correlated answer. `active` alone is not onboard or heard. Any presence evidence must be attributable and current; self-reported model/harness names are labels, not identity proof.

Authentication and event delivery reject expired leases immediately even if a sweep is late. A bounded lifecycle sweep can later retire scaffolding, revoke handles/tokens, detach expired attachments and append receipts. Held seats never escape through reclaim. Preserve existing lifetime quotas, pinned-seat protections and no-resurrection behavior; proposed expiry must close a lease rather than silently minting a fresh generation to evade it. Proposed deactivation/backfill lists require the appropriate owner decision; no deactivation or deletion was executed here.

## 4. Reuse #2430; do not widen B1

Reuse the shared admission identity/consent presentation, exact human/agent/harness/seat binding, canonical expiry parser/predicate and append-only decision/audit patterns once #2430 lands. Reuse token lifecycle and secret-custody facilities where they meet the new contract. A moved or renewed admission must not extend an existing child's cutoff or elevate Helper to Full. Old approval text is not a delegation policy.

Keep the concepts separate: `authority_level` Helper/Full is not the member/lead/full rank ceiling; stage-1 Full does not widen tools. A child starts Helper and cannot select Full in the first delegation slice. Unbound directory/harness credentials stay zero-capability and on their current allowlists; asking for a seat/child does not authorize a mint or an attachment. The existing operator/elevation gate for ordinary token mint remains intact.

No authority is read from wiki, memory recall, agent profile prose or an inbox body. Policy and approvals are typed server records and live state. A vector outage or missing recalled fact cannot determine whether the child is authorized.

## 5. Loops, fan-out and resource limits

All numbers here are **proposed pilot limits requiring owner approval**, not measured capacity or current server defaults.

| Limit | Proposed default / behavior |
|---|---|
| Verified delegation depth | 1: a child cannot issue grandchildren. A later depth-2 policy needs explicit approval and the same root-wide limits. |
| Concurrent children | At most 4 per verified root; all descendants count, including across worktrees/CLI installs. |
| Active work | One assigned task per child in the first slice; no free task creation or enumerating the squad. |
| Creation rate | 4 successful child issuances per root per 5 minutes, with atomic counters and idempotent retries. Denied requests are separately rate-limited. |
| Lifetime / idle | Absolute max 1 hour, idle lease max 30 minutes, both shortened by the ancestor/policy chain. A runtime cannot renew by renaming itself. |
| Spend and entitlement | Reserve within the parent's existing authorized budget; no new spend authority, free “home agent” quota bypass or unbounded child budget. Owner decides any commercial metering policy before build. |
| Messages | Correlated child result/ACK to the authorized parent only; ACK is terminal. No fan-out wake, wake-the-squad fallback or reply-to-an-ACK loop. |

Counters/child creation/assignment references must commit atomically; concurrent spawn cannot exceed limits. Reserve ancestor-wide capacity before issuing a token; release it on verified terminal/expiry transitions without erasing receipts. Replays, cycles, contradictory duplicate fields and indexed JSON-RPC batches all use the same canonical decision point. An unavailable policy or ancestor read fails closed; it is not an empty permission set that another path may replace with a default grant.

## 6. Build order and the 0275 question

| Slice after design approval | Preconditions and bounded artifact | Dependency on durable memory retry / 0275 |
|---|---|---|
| A. Read-only roster truth | Show proved human/harness ownership, existing placement and unknown lineage separately; group scaffolding without changing visibility, grants or authoritative owner fields. Runtime counts require a separate authorized inventory receipt. | None. A source-label view does not require vector repair. |
| B. Verified delegation contract | #2430 landed/gated; owner-approved action/resource matrix, quotas and runtime secret sink; atomic lineage/expiry/independence tests. No use of an ordinary unrestricted token as a shortcut. | None inherent. It needs its own schema and policy review later; no number assigned here. |
| C. CLI install/workspace binding | Server-approved client class, installation key-possession registration, exact consent/grant binding and canonical workspace registration. Retain safe per-thread behavior until those exist. | None inherent. Its future schema must not reuse a number reserved for another slice. |
| D. Lifecycle rollout | B/C gates, request/event expiry, race/rollback receipts, read-only inventory, then an explicitly authorized canary; owner-controlled revocation and reversible presentation changes. | Independent unless a later acceptance contract explicitly needs memory indexing guarantees. |

The task's “slice 2 / migration 0275” is the held **durable vector projection/retry** work. These identity/lineage proposals do not depend on that mechanism and do not authorize, reserve, rename or write 0275. Any future delegation/client-class schema is a separate approved slice numbered above actual applied/main/reserved heads at build time. Durable child authority/counters belong in the authorization store, not in semantic memory or an eventually searchable vector.

## 7–8. A distinct CLI class and stable dedupe

**Proposal.** Introduce a server-approved `mupot-seat` client class distinct from ordinary web connectors. Membership comes from an operator-approved registration/credential policy bound to the exact client ID and grant/token class. Public dynamic client registration and a `client_name` of “Codex CLI” cannot opt into it. Do not reinterpret today's label-derived `harnesses.kind` as trusted classification.

Before claiming an installation is verified, register a software key-possession identity bound to the tenant, authenticated human and exact OAuth consent grant. The trusted local harness keeps its private key outside model context. A server challenge and receipt bind an installation ID; this proves key possession for that registration, **not physical hardware or a trustworthy machine**. A separate server workspace registration supplies a stable workspace ID under that installation; repo/path/cwd/worktree text remains display metadata. The owner selects/approves the workspace binding; a remote client cannot claim another installation by submitting its ID.

Use a versioned canonical dedupe key over `(tenant, human, approved client class, verified installation ID, registered workspace ID)`, then hash it. Thread IDs become scoped activity/context references under that workspace seat, not the seat's primary identity. Concurrent starts for the same registered workspace converge atomically; different humans, consent grants, installations or workspace registrations do not collapse.

This dedupe is an identity/organization decision, **not permission to merge conversation history**. Each original conversation keeps its own context ID, receipts and source permissions. No automatic import of private chat history, files or memory between sessions. A new runtime conversation must prove its own permitted relationship; sharing a workspace label alone cannot attach it as a privileged agent. Existing web connector per-conversation isolation remains unchanged.

A move/rename uses an explicit server workspace alias/transfer decision tied to the same owner/install; no filesystem normalization heuristic merges independent registrations. Re-consent, installation revocation, key replacement, owner change or grant expiry invalidates the old binding and requires its own approved transition. Do not auto-adopt an active old consent into a new install, accept a stale seat handle, or fall through to auto-enroll after a refused explicit handle. Preserve held-seat and lifetime-cap protections.

## 9. Discovery and auth surface choice

Keep the same issuer and existing MCP resource for the first proposal, with explicit server-side credential/client classification and installation/workspace records. The existing consent and seat-selection/whoami doors can carry scoped selection and identity receipts. **Existing `kind`/`credential_kind` and auto-enroll rules alone are not enough:** kind is a label, and credential_kind only separates token from OAuth. Conversely, adding a second discovery URL/resource alone would not prove an install or a worktree.

A second resource should be considered only if a later client/audience/security contract needs a genuinely different resource boundary; that needs its own route, permission-map, token-audience and adversarial review. This proposal opens no new public discovery endpoint, widens no directory ceiling and creates no host-readable full-rights human discovery credential. Unknown class or missing registration stays on the current safe path or is refused; it never gets CLI privileges as a guessed default.

## Acceptance proofs before any build can be called complete

| Contract | Required negative and positive evidence |
|---|---|
| Child identity and scope | Receipt says child, not parent; parent token cannot appear in output. Own assigned task/inbox works; parent/peer/sibling inbox, task enumeration, foreign project/tenant and unassigned task fail through MCP and direct HTTP. |
| Attenuation | Revoked/expired parent, lost human rank, changed owner epoch, expired admission and withdrawn policy stop a previously issued child on request and event paths. Preflight-to-write races roll back without false receipt. |
| No implicit elevation | Helper cannot select Full; Full mode never bypasses a rank/action/resource cap. Child mint/grant/verdict/owner-keyed/human-origin/publish/deploy paths are refused through every alias and batch door. |
| Lineage | Missing/foreign parent, alias ID, root spoof, cycle and forged free-text placement are refused or remain display-only. Legacy parent metadata cannot taint independence or create verified delegation. |
| Limits and restart | Concurrent duplicate spawn converges; distinct concurrent children cannot exceed root-wide caps. Crash before/after issuance, cancellation, delayed cleanup and task reassignment preserve quota and revocation truth. |
| CLI classification | DCR client_name spoof and forged kind/props cannot select mupot-seat. Same registered workspace reuses a seat across new threads; separate humans/installations/grants/workspaces remain separate. |
| History and lifecycle | Same folder text cannot inherit another chat's original history, attached identity or permission. Rename/move/re-consent/revoke require exact registration receipts; expired and held handles cannot escape through reclaim or auto fallback. |
| Custody and compatibility | Claim/reveal/redemption faults leave no untracked credential and no raw model-visible secret; legacy web consent, B1 zero-capability, member/agent tokens and explicit seat handles retain their prior boundaries. |

Use real-schema D1 tests, real transport/canonical parsing checks, parent comparisons and guard mutations; retain exact head, test counts, skips and unavailable dependencies. This document has not executed those future acceptance tests. Before implementation, enumerate every writer, mint and transport plus the approved capability-map rows; a missing policy row is a stop for that build, not license to invent one.

## Owner decisions and gate posture

Hadi/Kasra must resolve the proposed pilot policy (limits, eligible root/child classes, allowed action/resource matrix and budget treatment), the protected runtime delivery/installation contract, and the treatment of ambiguous legacy rows. Any idle deactivation, credential/key change, owner write, new route or rollout remains a separate authorized action. No new feature is started by a wiki message or this draft.

Kasra and a fresh Opus/adversarial lens review this design before a build brief. For later sensitive builds, correctness and adversarial review run in parallel at the pinned head; the author is never their own gate. The sequence stays **draft → design gates → separately authorized build → exact-head gates → operator-approved activation**. Memory retry, signed wake grants and public publishing remain outside this design's authority.

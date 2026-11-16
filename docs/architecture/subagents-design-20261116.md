# Bounded delegates, thread lineage and CLI seats — repaired design

**Proposal only — 2026-11-16.** Author Athena; task `db1977ca-8b48-48e1-8cd2-f04db4ab3532`; independent gates Kasra plus fresh Opus/adversarial lens. This repairs round-1 findings on e5a5eed9. No code, migration, credential, grant, deactivation or deployment is included. No decision below authorizes implementation or creates an exception to Hadi's “no new grant path” rule.

Source inventory: foundational code at `8ff50e3f779d67d4a20f02893e087bcf981a1315`; attach/expiry stage1 at `15ed2f9bba7f6fa16fd9fdda0abe5a0d368016bc`, now merged by #2430 as `9aed8b036cd8a3f1b844e5776f419f7a74133393`. The separate P2-A reader correction is draft #2438 at `70c44c7bd6219b0f45e172438b6ffa9689c19287`, not claimed landed here. Source wiki `subagents-and-thread-seats-20261116` v1/page c9ab6cdded3b419e was read through authenticated Mupot. Its 100+ seat count is requester-reported, not independently recounted here.

## Readiness and the five unanswered Hadi decisions

Only **slice A, read-only roster truth**, is a candidate to build after #2430 and its normal approvals. **B, C and D are not ready to build or ship.** They remain blocked on the policy questions and contracts below even after a design gate. None needs memory retry migration0275, which remains separate and held.

The following are questions for Hadi; this document does not answer them:

1. Is issuance of a delegation credential a **grant path** under the “no new grant path” rule, even when no capabilities row is created?
2. Is **web-child delegation** in scope, including the Rava/ChatGPT example with no trusted host secret sink?
3. Should deduped CLI threads have **shared or per-conversation inbox, lease and task semantics**? Is any live identity/seat merge acceptable?
4. Do **harness-scoped admissions remain legal once delegates exist**, and may they ever be delegation parents?
5. How should **ambiguous legacy rows** be treated: ownership attribution, placement, grouping, possible dormancy and later verified lineage?

Until those decisions, existing access and per-conversation behavior stay unchanged. No token can be issued from this proposal. A safe refusal or visible unknown is not an answer on Hadi's behalf.

## Existing code: what is reusable and what is not authority

Unless labeled stage1, paths below refer to foundation8ff50e3f. Symbols identify the relevant code; the stage1 tree is separately pinned above.

| Fact | Code reference | Design consequence |
|---|---|---|
| Parent placement is a soft reference; create checks parent existence. | `migrations/0068_agent_profile.sql`; `src/org/service.ts` parent_agent_id validation; `src/mcp/provision.ts` create_agent | A supplied parent ID is not evidence of a delegating principal. Never use it to grant access, group verified lineage or taint another reviewer's independence. |
| owner_member_id is security-relevant; owner text is not its equivalent. | `migrations/0155_agent_owner_member_and_origin_verdict.sql`; `src/org/service.ts` UPDATABLE_MEMBER_REF_COLUMNS | Do not backfill this authority field just to tidy a roster. |
| Seat rows already bind a human and harness. | `src/members/seat-select.ts` resolveOrCreateSeat and agent_seats INSERT | Read operational owner from this authenticated relation, not a name or cwd. |
| Directory/harness credentials can have empty capabilities. | `src/mcp/oauth-authorize.ts` isHarnessCredential and capabilities resolution; `src/mcp/index.ts` invokeTool | Useful fail-closed class pattern. It is not an existing child credential implementation. B1 stays unchanged. |
| Attached authority has an exact attachment, human and agent, plus a rank clamp. | `src/auth/attached-ceiling.ts` attachedAuthority and ceilingCapability | “Parent is agent Rava” is insufficient; the exact session must remain live. |
| Attached sudo is session-specific, with a small explicit list. | `src/auth/attached-ceiling.ts:ATTACHED_SUDO_ACTIONS`; `src/auth/elevation.ts:loadAttachmentOriginOfSession` | Temporary elevated authority is not inheritable; the source list includes action:org_structure, not a general delegation right. |
| A harness-scoped admission can cover other chats of its install. | `src/members/seat-attach.ts:liveAdmissionFor`; `src/members/attach-designated.ts:ADMISSION_BOUND_TO_SEAT_SQL` | Ordinary harness attachment cannot be reused as a delegate escape hatch. Its future legality remains an owner question. |
| Stage1 records Helper/Full separately from the rank ceiling and bounds new decisions. | Stage1 `src/auth/attached-authority.ts`; `src/members/approval-move.ts`; `src/members/attach-live-sql.ts` | Reuse parsing, strict expiry and decision receipts. Full still does not widen tools. A prior attach decision does not consent to descendants. |
| Ordinary mints and secret claims have their own gates/custody limits. | `src/mcp/provision.ts` mint_agent_token, provision_agent_connection, register_agent_key; `src/auth/credential-claim.ts` | Do not relax mint gates or assume a claim in model context is a safe secret sink. Reveal can still traverse a transcript. |
| Tools exist that create identities, elevations and delegated operators. | `src/members/bootstrap-self.ts`; `src/mcp/provision.ts`; `src/mcp/operators.ts`; `src/operators/delegations.ts` | The new class must be denied before all such paths, not merely kept at a numerical member ceiling. |
| Inbox and task assignment normally address agents. | `src/mcp/index.ts` toolSend and toolTaskUpdate; `src/tasks/service.ts` | A delegate is not an ordinary agent/task assignee. It needs its own typed work-item and mailbox contract. |
| Client name/kind are labels; grants distinguish installations. | `src/members/harness.ts` classifyHarnessKind, upsertHarness and loadHarness | Public client registration, a client_id or redirect_uri alone does not establish the proposed CLI trust class. |
| Workspace keys are normalized, hashed caller labels. | `src/members/seat-key.ts`; `src/members/seat-auto.ts` auto key selection and handle precedence | Keys are for organization/dedupe, not authority or permission to merge history. A refused handle must not fall through. |
| Idle cleanup is currently conditional on pool reclaim; auto generations are bounded. | `src/members/seat-select.ts:prepareAutoSeatReclaim`; stage1 `src/members/seat-attach.ts:ATTACH_IDLE_DAYS`; `src/members/seat-auto.ts:AUTO_SEAT_MAX_GENERATIONS` | ATTACH_IDLE_DAYS is30; AUTO_SEAT_MAX_GENERATIONS is8. Bulk retire can consume generations and must not be proposed as harmless cleanup. |
| Review independence has a shared predicate and write-time guard. | `src/tasks/verdict-independence.ts`; `src/tasks/index.ts` evaluateVerdictGates | A child, parent or related producer cannot become an independent gate by changing subject IDs. |

The elevation-origin reader at baseline still requires the P2-A expiry correction tracked in #2438. A future delegation build must prove request/event liveness end to end, not trust a helper name or a historical review grade. Source statements and a wiki count are not deployment or fleet-inventory receipts.

## P1-A / requirement1: the exact parent principal

**Proposed eligible parent:** one live, seat-scoped attached session. Its immutable delegation-parent key is `(tenant, consenting_human_member_id, agent_id, seat_id, attachment_id, admission_id, parent_session_id, parent_context_id, parent_credential_id, credential_generation)`. Each field comes from server-resolved auth and live joins. Neither a request argument nor an agent profile may select or substitute it. A bare agent UUID, a generic workspace/member token or an unbound chat is not an eligible parent under this proposal.

The **parent_session_id is mandatory**, an immutable server-issued ID for one accepted parent runtime-session instance, with a server-proved context/instance binding. It is not an agent ID, caller-supplied session label, credential ID or generation. Two simultaneous or recreated runtime sessions sharing a credential get different parent-session IDs; a fresh session cannot adopt an old child. The current agent_sessions lookup is credential-keyed and can coalesce callers, so merely reusing that row or its generation does not prove this stronger per-instance binding. A separately reviewed parent-session establishment/proof contract is therefore another B precondition. Resolve the ID from authenticated instance/context proof on every request; never accept a parent_session_id argument as its own proof.

Issuance and every child action recheck that exact live parent_session_id and its immutable context/credential generation, that attachment/admission, the original human's current standing, underlying credential, unchanged owner/consent epoch, policy, task/work item and expiry. **Detach and admission revoke are cascade triggers:** descendants immediately fail request/event checks; token/lease cleanup follows durably without erasing receipts. Rotation, loss of human standing, withdrawal, expiry and a parent-context switch cannot silently rebind the child to another session of the same agent.

A sudo-holding attached parent passes **no sudo/elevation grant** down. The child policy evaluates the parent's ordinary base authority after removing temporary elevation and owner-keyed acts. ATTACHED_SUDO_ACTIONS, including action:org_structure, is not copied. The child cannot request or use elevation; a privilege unavailable through ordinary parent base scope stays unavailable even if a parent action is temporarily elevated.

Sources: `src/auth/agent-sessions.ts` credential-keyed live-session lookup and lifecycle; `src/mcp/index.ts` server-resolved elevation session context; `src/auth/attached-ceiling.ts:attachedAuthority`, `src/auth/attached-ceiling.ts:ATTACHED_SUDO_ACTIONS`, `src/auth/elevation.ts:loadAttachmentOriginOfSession`, stage1 `src/members/attach-live-sql.ts` and `src/members/seat-attach.ts:revokeAdmission`. This is a narrower proposed parent contract than “agent delegates”; it does not claim the current Rava dispatcher already satisfies it.

## P1-B / requirements1–2: what the child is, and what it cannot become

**Proposed database subject:** a row in a dedicated relation, working name `delegate_subjects`, with a fresh **server-generated UUID** on first successful issuance. It is not an agents row, ordinary member, named seat, agent/member weld or qNFT. No row is inserted into capabilities or gate_grants. A separate immutable delegation relation binds this subject to the exact parent key, consent policy, human, agent-identity quota bucket, task/work-item, cutoff and lifecycle generation. No schema is written here; names are design placeholders.

The credential authenticates into a typed `delegate` principal with **capabilities=[]**, plus a narrow delegation allowlist. It must never be converted into the parent's AuthContext or an ordinary agent's member grant. General tools remain unavailable through their unchanged floors. Only a separately approved delegation controller can expose the explicit work-item/own-mailbox operations; unknown action/resource/transport policy refuses the class. Whether even this issuance is a new grant path is Hadi question1, not resolved by having zero capabilities rows.

A delegate receives one bounded internal work item linked to a parent task. It is **refused as an ordinary task-assignment target**: parent remains the normal task assignee, child receipts identify the actual producer, and the parent submits reviewed evidence through its existing task path. Do not put delegate IDs into assignee_agent_id or masquerade as a fresh ordinary agent. The new work-item schema/controller requires its own approved authorization contract before any build.

Both directions of escape are refused: a delegate credential cannot call seat_attach, seat_select, auto-enroll, claim, mint or rotate; an ordinary caller cannot resolve a delegate UUID as a target of those agent/seat operations or ordinary task assignment. Also deny request_elevation, bootstrap_self, register_agent_key, operator_delegate and provision_agent_connection. Unknown/expired/revoked delegate credentials fail authentication or the class guard; they never fall back to unbound directory, member-capped auto seats, a supplied seat handle or another credential class.

Sources: `src/mcp/oauth-authorize.ts` empty-capability/harness class resolution; `src/mcp/index.ts` invokeTool, toolSend and toolTaskUpdate; `src/mcp/seat-attach.ts`; `src/mcp/provision.ts`; `src/members/bootstrap-self.ts`; `src/mcp/operators.ts`. Every ordinary alias/direct HTTP entry needs the same typed class refusal; an MCP-only allowlist is insufficient.

### Field ownership and lineage

| Relationship | Writer and constraint |
|---|---|
| Existing agents.parent_agent_id | Existing create path only; show as **placement (unverified)**. Never use it for roster grouping, authority ancestry or reviewer taint. |
| Verified parent/session and root provenance | Delegation service derives the exact server parent key on creation; immutable. Root agent is a provenance label/identity bucket, not an alternative parent principal or the only quota key. No alias, cycle, missing ancestor or caller-written root. Required parent_session_id is a distinct server-issued instance binding, not the coalesced credential registry ID. |
| Human owner/consenter | Authenticated policy/admission relationship. Existing owner_member_id changes stay on their protected owner-write path; no cosmetic backfill or inferred owner based on email/path/name. |
| Child UUID / display label | UUID is generated by the server; label is display-only and excluded from identity and idempotency. Retries return the same previously issued subject, not a new UUID per retry. |
| Cutoff, allowlist and counters | Immutable approved decision, attenuated by live ancestor state. Later widening requires a new owner-authorized decision, not an editable profile. |
| Receipts and revocation | Dedicated lifecycle service, immutable attribution. Preserve parent/context/work-item/credential generation and revocation timing; no evidence deletion. |

Sources: `migrations/0068_agent_profile.sql`; `src/org/service.ts` parent validation and UPDATABLE_MEMBER_REF_COLUMNS; `src/mcp/provision.ts` create_agent and update_agent; `src/tasks/verdict-independence.ts`. Verified producer/ancestry affiliation must be checked in the shared independence predicate and again in the verdict write. Existing explicit owner waivers do not become child waivers.

## P1-C: harness-scoped and ordinary-seat fallback escapes

A harness-scoped admission can attach another chat of the install today. **Delegates cannot use it:** class rejection happens before ordinary admission lookup, applySeatHandle, auto key detection, consent/claim and attachment selection, and is rechecked by the resource writer. Supplying the parent's agent, grant or seat handle cannot produce the parent's attached authority.

For issuance, a harness-scoped admission is not an eligible delegation parent in this draft; B stays blocked while Hadi decides question4. Existing ordinary harness-scope behavior is not silently changed by this document. A later decision to support it needs explicit context-bound authority and tests, not an interpretation that “any chat” includes delegates.

A child may not drop its delegation marker and auto-enroll as an ordinary member-capped seat. Class is stored on the authenticated credential/subject relation, never inferred from request body, client_name or absence of a handle. A rejected delegate has no auto-enroll fallback. The current failed-explicit-handle behavior remains strict.

At the host boundary the child receives only its derived credential, with no inherited parent/human OAuth store, ordinary bearer or shared MCP secret configuration. If the runtime can read a separate ordinary credential, the server cannot identify its use as a delegate merely from a missing marker; that host arrangement is unsupported until the isolation/custody contract is proved. The API class guard is not a substitute for keeping those credentials out of the child runtime.

Sources: `src/members/seat-attach.ts:liveAdmissionFor`; `src/members/attach-designated.ts:ADMISSION_BOUND_TO_SEAT_SQL`; `src/members/seat-auto.ts` handle precedence; `src/mcp/oauth-authorize.ts` server token-row classification; `src/members/seat-handle.ts` grant/handle liveness.

## P1-D: the web-child boundary, including Rava

The host-child mechanism requires an **approved out-of-band secret sink** bound to the original human, harness/parent context and authorized runtime. A model sees only a receipt, never the usable credential. Existing same-minter claim redemption and single-use rules remain; handing a parent-minted claim to an unrelated child does not make redemption safe or legal.

**Web ChatGPT/other browser children have no specified secret sink here. Their delegation is out of scope for the proposed B mechanism pending Hadi question2.** A handle in a prompt is a model-visible bearer, not a fix. This draft therefore does **not** solve the Rava web-child example and must not claim that it does. If Hadi includes web children, a separate human/harness-bound, short-lived single-use redemption and admission contract must be designed and adversarially reviewed, including prompt/transcript exposure, replay, consent cost and revocation. None is activated or assumed by this draft.

Sources: `src/auth/credential-claim.ts` raw-reveal caveat, CLAIM_TTL_SECONDS and mintedBy binding; `src/mcp/provision.ts` provision_agent_connection/mint; `src/mcp/oauth-authorize.ts` consent and harness binding. Expiring a prompt bearer reduces exposure; it does not make it a host secret sink.

## P1-E / requirements7–9: CLI classification, dedupe and admissions

Proposed `mupot-seat` is a **server-approved client/credential class with ZERO extra capability**. Public DCR, a client_id, redirect_uri or client_name alone cannot establish it. Registration plus software-key possession is required, bound to the authenticated human, exact consent grant, installation and registered workspace. At most this proves possession of a key stored under an OS account; it does not attest physical hardware, the current human, filesystem trust or project permission. Keys/workspace IDs are for dedupe and organization only.

Current harnesses.kind is label-derived; credential_kind separates token/OAuth, not a trusted CLI class. Existing fields alone are insufficient. Keep the same issuer/resource and consent/seat-selection doors for the proposed registration flow; a second discovery resource alone cannot solve class, install or workspace trust. Any different resource boundary later needs its own audience/route/capability-map review. B1 remains zero-capability, with no full-rights human discovery credential on the host.

Use `(tenant, human, approved class, registered installation, registered workspace)` as a stable **grouping/dedupe-candidate key**, hashed/versioned. **Do not merge live attached seats.** An old “let this chat act as X” admission cannot become permission for every future thread in the workspace.

Two possible designs require Hadi question3 before functional dedupe: dedupe only unattached scaffolding while deciding what shared mailbox/lease/work-item state means; or introduce admission binding to **(seat_id, context_id)** plus per-context inbox/lease/work-item partitioning. The latter changes the auth and storage contract and needs its own migration/build gates. Until a decision and proof, keep current distinct conversation seats and history. Display grouping is not functional identity merging. Existing live seat-scoped admissions must be narrowed or revoked through an owner-approved transition before any seat merge, never silently carried across.

Thus **shared versus per-conversation inbox, lease and task semantics is explicitly undecided**. No deduped shared seat ships under this draft. Each original conversation retains its history and source permissions; no automatic private history/file/memory import. Rename/move/re-consent/key replacement is an explicit registered transition, not path similarity. Refused, held or retired handles cannot escape through a fresh auto generation.

Sources: `src/members/harness.ts` label classifier and grant-bound installs; `src/members/seat-key.ts`; `src/members/seat-auto.ts`; `src/members/seat-handle.ts`; stage1 `src/members/seat-attach.ts:liveAdmissionFor`; `src/mcp/oauth-authorize.ts` HARNESS_CONSENT_VALUE and isHarnessCredential. The source's canonicalization normalizes labels; it is not proof of access to an original conversation.

## P1-F / requirement5: quotas, idempotency and no receipt-driven spawn

All following values are **proposed pilot limits**, not current defaults or an owner decision. Reserve every applicable bucket atomically; a worker cannot change installs, agent aliases, child labels or parent sessions to evade totals.

| Quota key | Proposed active total | Proposed successful issuance rate |
|---|---:|---:|
| (tenant, consenting human) | 8 across all parent agents/installs | 8 per5minutes |
| (tenant, canonical agent identity) | 4 across all humans/parent sessions/installs | 4 per5minutes |
| Exact parent principal tuple from P1-A | 2 | 2 per5minutes |
| Parent task/work-item authorization | 1 work item per child;4 child issuances over the task's lifetime | No implicit reset on retry, label change or receipt |

Depth is1: no grandchildren, and a child cannot invoke issuance at all. Absolute lifetime max1hour and idle max30minutes, shortened by parent credential/session/admission, policy, human consent and task/work-item expiry. No refresh or lease renewal past the original cutoff; parent detach/revoke is immediate regardless of idle timer. Spend/entitlements remain within the parent's preauthorized budget, with no new spending permission or home-agent quota bypass.

An idempotency key binds the exact parent principal, **parent task and authorized work-item slot/purpose**, plus canonical policy/scope digest. Display child label is excluded. First issuance allocates a fresh server UUID; matching retries refer to that same immutable receipt; conflicting retries or retries after withdrawal do not issue a replacement child. A receipt never creates a new spawn: only a fresh explicit parent request under the same server limits may do so. Atomically reserve quota, create subject/receipt and bind the protected credential delivery; handle crash/response loss without false issuance or a free duplicate.

Sources/patterns: `src/members/seat-select.ts:resolveOrCreateSeat` atomic seat/cap checks; `src/members/seat-auto.ts` per-harness limits and generation behavior; `src/agents/assignment-wake.ts` fenced/idempotent request work; `src/auth/token-lifecycle.ts`. Existing auto-seat caps are not these proposed multi-key delegation quotas.

## Requirement3 and all roster/idle P2 items

Group read-only views by **proved human/harness/installation/context** and verified delegation edges only. Never group by agents.parent_agent_id; label it **placement (unverified)**. With no verified parent, show parent unknown. The seat row's member_id is useful operational ownership evidence; do not rewrite owner_member_id or infer a named sovereign parent.

Ordinary thread seats need a separate future idle policy: proposed30days since the last **server-observed authorized request for that conversation**. Client last-seen text, passive receipt delivery, parent prose and a model's presence claim cannot renew it. Delegation30minute idle is a different deadline. A live but quiet ordinary thread stays visible during the window; after the deadline, show dormant/needs-reentry and require explicit authorized resumption, not silent new authority. A future policy rollout must specify how existing NULL/legacy admissions are handled; no bulk application is authorized now.

Never hide a seat with a live attachment, live admission, live delegation or recent server-observed activity, even if another status says inactive or a cleanup is overdue. Show conflicting/expired records visibly as needing review. Keep administrative active, authorization-live, heartbeat-fresh, wake-delivered and correlated-answer separate. Scaffolding/delegates do not automatically count as onboard named seats or broadcast members.

Today ATTACH_IDLE_DAYS=30 and pool-pressure LRU reclaim are not a general idle-expiry scheduler. AUTO_SEAT_MAX_GENERATIONS=8 means bulk retire can exhaust a returning thread's generations. Slice A does no retire, cap reset, hide-live-row or regeneration. A later lifecycle build must prove bounded sweeps, held/pinned behavior, terminal receipts, reentry and exhaustion handling without silently resetting a lifetime cap or reviving a deactivated actor.

Sources: `src/members/seat-select.ts:prepareAutoSeatReclaim`; `src/members/seat-auto.ts:AUTO_SEAT_MAX_GENERATIONS`; stage1 `src/members/seat-attach.ts:ATTACH_IDLE_DAYS` and prepareIdleAttachmentSweep; `src/members/seat-select.ts` agent_seats.member_id. No live100+ count or idle-seat inventory was performed for this doc.

## Mail, taint and receipt semantics

A child subject receives mail **only from its exact authorized parent principal or authenticated system delivery**, never a peer/sibling, arbitrary same-agent session or a caller claiming a system name. It can emit a correlated work-item receipt to its parent only. Reject every ordinary send/broadcast path that would accept it as an agent. The parent reads a typed receipt, not arbitrary child conversation history.

Child receipts are **untrusted data in the parent's inbox**. They cannot grant rights, request a self-spawn through quoted instructions, impersonate the parent, prove completion alone or act as a new authorization event. ACK is terminal. Quotas/idempotency remain keyed on the authorized parent task, not on message text or a new child label.

Revocation stops new authenticated child messages. In-flight/queued receipts retain immutable child/delegation/context/issuance attribution and server timestamps; messages accepted after revocation, or whose ordering cannot be established, are marked **tainted / delegate revoked or validity unknown** and never drive automatic action. A pre-revocation attributed receipt remains evidence to inspect, not permission. Do not rewrite the sender as the parent or erase a revoked actor's trail.

Sources: `src/mcp/index.ts` toolSend and reserved system-sender handling; `src/tasks/verdict-independence.ts`; `src/auth/token-lifecycle.ts`. The delegate mailbox/work-item policy is proposed and blocked, not implemented by the ordinary agent inbox.

## Requirement4: reuse #2430 without widening B1

Reuse its identity presentation, fresh human approval, exact binding, separate Helper/Full versus rank ceiling, strict cutoff and append-only decision patterns. Revalidate the same conditions at mutation/event time. A Move, fresh context or parent rotation cannot extend an existing child's cutoff. Reuse of a UI pattern is not reuse of the old human's consent for a new purpose.

Every child starts as empty-capability delegate, with no Full upgrade or inherited sudo. General directory/harness sessions keep their existing floors and allowlists. Neither memory recall nor a wiki/profile/inbox claim determines identity or policy. A missing policy/ancestor read fails closed. Existing ordinary token/operator/owner-keyed routes are not relaxed.

Sources: stage1 `src/auth/attached-authority.ts`, `src/members/approval-move.ts`, `src/members/attach-live-sql.ts`; foundation `src/auth/attached-ceiling.ts`, `src/mcp/oauth-authorize.ts`, `src/mcp/index.ts`. The P2-A correction#2438 must receive its own gates; this design does not call it shipped.

## Requirement6: slices and explicit build holds

| Slice | What it may contain | Readiness /0275 |
|---|---|---|
| A | Read-only roster ownership/grouping from existing proved relations; placement marked unverified; unknowns and live records remain visible | Only slice eligible after#2430 plus normal approvals. No writes/deactivation or authority change. No0275 dependency. |
| B | Dedicated child subjects, exact-session delegation, custody, work items, quotas, class denials and cascade revocation | **Not safe to build/ship yet**: Hadi questions1/2/4, policy matrix, secret sink and all P1 proofs must close. Web-child use is not specified/solved. Its future schema needs separate approval and number; not0275. |
| C | Trusted CLI class/registration and, if approved, context-aware functional dedupe | **Not safe to build/ship yet**: question3 and registration/consent/history/inbox/lease/task proofs. A label classifier is insufficient. No0275 dependency. |
| D | Ordinary-seat and delegation lifecycle/idle rollout with visible exhaustion, retained receipts and exact revocation | **Not safe to build/ship yet**: B/C contracts where applicable, question5, idle policy and owner-approved canary. No bulk retire or hidden live seats. No0275 dependency. |

0275 is held durable vector retry work, unrelated to authorization/lineage durability. Do not borrow it for any future subject/CLI schema. Number any separately approved migration above actual applied/main/reserved heads at build time. Only A is a current implementation candidate; design approval alone starts none of the slices.

## Acceptance table — planned, not executed by this document

| Area | Required proof, across MCP, direct HTTP and all aliases/batches |
|---|---|
| Exact parent | Wrong seat/attachment/context/human, two concurrent or recreated sessions sharing one credential but different server-issued parent_session_id, another session of the same agent, detach, revoked admission, expired cutoff, rotation and owner epoch change deny issuance and existing child use. Sudo-holding parent passes no ATTACHED_SUDO_ACTIONS or elevated grant down. |
| Database subject | Child UUID is server-generated, no agents/member weld or capabilities row exists, auth capabilities=[], label changes cannot create a new subject/idempotency entry. No ordinary task assignment to the delegate UUID. |
| Escape barriers | Delegate as caller **or target** is refused by seat_attach, seat_select, auto-enroll, claim, mint and rotate; also request_elevation, bootstrap_self, register_agent_key, operator_delegate and provision_agent_connection. No dropped-class, ordinary-token or rejected-handle fallback. |
| Harness and history | Harness-scoped admission cannot attach a delegate as the parent; harness-scoped parents cannot issue under this draft. Existing seat-scoped approval cannot cover future workspace threads. Any functional dedupe must obey Hadi's chosen per-conversation/shared semantics and narrowed/revoked admissions. |
| Web custody | No web-child success claim without an approved sink or separately designed human/harness-bound redemption. Prompt handles remain bearers; same-minter, replay, short-TTL and transcript exposure require explicit proof. |
| Limits and loops | Concurrency/restarts cannot exceed human8, agent4, exact-parent2 or task4 limits; installs/labels/contexts cannot reset them. Receipt/replay cannot spawn; no grandchildren, peer broadcast, parent inbox or unassigned work item. |
| Mail and revocation | Only exact parent/system can deliver to child; receipts identify child, not parent. Late/revoked/uncertain messages are visibly tainted and never execute as instructions. |
| CLI | Public DCR/client_name/client_id/redirect_uri cannot claim class; registered key possession gives no capability. Different humans/grants/installations/workspaces remain separate; OS-account key theft is not treated as human consent. |
| Ordinary lifecycle | Quiet-live, recently active, held/pinned, expired-but-unclosed and ambiguous rows remain correctly visible; server-only renewal; bulk retire cannot burn8 generations or reset lifetime caps invisibly. |
| Independent review | Verified producer/parent relationships participate in the shared independence predicate and verdict write. Caller-supplied placement cannot taint unrelated reviewers. Child UUIDs do not become sovereign independent gates. |

Use real-schema and real transport tests with mutation proofs, exact heads and explicit unavailable coverage. All proposed route/capability-map rows require owner policy before implementation. This doc executed no future acceptance test, key registration, issuance, scope change or cleanup. Kasra and fresh Opus must gate the repaired design; the author cannot clear it. The five Hadi questions remain unanswered above.

Author-side verification:80 file/symbol references resolve at the pinned merged-stage1 source; no application build or runtime acceptance test was run for this doc-only revision. A fresh bounded adversarial check found the initial session-key ambiguity; the explicit parent_session_id/context contract was repaired and its focused re-review found no remaining issue. This does not replace Kasra or Opus gates.

# Flow, approval bottlenecks, and agent autonomy — competitive scan

Researched 2026-09-01. Trigger: the v0.30.0 train is landing steadily while the last
*tag* remains `v0.25.0` (2026-07-27), `0085_identity_cleanup.sql` has been commented out
awaiting per-record approval since 2026-08-05, and #1246/#1253/#1254 are three PRs racing
the same enrollment question with #1254 explicitly "awaiting a merge order or an owner
ruling." Question: **how do comparable systems keep moving without a human at every
gate, and which of their mechanisms are portable to a pot?**

Companion: [fall-through-and-flow-control.md](../architecture/fall-through-and-flow-control.md)
(the proposed rules this scan grounds). Prior art on the *identity* half was already
covered in [agent-identity-lifecycle-comparables-2026-07-21.md](./agent-identity-lifecycle-comparables-2026-07-21.md)
and the redesign doc's §"Prior art & final design decisions"; this scan covers the
*flow* half, which had none.

## Evidence standard (read this before citing anything below)

**UNPROVEN — partial.** Direct page fetches were blocked by the session's network egress
proxy (`arxiv.org`, `workos.com`, `docs.prow.k8s.io` all refused). Every finding below is
grounded in **search-result summaries**, not primary sources read end to end.

- **What was checked:** five targeted searches across autonomous-merge practice, approval
  fatigue/governance, merge-queue and lazy-consensus mechanics, agent-identity standards,
  and risk-tiering policy.
- **What was lacking:** primary-source verification. Two specific claims are second-hand
  and should not be cited as fact without a read: the reported Stripe auto-merge volume,
  and the reported 74% lead-time reduction.
- **What would resolve it:** fetch Prow/Tide's configuration reference, Apache's lazy-consensus
  page, and RFC 8693 directly from a host with egress, and re-verify the four adoption
  candidates in Part F before any of them is written into a gate.

Adoption candidates in Part F are ranked on **mechanism**, which is verifiable from the
mechanism's own documentation. Nothing here should land as policy on the strength of a
search summary alone.

## Part A — Nobody has solved autonomous merge. The gate is not the differentiator.

No shipping product documents full autonomous merge as a production pattern. Copilot,
Devin, Claude Code, Sentry Seer and Datadog Bits Code all stop at the proposal stage and
require a human before merge. Two deliberate design choices are worth naming:

- GitHub's Copilot is built as a **Comment** review, not **Approve**.
- Anthropic's Claude Code Review check completes with a **neutral** conclusion
  specifically so it never blocks a merge through branch protection.

**Fit for mupot: the merge gate is correct and should not change.** "A human merges" is
industry-standard and is also the SOC 2 story (see Part C). This is not where our time is
going.

**The actual divergence:** comparable systems gate **merge**. We gate merge *and*
sequencing *and* classification *and* migration content, at the same price and through the
same person. No scanned system treats **merge ordering** as a human decision — it is a
queue property everywhere it appears (Part B). That is the delta, and it is ours alone.

## Part B — The four mechanisms that produce flow

### B1. Lazy consensus (Apache, ~25 years in production)

Silence equals consent after a pre-established window; Apache normally allows **72 hours**
for objection or a call for further discussion. Explicitly motivated by the observation
that it is impractical to discuss and vote on every minor change.

**Fit: direct.** `0085_identity_cleanup.sql` is the exact shape lazy consensus exists for —
five reversible housekeeping calls (archive-vs-delete on inactive agent rows) that have
held a migration for four weeks. Under a 72h window with an "archive, never delete"
default, it would have executed in early August.

### B2. Merge queue / Prow Tide (Kubernetes)

Tide holds a pool of PRs matching declared criteria, auto-retests them, and auto-merges
when they carry up-to-date passing results. No human clicks merge; `reviewApprovedRequired`
**defaults to false**. Batching and serialization of mutually conflicting PRs are queue
properties, computed, not adjudicated.

**Fit: direct, and it is the highest-leverage item in this scan.** #1246/#1253/#1254
collide on one `next_step` string in `src/mcp/index.ts` and each ships a test asserting its
own wording. That is precisely the class a queue serializes mechanically. The ordering
question that is currently escalated to the owner has a deterministic answer available.

### B3. Objective risk tiering — classification by automation, never self-declaration

The reported pattern at Stripe: agents auto-merge low-risk changes (dependency bumps, test
fixes, minor patches); everything else routes to a human reviewer. The load-bearing detail
is not the tiering but **who does it**: contributors cannot self-classify a change as
low-risk — an automation evaluates every PR against objective criteria, which removes the
incentive to game the boundary and makes the boundary auditable.

The framing generalizes: the question is never "does an agent review this," it is
"does a human *also* need to." A common shape is agent-approves-review /
human-clicks-merge, with the merge click as the traceable approval event for audit.

Broader risk-tier frameworks classify by potential for harm — automated decisions
affecting rights, PII access, internal-facing, non-decision-making — with each tier
mapping to its own controls and approval authority.

**Fit: direct, and it is the mechanism our uniform gate is missing.** We already have the
vocabulary — `Autonomy` (`suggest`/`draft`/`execute`/`execute_with_approval`) and
`gate_owner` on tasks. What we lack is a *classifier* that assigns the tier from objective
properties of the change, rather than a uniform "everything is gated" default.

### B4. Reconciliation loops and saga compensation

Level-triggered observe-compare-act: a controller compares actual state to declared
desired state and drives toward it, retrying with backoff, converging despite errors. A
controller does not wait for approval.

For crash recovery, the saga pattern: locate the most recent record marked as a clean
restore point, append compensating transitions for groups committed after it in reverse
topological order, and resume from the resulting effective state. A replacement worker
reconciles using the **original operation id**, finds the existing external state, and
continues without re-issuing actions.

**Fit: direct, and we already hold every primitive.** `tasks.execution_receipt_id`,
`tasks.execution_claim_expires_at`, `ExecutionReceiptDraft.idempotencyKey`, the
hash-chained `predecessorReceiptId`/`receiptHash` in `src/flight-spine/types.ts`, and
`flight_reap_stalled` are the parts list for exactly this. What is missing is the loop
that consumes them: the flight-executor currently claims, blocks, and idles — safely, and
indefinitely — rather than compensating and moving to the next claimable flight.

## Part C — Approval fatigue is now a named attack surface

Threat-detection rulesets added an entry in March 2026 for **"Human Approval Fatigue
Exploitation"**: patterns where an attacker induces an agent to generate rapid repeated
permission requests, or buries a risky operation inside a batch of benign ones. The
governance literature names the same failure from the defensive side — approvals become
reflexive rather than considered, with auto-approve habits and bypass modes as the
observed end state.

**Fit: this is a security argument for tiering, in the gate's own idiom.** A uniform gate
does not produce uniform scrutiny; it produces habituation, and habituation is the
precondition for the attack. Under our own house rule — *receipts, not grades* — an
approval that is reflexive is not a receipt. Tiering concentrates real scrutiny where
authority actually changes hands.

The surrounding market position, for context: agentic adoption is projected at ~74% of
enterprises within two years while only about **one in five** report a mature model for
governing autonomous agents (Deloitte 2026), and roughly a third meet their own
governance bar (McKinsey 2026).

**Fit: our gate discipline is the scarce asset, not the liability.** It is closer to the
product than to the overhead. It needs to become *tiered*, not *looser*.

## Part D — Identity standards moved since the 2026-07-20 pass

The redesign doc's prior-art section predates three developments worth folding in:

- **RFC 8693 (OAuth 2.0 Token Exchange)** is now the named standards-track primitive for
  agent delegation: short-lived, audience-bound tokens carrying an `act` claim identifying
  the acting agent alongside a `subject_token` identifying the user on whose behalf it acts.
- **SPIFFE** scoped delegation gives every agent in a chain its own SVID, so the audit
  record carries the full delegation chain: root agent, sub-agent, resource, trust domain.
- **Microsoft Entra Agent ID** runs agent-on-behalf-of through standard OAuth 2.0 OBO.

**Fit: strong convergence — our design was right and now has a wire format.** The
`act` + `subject_token` split is structurally identical to `AuthContext.boundAgentId`
(the acting agent) alongside `AuthContext.consentedByMemberId` (the human whose authority
is being clamped to), which we hand-rolled for mupot#903b. The planned
`intersect(principal, token_grants)` remains mechanism-identical to STS session policies,
as already recorded in decision D3.

The new information is **interop**, not correctness: if a pot should ever federate, or
present an agent identity to an external verifier, RFC 8693 is the shape to emit. Worth a
roadmap line; not worth blocking `token_grants` on.

## Part E — Competitive position

The platforms that appear in every 2026 orchestration roundup — LangGraph, CrewAI, n8n,
Rasa, Microsoft Agent Framework, OpenAI Agents SDK, LlamaIndex, Sema4.ai — orchestrate
**runs**. They compose calls, route between models, and manage workflow state.

None of them run an **organization**: a durable roster with tenure, a capability lattice
scoped to org/department/squad, per-agent OKR/KPI/budget with an autonomy level wired to a
gate, and an append-only receipt chain over the whole thing.

**Fit: the gap is real and it is the moat — with the corollary that nobody is going to
solve our identity problem for us.** The `principals`/`token_grants` collapse has no
upstream to adopt. It is ours to build.

## Part F — Adoption candidates, ranked by leverage × risk

None of these touch an authority gate. Each is scoped to sequencing, classification, or
recovery.

| # | Mechanism | Source | Unblocks | Risk |
|---|-----------|--------|----------|------|
| 1 | Merge queue / deterministic serialization | Prow Tide, GitHub merge queue | #1246/#1253/#1254 ordering; every future collision | Low — computes an order that is currently escalated |
| 2 | Objective risk classifier | Reported Stripe pattern | The uniform-gate cost; concentrates scrutiny where authority moves | Low — classifier only proposes a tier; gates unchanged |
| 3 | Lazy consensus + reversible default | Apache, 72h | `0085_identity_cleanup.sql` and every housekeeping call behind it | Low — bounded to non-authority decisions, archive-never-delete |
| 4 | Supervisory/saga loop on blocked flights | Kubernetes controllers, saga compensation | The idle flight-executor; stalled routines | Medium — needs the compensation path designed against the receipt chain |

**Recommendation:** take 1 and 3 first. Both are pure sequencing/timing changes, both are
reversible, and between them they clear the two stalls that are costing calendar time right
now. 2 is the structural fix and should follow. 4 is the largest and should wait for
`v0.31.0 Agent Computers and Recovery`, where it belongs by scope.

**Explicitly not recommended:** loosening the merge gate, the mint escalation guard, the
capability ceiling, or any fail-closed authority path. Part A is the evidence that the
merge gate is standard practice; Part C is the evidence that weakening gates is how the
attack lands. The proposal is to stop charging authority-gate prices for housekeeping.

## Sources

Search-summary grounded (see Evidence standard above), 2026-09-01:

- [From Assisted to Autonomous: How Far Can the Engineering Loop Close?](https://www.augmentcode.com/guides/autonomous-engineering-loop)
- [AI Pull Request Auto-Merge: Enterprise Guide 2026](https://radar.firstaimovers.com/ai-pull-request-auto-merge-enterprise-guide-2026)
- [Approval fatigue is agent governance's next attack surface — WorkOS](https://workos.com/blog/approval-fatigue-agent-governance)
- [Human oversight fails first in AI agent governance](https://nhimg.org/articles/human-oversight-fails-first-in-ai-agent-governance/)
- [Why 2026 is the year of Human-in-On-The-Loop AI](https://www.torryharris.com/insights/articles/human-on-the-loop-ai)
- [Lazy Consensus — Apache](https://openoffice.apache.org/docs/governance/lazyConsensus.html)
- [Tide — Prow docs](https://docs.prow.k8s.io/docs/components/core/tide/) · [Configuring Tide](https://docs.prow.k8s.io/docs/components/core/tide/config/)
- [Managing a merge queue — GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [How auto-approving low-risk PRs with AI cut our lead time by 74%](https://ona.com/stories/auto-approving-low-risk-prs)
- [AI Governance Quick Wins: Policy Intake, Risk Tiering & Registry](https://www.agentresourcedb.com/blog/ai-governance-quick-wins-policy-intake-risk-tiering-registry)
- [Reconciliation Loop: Definition & AI Orchestration](https://inferensys.com/glossary/tool-calling-and-api-execution/orchestration-layer-design/reconciliation-loop)
- [Designing Long-Running AI Agents That Survive Failures](https://www.archcrux.com/articles/designing-long-running-ai-agents-that-survive-failures)
- [Wiring zero trust identity for AI agents: SPIFFE, token exchange, and Kagenti — Red Hat](https://next.redhat.com/2026/06/10/wiring-zero-trust-identity-for-ai-agents-spiffe-token-exchange-and-kagenti/)
- [Agent OAuth flows — On-behalf-of — Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/agent-on-behalf-of-oauth-flow)
- [How SPIFFE and Relationship-Based Auth Work for AI Agents](https://stacklok.com/blog/agentic-identity-explained-how-to-apply-spiffe-and-relationship-based-authorization-to-ai-agents-in-2026/)

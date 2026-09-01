# Fall-through and flow control

**Status:** Design proposal, 2026-09-01. Not ratified, not scheduled. Requires the
Kasra exact-head gate and the Athena adversarial pass like any other change.
**Scope:** sequencing, classification, and recovery. **Touches no authority gate.**

Companion: [flow-and-approval-comparables-2026-09-01.md](../research/flow-and-approval-comparables-2026-09-01.md)
(the external scan this design is grounded in — read its Evidence standard first).
Adjacent: [identity-access-fix-map.md](./identity-access-fix-map.md) (Phase 0 there and
Rule 3 here clear the same stall from different sides).

## The finding

**The codebase has excellent fail-closed discipline and almost no fall-through
discipline.** Every gate has a refuse branch. Very few have a "refuse, *and here is the
next move*."

The result is a system that is safe at rest and stops completely. Four live instances:

| Stall | Where | Current behavior | Standing since |
|---|---|---|---|
| Flight executor idles | `src/flight/watchdog.ts`, `flight_reap_stalled` | Claims the flight, cannot find the `situation_digest` in the assigned agent's inbox, refuses to fabricate one (correctly), and blocks — indefinitely, without releasing to the next claimable flight | 2026-08-08 ([the-keystone-agent-receiving.md](../spine/the-keystone-agent-receiving.md)) |
| Identity cleanup migration | `migrations/0085_identity_cleanup.sql` | Entire body commented out pending per-record approval; five reversible archive/delete calls | 2026-08-05 |
| Enrollment PRs collide | `src/mcp/index.ts` `next_step` | #1246, #1253, #1254 each rewrite the same string with a test asserting its own wording; #1254 states it is "awaiting a merge order or an owner ruling" | 2026-08-31 |
| Routines park | `preferred_agent_id` → ghost `kasra` | `waiting(agent)` / `agent_offline` forever; the label means "assigned to a ghost identity," not "host down" ([AGENTS.md](../../AGENTS.md)) | pre-2026-08-06 |

None of these is an authorization failure. Every one is a **missing continuation**.

The rails we hand every agent at induction close the same way — `src/orient/service.ts`
`RAILS`: *"Rest when there is no defect. Do not invent work to look busy."* Correct against
entropy, and also a full stop: an agent that cannot do A is not handed B.

### The pattern already exists, once

PR #1254 states the rule in its own test name, and it is already on `main` at
`src/mcp/index.ts:4106`:

> **QA-1: dead-end refusal must carry the map out.**

Every MCP dead end that cannot resolve an identity now returns an `enroll_url`. That is
the whole design, implemented at one endpoint. This document proposes promoting it from a
local fix to an operating rule.

## The classification that makes it safe

**Fail closed on authority. Fail forward on everything else, with a reversible default.**

The gate is currently uniform: a migration's archive-vs-delete call and a production
credential mint are both "wait for the owner." They are not the same decision and must
not carry the same price.

| Class | Definition | Rule | Examples |
|---|---|---|---|
| **Authority** | Changes who can do what, or what reaches a customer | **Fail closed. Unchanged.** No default, no clock, no automation. | Mint, elevate, grant, revoke; merge to `main`; deploy; tag; branch protection; constitution amendment; anything writing `capabilities` |
| **Housekeeping** | Reversible, internal, no authority transfer | **Fail forward** on a stated default after a stated window | Archive an inactive agent row; de-dup a churned member with zero live tokens; label; close a superseded PR; retire a dormant seat |
| **Sequencing** | The order of work already individually approved | **Compute it.** Never a ruling. | Merge order among gated PRs; which flight to claim next; which task to route |
| **Recovery** | Resuming after a stall or crash | **Compensate and continue** from the receipt chain | Blocked flight; expired claim; crashed runtime; stale lease |

The security argument for this split is in the scan, Part C: a uniform gate does not
produce uniform scrutiny, it produces habituation, and "Human Approval Fatigue
Exploitation" is a named attack pattern as of March 2026. Under *receipts, not grades*, a
reflexive approval is not a receipt.

## The five rules

### Rule 1 — Every refusal carries its continuation

Generalize `QA-1`. A refusal returns *what was refused*, *why*, and *the next legal move*.
This is a response-shape rule, not an authorization change: the refusal still refuses.

```
refuse(reason)                    →  refuse(reason, next: <the legal path>)
```

| Refusal | Continuation it must carry |
|---|---|
| Capability check fails | The enroll / elevate path (built — `enroll_url`, `bootstrap_self`) |
| Flight blocked on a missing input | The next claimable flight for this seat |
| Task has no assignable agent | The escalation target from `resolveSupervisor` |
| Gate awaits a verdict | The stated default and the clock (Rule 3) |
| PR conflicts with another PR | Its position in the queue (Rule 4) |

### Rule 2 — UNPROVEN gets a fourth part

MU.100.001 §2.2 requires three parts: what was checked, what was lacking, what would
resolve it. Add: **what I am doing meanwhile.**

A structured stall with no continuation is still a stall. The fourth part may legitimately
be "nothing — this seat is idle by design," but it must be *stated*, which makes an idle
seat visible as a decision rather than invisible as a silence. This is an amendment to
the law layer and therefore needs 2-of-4 Council plus the founder's seal, per §1.2. It is
proposed here, not adopted.

### Rule 3 — Default-and-clock for housekeeping only

A housekeeping decision is published with its default and its window; silence executes
the default. Apache's lazy consensus at 72 hours is the reference (scan §B1).

Binding constraints:

1. **Housekeeping only.** An authority decision has no default, ever.
2. **The default is the reversible direction.** Archive, never delete. Suspend, never drop.
3. **The clock starts on publication**, and publication means an owner-visible surface —
   not a comment in a file nobody opens.
4. **Objection stops the clock**, and reopens it as a normal decision.
5. **Execution writes a receipt** naming the default, the window, and the silence, so the
   audit trail shows a *decision*, not an omission.

`0085_identity_cleanup.sql` is the test case: five archive-vs-delete calls on inactive
`hadi`/`codex` agent rows, all reversible, none touching authority. Under this rule the
migration would have executed in early August with an archive default and a receipt.

### Rule 4 — Sequencing is computed, never adjudicated

Merge order among individually gated PRs is a queue property (scan §B2). Adopt a
deterministic rule and let it decide.

Proposed tie-break, in order:
1. A PR that **branches on state** beats one that hard-codes a single state's string.
   (This is #1254's own analysis of the #1246/#1253/#1254 collision: the three are answers
   to three *different* caller states, and branching makes all three additive.)
2. Otherwise, earliest exact-head gate receipt wins; the rest rebase onto it.
3. A rebase that turns another PR's test red is that PR's author's work, not a blocker on
   the queue.

The owner keeps merge authority. The owner stops being asked *what order*.

### Rule 5 — Classification is objective, never self-declared

A change's tier is assigned by an evaluator against declared criteria — never by the
author, human or agent (scan §B3). The classifier **proposes a tier; it never opens a
gate.** An authority-tier change is gated exactly as it is today.

This is the rule that makes Rules 3 and 4 safe: they apply only to what the classifier
placed outside the authority tier, and the placement is auditable.

## Invariants (what this must never do)

1. **No authority gate is loosened.** Mint, elevate, grant, revoke, merge, deploy, tag,
   branch protection, and constitution amendment keep their current gates exactly.
2. **A default never elevates.** The reversible direction is always the *lower*-privilege
   one. Empty grants remain zero, never full (fix-map S4).
3. **The classifier proposes, the gate disposes.** Misclassification must never open a
   door; the worst case is that an authority change waits for a human, which is today's
   behavior.
4. **Continuations are legal moves only.** A refusal's `next` must be a path the caller is
   *already* authorized to take. Rule 1 changes response shape, never authorization.
5. **Every fall-forward writes a receipt.** Silence-as-decision must be as auditable as a
   signature.
6. **The owner can stop any clock**, and stopping is not an exception path — it is the
   objection branch working as designed.

## Adoption sequence

**Phase 0 — no schema, no behavior change, no approval required**
- Audit every refusal path for a missing continuation; file the list. Read-only.
- Implement Rule 1 on the three refusals that already have a legal next move built
  (`enroll_url`, `bootstrap_self`, `resolveSupervisor`).
- Land the fix-map's own Phase 0 alongside: collapse the five `isAdmin` implementations
  into one `isOrgAdmin(auth)`, drop `canOn*` in favour of `hasCapability`, and turn the
  three durability detection queries into a scheduled integrity check.

**Phase 1 — sequencing**
- Adopt Rule 4's tie-break and apply it to #1246/#1253/#1254. Costs one written rule and
  unblocks three gated PRs.

**Phase 2 — housekeeping clock**
- Implement Rule 3's publication surface and receipt. First subject: `0085`.

**Phase 3 — classifier**
- Rule 5 against declared criteria. Feeds Rules 3 and 4 with an auditable tier.

**Phase 4 — recovery loop** *(defer to `v0.31.0 Agent Computers and Recovery`)*
- Supervisory/saga loop over the receipt chain: on a blocked flight, compensate from the
  last clean receipt and release the seat to the next claimable flight. The primitives
  exist (`execution_receipt_id`, `execution_claim_expires_at`, `idempotencyKey`,
  `predecessorReceiptId`, `flight_reap_stalled`); the loop that consumes them does not.

## Open questions for the gate

1. **Rule 2 amends MU.100.001 §2.2** and therefore needs 2-of-4 Council plus the founder's
   seal, SHA-bound per §1.3. Should the fourth UNPROVEN part instead live in the spine
   (MU.100.002) as state, leaving the law untouched?
2. **Is 72 hours the right window** for a pot whose fleet operates on an hourly sweep?
   Apache's number comes from human mailing lists. A shorter window may be correct here,
   and the sweep cadence is an argument for it.
3. **Rule 4 tie-break #1** encodes a design opinion (branch on state) as a merge rule. Is
   that a queue property or a review property? If a review property, the queue needs a
   different first tie-break and this one moves to the gate checklist.
4. **Who owns the classifier's criteria?** They are policy. If an agent may edit them,
   Rule 5's guarantee weakens to the strength of that edit path — which is an authority
   decision about an authority-adjacent artifact.

## Lineage

- 2026-09-01 — v1, drafted against the four live stalls above and the external scan.
  Proposal only; no rule here is in force.

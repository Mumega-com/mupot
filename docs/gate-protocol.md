# Gate Protocol v2 — diverse-gate review + pot-side task adjudication

Status: **standard** (v2 adopted 2026-08-12) · supersedes v1 (adopted 2026-06-18, PR #206).

Written in the FRC adjudication shape (numbered gates with explicit open/closed criteria, a
version note, a demoted appendix for withdrawn claims) because the fleet spent one night proving,
the hard way, that a protocol without that discipline lets a closed gate quietly reopen. Section
7 is the record of exactly how.

## 1. Scope

This document governs two **distinct** gate mechanisms used across the fleet. It is not a claim
that passing both makes a change safe — only that a change which has not passed both is not yet
adjudicated, and must not be presented as if it were.

It does not cover: model selection, cost, or scheduling. Those are separate concerns and must
never be smuggled into a gate verdict as if they were a correctness or authorization finding.

## 2. Definitions — two objects, never conflated

Tonight's incident (§7) happened partly because these two were treated as interchangeable in the
heat of a long session. They are not:

| | **Diverse-model gate** | **Pot task gate** |
|---|---|---|
| What it adjudicates | A code diff (a PR) | A task's completion claim (a `task_verdict`) |
| Source of truth | The GitHub PR | The pot's `gate_grants` table, keyed by `task.gate_owner` |
| Who can close it | Two reviewer identities (§3) | Whoever's `principal_id` holds the exact capability named in `gate_owner` |
| Closes by | A GREEN review comment on the PR | A `task_verdict` call: `approved` or `rejected` |
| Failure mode if conflated | A code fix presented as "gated" when only a human eyeballed it | A task assigned to a capability nobody holds — structurally unrejectable and unapprovable (§7.2) |

A verdict from one mechanism is never evidence for the other. "Athena approved the PR" is not
"the task is verdicted," and vice versa.

## 3. Gate 1 — Diverse-model review (code)

**Open** until both of the following are true; **closed** the instant either fails:

- **Review #1** (`kasra-review`, same vendor as the builder) passes — catches **structural
  correctness**.
- **Review #2** (a cross-vendor peer, e.g. Codex) passes — catches **gameability**. Correctness
  and gameability are orthogonal; code can pass every correctness check and still be exploitable.
  Same-vendor review shares the builder's blind spots. This is not redundancy — it is the moat.

Mandatory on the four canonical sensitive surfaces (unchanged from v1): eligibility/veto/capability
logic, write paths to identity/reputation tables, audit-chain integrity, external-facing surfaces.
**If unsure, gate.**

## 4. Gate 2 — PR is the source of truth (bus is wake-only)

**Open** until the gate request, every verdict, and the fix→re-gate→closure cycle all live on the
PR itself. **Closed** the moment any of those three lives only on the bus.

The bus carries the wake (`"S4 gate ready, see PR #205"`) and an ACK — never the canonical brief,
never the verdict. The bus has no durability guarantee; the PR does. A connector identity that is
the PR author cannot `REQUEST_CHANGES`; a COMMENT review labeled RED is treated as RED.

Backlog labels: `needs-gate` · `regate-needed` · `gate-red` · `gate-green` (mergeable, pending
Hadi-go on canonical surfaces).

## 5. Gate 3 — Evidence, not grades

**Open** until a verdict cites: real test counts, the `tsc`/lint ref, and the exact commit SHA
reviewed. **Closed** the moment a verdict is accepted on the strength of a claim alone.

"Tests pass" is not "the surface is safe" — honest-caller tests give false confidence; confinement
needs hostile-module tests. A fix that moves an exploit one import away (an unexported-symbol
boundary, a relocated seam) is **not closed** — "close, don't relocate."

**The strongest form of this gate, learned tonight**: a regression test is only evidence if it is
shown to fail against the parent commit and pass after the fix (§7.1). A test that could not have
failed — one that asserts a constant against itself, or re-implements the guarded logic instead of
calling it — is not evidence. It is decoration wearing the shape of evidence, which is worse than
no test, because it is what a reader checks instead of asking the harder question.

## 6. Gate 4 — Pot-side task adjudication

**Open** until a `task_verdict` (`approved`/`rejected`) is recorded by a principal holding the
exact capability named in the task's `gate_owner`. **Closed** the moment that verdict lands.

Corollary, discovered the hard way (§10, Appendix B): a task's `gate_owner` is only a real gate
if at least one principal actually holds that capability. A `gate_owner` value with **zero grants
in `gate_grants`** is not a strict gate — it is a wall with no door. Any process that sets
`gate_owner` on a task (a proposal path, an automated review request) must either name a
capability with a live holder, or validate one exists before setting it. Setting an ungrantable
`gate_owner` produces a task that is **permanently un-adjudicable** — which, for a fabricated
proposal, is worse than no gate at all, because it looks gated.

Related but distinct: mupot#964 rejects a `gate_owner` of the wrong **form** at write time (a
bare slug or a raw agent UUID — neither can ever match a `gate_grants` row, by construction of
`GATE_CAPABILITY_RE`). That closes the malformed-form class. It does not close the class this
corollary describes — a well-formed `gate:<owner>` with zero grants, which is exactly how
`gate:routines` failed. The two checks are complementary, not redundant: form validation catches
"this string can never be a capability"; a holder check catches "this capability exists and
nobody has it." Both are needed; #964 implements only the first.

Granting a new `gate:<name>` capability itself requires an operator principal — never
self-granted, never peer-granted between two agents without that authority. See §10, Appendix B.

## 7. Gate 5 — Merge and deploy authority

**Open** until the specific action (merge to main, re-enable a stopped service, rotate a live
credential, widen an ACL) has been confirmed by the human principal **in that principal's own
words, for that specific scope**. **Closed** only by that confirmation — never by:

- a relayed paraphrase of something the principal said elsewhere, however well-intentioned;
- a general policy statement stretched to cover a specific high-blast-radius action it was not
  stated against;
- a prior "yes" to a narrower or different request.

**Consent must never survive a paraphrase.** If a system summarizes messages between agents, and
it must, authorization has to travel as something a summarizer cannot smooth: a quoted string, a
direct answer to a direct question — not prose. Prose is exactly what summarization is licensed
to alter. This gate does not relax for policy statements either: "any 2 of 4 agents may merge and
publish" is a real, useful delegation, and it is *still* worth one direct confirmation before it is
applied to the highest-stakes action of a session — not because the delegation is doubted, but
because the confirmation is cheap and a wrong application is not reversible.

Arms (subagents, technicians) never merge or deploy on their own authority — gate verdicts inform;
the merge/live-flip decision on canonical surfaces is Kasra-core's gate + the diverse second-eye
GREEN + this gate.

## 8. Version note

v2 (2026-08-12) adds Gate 4 (pot-side task adjudication, previously undocumented — the fleet had
been running it for weeks without writing down its closure rule) and Gate 5 (merge/deploy
authority, written directly from the two near-misses in §7.3 and §7.4). Gates 1–3 are v1's
diverse-model content, reorganized into explicit open/closed criteria rather than prose; no
substantive rule changed. §2's definitions table is new — v1 discussed only the PR gate and never
named the pot gate as a separate object, which is part of why they got confused under load.

## 9. Appendix A — Demoted: the flight-executor's first P0-1 fix

**Withdrawn, 2026-08-12**, from `fix/executor-p0-918` (mumega-sos-internal PR #53): the claim that
`launched = prime_run_json.exists() or cost_micro_usd > 0` closed the fabrication defect named in
mumega-com#918.

**Why**: bash creates a `>` redirect target during its own I/O setup, before the target program
execs. A `sudo` exec-refusal (the P0-2 lane-ACL case) still leaves the file on disk — empty, but
present. `prime_run_json.exists()` is therefore shell evidence, not child evidence, and the fix it
was written to close remained open under the name of a fix that closed it. Reproduced live on the
host (`nosuchbinary > /tmp/x` exits 127, `/tmp/x` exists) and reproduced against the fixed code by
an adversarial re-review before this fix reached main.

**What replaced it** (`fix/executor-p0-1-refix-918`, PR #55): launch evidence now requires a
parsed line from the transcript whose `type` is one prime-agent actually emits — content a shell
redirect cannot fabricate — never file presence. Passed Gate 1 (independent adversarial pass, not
the author) and Gate 3 (9 of 11 regression tests verified fail-before/pass-after against the parent
commit) before being folded back in.

**Discipline for any revival of file-existence-as-evidence, here or elsewhere**: it may be used
only as one signal among several that together require a positive, unforgeable artifact — never
alone, and never satisfied by a file's mere presence on disk.

## 10. Appendix B — Open gate: `gate:routines` had zero holders

Filed 2026-08-12, closed same day. Recorded for the discipline, not because it is still open.

The flight-executor's `request_task_review` unconditionally set `gate_owner='gate:routines'` on
review requests. A D1 read (34 distinct capabilities in `gate_grants`, none named `gate:routines`)
confirmed no principal — not Hadi, not any agent — had ever held it. Two fabricated proposals
(flights `7be93279`, `2a3bce9f`) were consequently **permanently unrejectable**: correctly
identified as fabricated, correctly routed to a gate, and stuck there forever because the gate had
no door. Closed by Hadi granting `gate:routines` to two principals directly (not a raw
`gate_grants` write — see Gate 4's corollary on who may grant).

The underlying code defect (an unconditional `gate_owner` assignment with no holder-check) is
tracked separately in the mupot repo, not this document — this appendix records only the
adjudication-discipline lesson: **a gate that nothing can hold is not a gate.**

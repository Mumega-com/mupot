# Gate Protocol — diverse-gate review, on GitHub as the source of truth

Status: **standard** (adopted 2026-06-18) · supersedes ad-hoc bus-only gating.

Every change to a **sensitive surface** is reviewed by a **diverse-model gate** before merge, and
the gate's **source of truth is the GitHub PR** — not the bus. The bus is wake/notification only.

## 1. When a gate is required

Diverse-gate is **mandatory** on the four canonical sensitive surfaces (and any security/identity/
external-facing change):
1. Eligibility / veto / capability logic (auth floors, gates, capability resolvers).
2. Write paths to identity / reputation / authority tables.
3. Audit-chain integrity (signing, receipts, hash chains).
4. External-facing surfaces (the act/executor path, connectors, public APIs, SCIM/SSO).

If unsure, gate.

## 2. The diverse-model rule (why two reviewers)

The reviewer model **must differ from the builder**, and the gate uses **two lenses**:

| Role | Who | Vendor | Catches |
|---|---|---|---|
| Builder | `kasra-code` (Sonnet) | Anthropic | — |
| Review #1 | `kasra-review` ("Opus", `model:'opus'`) | Anthropic (same family) | **structural correctness** |
| Review #2 | **Codex** (bus peer) | **OpenAI / GPT** (cross-vendor) | **gameability** |

Correctness and gameability are **orthogonal** — code can pass every correctness check and still be
exploitable. The same-vendor lens (Opus) shares the builder's blind spots; the **cross-vendor lens
(Codex) catches what the Claude lens misses.** This is not redundancy — it is the moat. (Evidence:
across one build session the cross-vendor lens caught a real exploitable vector in *every* round the
same-vendor review had passed — false-idempotency, ctx-escape theater, token theft, mutable
manifests, key-shadowing, a data-model honesty bug.)

A surface is **GREEN only when BOTH lenses pass.** Either RED blocks.

## 3. The PR is the source of truth (bus = wake-only)

Durable, searchable, linked to code + CI, no missed/advanced bus cursors. So:

- **Gate request** → a PR comment (or the PR body): the commit ref + what to attack.
- **Verdict** → a PR review/comment: `RED` or `GREEN`, with **file:line findings** and a concrete
  exploit/trace per finding. (A connector identity that is the PR author can't `REQUEST_CHANGES`;
  a COMMENT review labeled RED is treated as RED.)
- **Fix → re-gate → closure** → all on the same PR. The PR history *is* the audit trail.
- **The bus carries only the wake:** `"S4 gate ready, see PR #205"` + an ACK. **Never** the canonical
  brief or the verdict. (The bus has no durability guarantee — recall/remember dropped repeatedly in
  the session that motivated this; GitHub did not.)

## 4. Backlog labels (the queue lives in issues/PRs)

- `needs-gate` — diverse-gate requested, not yet run.
- `regate-needed` — fixes pushed, awaiting re-gate.
- `gate-red` — a gate returned RED (blocking).
- `gate-green` — both lenses GREEN (mergeable, pending Hadi-go on canonical surfaces).

## 5. Discipline (no fake green)

- **Receipts, not grades** — a verdict cites real test counts + `tsc` + the exact ref. "Tests pass"
  is not "the surface is safe" (honest-caller tests give false confidence; confinement needs
  hostile-module tests).
- **Close, don't relocate** — a fix that moves an exploit one import away is not closed (see the
  recurring "moved not closed" pattern: unexported-symbol boundaries, relocated seams).
- **Arms never merge/deploy** — gate verdicts inform; merge + live-flip on canonical pots = Kasra-core
  gate + the diverse second-eye GREEN + **Hadi's direct go**.

## 6. Repo-local fallback (when bus AND live GitHub are both iffy)

For headless/offline continuity, a gate record may be committed to `docs/gates/` with the branch
(see `docs/gates/README.md`): `docs/gates/<pr-or-branch>.md` holding the request + verdicts. This is
a *fallback mirror*, not the primary — the PR remains canonical when reachable. It guarantees the
gate trail survives even a total bus + API outage, committed alongside the code it gates.

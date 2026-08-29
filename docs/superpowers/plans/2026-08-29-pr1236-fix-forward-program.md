# PR #1236 Fix-Forward Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #1236 with seven bounded, sequential, clean-main deliverables without merging or extending the omnibus branch.

**Architecture:** Each slice is an independent PR created only after the prior required merge is present on `origin/main`. Kasra implements test-first, Lumen reviews internally, Athena gates the immutable head with an Artifact+SHA256, Loom records the sequencing receipt, and only Hadi may authorize merge or external mutation.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1/SQLite, Vitest, Wrangler, GitHub Actions, Mupot MCP.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Never merge, extend, or implement on PR #1236.
- Start every implementation branch from a freshly fetched `origin/main`; the design-time base was `41330115de7304c95654f57949b41c24761b2e8f`.
- Do not begin Slice 1 until Athena returns the MSG-01 verdict and Loom issues Slice 1 GO.
- One slice, branch, worktree, PR, immutable head, Lumen review, Athena Artifact+SHA256, and Loom receipt at a time.
- Every behavioral claim needs a failing adversarial regression and a load-bearing-predicate mutation witness.
- Typecheck, the complete Vitest suite, repository guards, migration compatibility, local D1 evidence, and required GitHub checks must exit zero at the exact head.
- Never merge, deploy, rotate a live credential, apply a remote migration, or mutate production without Hadi's separate authorization.
- Never print, persist, or include raw credentials in tests, artifacts, commits, logs, or messages.

---

## Slice Plans

Execute in this order. Do not stack later slices on an unmerged parent.

1. `2026-08-29-ci-foundation.md`
2. `2026-08-29-credential-rotation.md`
3. `2026-08-29-governance-identity-2fa.md`
4. `2026-08-29-router-loop-meter-authorization.md`
5. `2026-08-29-delivery-fencing-presence.md`
6. `2026-08-29-msg01-integrity.md`
7. `2026-08-29-fix-forward-integration-audit.md`

## Program Control Task

**Files:**
- Read: `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`
- Read: the current slice plan listed above
- Create per slice: the fixed receipt filename named in that slice's Exact-Head Gate task

**Interfaces:**
- Consumes: Athena MSG-01 verdict, Loom slice GO, freshly resolved `origin/main`, GitHub exact-head checks.
- Produces: `SliceReceipt { slice, base_sha, head_sha, focused_commands, full_suite_exit, required_checks, lumen_artifact, athena_artifact, athena_sha256, loom_request_id }`.

- [ ] **Step 1: Resolve authority before each slice**

Read the unconsumed Kasra inbox and require both the prior Athena verdict and a Loom GO naming the slice. Record inaccessible context as `UNPROVEN`; do not infer authorization from a queued request.

- [ ] **Step 2: Materialize an isolated exact-main worktree**

Use the exact row for the authorized slice:

| Slice | Worktree | Branch |
|---|---|---|
| CI foundation | `../mupot-ci-foundation` | `fix/ci-foundation-20260829` |
| Credential rotation | `../mupot-credential-rotation` | `fix/credential-rotation-20260829` |
| Governance/2FA | `../mupot-governance-2fa` | `fix/governance-2fa-20260829` |
| Router/loop/meter | `../mupot-router-loop-meter` | `fix/router-loop-meter-20260829` |
| Delivery/presence | `../mupot-delivery-presence` | `fix/delivery-presence-20260829` |
| MSG-01 | `../mupot-msg01-integrity` | `fix/msg01-integrity-20260829` |
| Integration audit | `../mupot-fix-forward-audit` | `test/fix-forward-audit-20260829` |

```bash
git fetch origin main
git worktree add ../mupot-ci-foundation -b fix/ci-foundation-20260829 origin/main
git -C ../mupot-ci-foundation rev-parse HEAD
git -C ../mupot-ci-foundation status --short
```

The command block shows Slice 1; for later slices substitute the complete worktree and branch strings from the table. Expected: the recorded base equals current `origin/main`, and status is empty.

- [ ] **Step 3: Execute the slice plan test-first**

Use the matching plan file and commit each independently testable task. Do not copy an omnibus commit; manually port only understood, in-scope code.

- [ ] **Step 4: Produce exact-head evidence**

```bash
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

Expected: every command exits `0`. Record stdout summaries, exit codes, base SHA, and head SHA without secrets.

- [ ] **Step 5: Run the independent gates**

Request Lumen review first. Resolve all Critical and Important findings, rerun the complete evidence set, then request Athena review of the new exact head. The Athena message must name the artifact path and SHA256.

- [ ] **Step 6: Stop for Hadi's merge decision**

After Loom composes the receipt, report the immutable head and verdict. Do not merge or start the next slice until Hadi acts and the merge SHA is verified as an ancestor of refreshed `origin/main`.

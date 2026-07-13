# Mupot Stable vNext Flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a defensible `v0.23.0 - Trusted Runtime` release decision through a governed Mupot flight in which execution, independent review, browser/runtime verification, and durable evidence are owned by distinct human and AI teammates.

**Architecture:** GitHub issues #281 and #284 remain the authoritative release gates. The flight uses the existing Mupot receipt verifiers as executable policy, a named release PR as the immutable check target, SOS/Hermes for peer activation, and GitHub comments or release assets for redacted durable evidence. The product-manager agent coordinates and integrates; delegated workers collect evidence and review the decision without receiving or duplicating credentials.

**Tech Stack:** TypeScript, Node.js, Vitest, Playwright browser smoke, Cloudflare Workers/Wrangler/D1, GitHub Actions and CLI, Mupot receipts, SOS/Hermes.

## Flight Contract

- **Release target:** `v0.23.0 - Trusted Runtime`; do not expand scope to GA billing, marketplace, new departments, GCP portability, or autonomous brain work.
- **Authoritative branch:** `codex/stable-vnext-flight`, based on `main` at `6008262c210e71f1424b42705a2027e332d038a7`.
- **Product manager/integrator:** `hadi-codex`.
- **Execution peer:** `hadi-codex-cli` through Hermes/SOS.
- **Independent reviewer:** `kasra`.
- **Local independent reviewers:** delegated Codex explorers for evidence, CI/browser coverage, and release sequencing.
- **Human gate:** publication is allowed only after the exact release-integrity and aggregate-readiness receipts pass. No secret material is copied into the repository or evidence bundle.
- **Done:** a named release PR has all required checks; all objective evidence is retrievable and passes; #281 and #284 contain durable proof; stable metadata, tag, milestone, and GitHub Release agree; browser/runtime smoke passes; the flight lands with either `release-ready` or a precise blocker list.

---

### Task 1: Freeze Scope and Baseline the Candidate

**Files:**
- Create: `docs/superpowers/plans/2026-07-13-mupot-stable-vnext-flight.md`
- Read: `docs/releases/v0.23.0-trusted-runtime.md`
- Read: `scripts/release-integrity-receipt.mjs`
- Read: `scripts/release-readiness-receipt.mjs`

- [x] **Step 1: Confirm tracker state**

Verify issues #150, #151, #274, #277, #279, #280, #282, #283, #319, and #323 are closed; only #281 and #284 may remain open in milestone 6.

- [x] **Step 2: Run the complete local evidence suite**

```bash
npm ci
npm run typecheck
npm test
node --test fleet-runtime/*.test.mjs
npm audit --audit-level=high
npx wrangler deploy --dry-run --config wrangler.example.toml
bash scripts/ci-local-evidence.sh
```

Expected: every command passes from the isolated worktree. Record exact test and workflow counts in the PR.

- [x] **Step 3: Commit the flight contract**

```bash
git add docs/superpowers/plans/2026-07-13-mupot-stable-vnext-flight.md
git commit -m "docs: plan v0.23 stable release flight"
```

---

### Task 2: Register and Delegate the Flight

**Durable records:**
- GitHub release-flight issue linked to #281 and #284
- SOS request/ACK IDs for `hadi-codex-cli` and `kasra`
- Mupot flight/task IDs when the authenticated local/live surface is available

- [x] **Step 1: Create one release-flight issue**

The issue must name the goal, branch, roles, acceptance gates, evidence locations, and rollback boundary. It must not duplicate #281 or #284.

- [ ] **Step 2: Assign bounded work**

Ask `hadi-codex-cli` to retrieve and validate objective receipts. Ask `kasra` to independently review sequencing and the final PR. Require protocol ACKs and keep request IDs in the flight issue.

- [x] **Step 3: Record substrate limitations**

If SOS can message peers but cannot create cross-tenant tasks, record the exact `cross_tenant_agent_access` result and use Mupot/GitHub as the task ledger. Do not bypass RBAC.

---

### Task 3: Assemble the Release Evidence Bundle

**Generated files (ignored under `tmp/`):**
- `tmp/release-readiness/v0.23.0/host-go/*`
- `tmp/release-readiness/v0.23.0/*-check.json`
- `tmp/release-readiness/v0.23.0/github-*.json`

- [ ] **Step 1: Retrieve objective receipts from durable sources**

Collect the exact files emitted by:

```bash
npm run receipt:release-readiness:plan -- \
  --version v0.23.0 \
  --repo Mumega-com/mupot \
  --checks-pr <release-pr-number> \
  --out-dir tmp/release-readiness/v0.23.0
```

Do not reconstruct a passing receipt from prose. Each file must be the original redacted verifier output or be regenerated from authoritative source evidence.

- [ ] **Step 2: Verify GitHub App evidence without accessing its private key**

Export only the live redacted app and installation metadata supported by `github-app-permissions-receipt.mjs`, then run its checker. Fail closed if the authenticated export is unavailable.

- [ ] **Step 3: Scan the aggregate directory for secrets**

The aggregate verifier performs its own scan. Also run the repository no-secrets workflow before publication.

---

### Task 4: Prepare the Stable Metadata PR

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify: `docs/releases/v0.23.0-trusted-runtime.md`

- [ ] **Step 1: Write tests or focused assertions for stable metadata**

Extend existing release-receipt tests only if the current suite does not prove all local metadata fields align on `0.23.0`.

- [ ] **Step 2: Promote RC metadata to stable**

Change only release metadata and release notes required by the integrity checker. Do not tag or publish from an unreviewed commit.

- [ ] **Step 3: Run focused and full verification**

```bash
npm run typecheck
npm test
node --test fleet-runtime/*.test.mjs
bash scripts/ci-local-evidence.sh
git diff --check
```

- [ ] **Step 4: Push and open a named release PR**

The PR body must link the flight issue, #281, #284, delegated review receipts, local evidence counts, and the exact expected stable tag. Treat its head SHA as the release commit candidate.

---

### Task 5: Prove the Named Release PR

- [ ] **Step 1: Wait for the required GitHub checks**

Required names from `scripts/release-readiness-receipt.mjs`:

```text
build
plugin
no-secrets
local-evidence
CodeQL
Analyze (actions)
Analyze (javascript-typescript)
Analyze (python)
```

- [ ] **Step 2: Obtain independent review**

Kasra must review the exact PR head SHA. Address findings with focused tests and request re-review after any material change.

- [ ] **Step 3: Merge without rewriting release evidence**

Record the merged commit SHA. If merge strategy changes the SHA, all tag and release evidence must use the resulting release commit, not the pre-merge PR head. Wait for the push-to-`main` checks on that exact SHA.

---

### Task 6: Run Prepublication and Postpublication Gates

- [ ] **Step 1: Deploy and prove the exact merged stable commit**

Deploy the merged release SHA and generate `stable-deployment-check.json`. Public health must report stable `0.23.0` and the same commit.

Pass the immutable commit at deploy time with
`npm run deploy -- --var RELEASE_SHA:<merged-release-sha>`. An unset or invalid
`RELEASE_SHA` appears as `commit:null` on `/health` and must fail this gate.

- [ ] **Step 2: Run prepublication readiness**

```bash
npm run receipt:release-readiness:check -- \
  --phase prepublication \
  --version v0.23.0 \
  --repo Mumega-com/mupot \
  --out-dir tmp/release-readiness/v0.23.0 \
  --checks-pr <release-pr-number> \
  --release-sha <merged-release-sha>
```

Expected: `receipt_type:"mupot-v023-prepublication-readiness/v1"` and `status:"pass"`. Do not publish without it.

- [ ] **Step 3: Close product milestone and publish the exact SHA**

Release-control trackers #281, #284, and #345 do not count as product-objective milestone work. Remove them from milestone 6, close the milestone only after its remaining issue count is zero, then create tag `v0.23.0` and a non-draft, non-prerelease GitHub Release at the prepublication SHA.

- [ ] **Step 4: Run postpublication release integrity**

```bash
npm run receipt:release-integrity:plan -- \
  --version v0.23.0 \
  --repo Mumega-com/mupot \
  --out-dir tmp/release-integrity/v0.23.0

npm run receipt:release-integrity:check -- \
  --version v0.23.0 \
  --repo Mumega-com/mupot \
  --repo-root . \
  --out-dir tmp/release-integrity/v0.23.0
```

Attach `release-integrity-check.json` to #281, record its digest, then close #281.

- [ ] **Step 5: Run final aggregate readiness against the named release SHA**

Export fresh issue, PR, and check state, include the passing integrity receipt, then run:

```bash
npm run receipt:release-readiness:check -- \
  --phase final \
  --version v0.23.0 \
  --repo Mumega-com/mupot \
  --out-dir tmp/release-readiness/v0.23.0 \
  --checks-pr <release-pr-number> \
  --release-sha <merged-release-sha>
```

Expected: `receipt_type:"mupot-v023-release-readiness/v1"` and `status:"pass"`. Attach the receipt to #284 and close it.

---

### Task 7: Browser Acceptance and Flight Landing

- [ ] **Step 1: Run automated browser workflows locally**

Use `bash scripts/ci-local-evidence.sh` as the reproducible browser/runtime baseline.

- [ ] **Step 2: Inspect the product in the in-app browser**

Start `npm run dev:local:test`, then inspect all routed pages and execute the owner, squad, flight, task, gate, agent, and release-relevant workflows supported by seeded fixtures. Capture failures with route, action, expected result, and observed result.

- [ ] **Step 3: Verify production health**

Confirm `https://mupot.mumega.com/health` returns `0.23.0` and the deployed release commit after stable deployment. Do not treat a healthy RC response as stable proof.

- [ ] **Step 4: Land the flight**

Publish one final flight comment containing: goal, release commit, PR, tag/release, test counts, browser result, delegated request/ACK IDs, reviewer decision, receipt digests, issue links, and any residual risks. Mark the decision `release-ready` only if every gate above passes; otherwise list exact blockers and leave the goal active.

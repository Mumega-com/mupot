# Mupot v0.25.0 Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Mupot v0.25.0 from exact commit `7e8595b07200bd0aa98938c3fc16a597cc72acc8` after restoring that exact production version, proving live scheduler and Routine behavior, keeping Digid and House upgrades blocked on #616, and moving #613/#614 to v0.26.

**Architecture:** Reactivate the already-built and previously approved Cloudflare Worker version `d7c319f2-d575-4bba-b44b-6d8eafee19c2` (version 210), whose safe plain-text bindings prove the exact release SHA and canonical origin. Update only the Mumega Worker's cron triggers through `wrangler triggers deploy`; do not rebuild the historical commit, rerun migrations, or touch Digid/House. Collect fresh live evidence before creating the Git tag and GitHub release.

**Tech Stack:** Git/GitHub CLI, Cloudflare Wrangler 4.102.0, Cloudflare Workers Versions/Deployments/D1, Mupot MCP, Vitest.

## Global Constraints

- Release commit is exactly `7e8595b07200bd0aa98938c3fc16a597cc72acc8`.
- Approved Cloudflare version is exactly `d7c319f2-d575-4bba-b44b-6d8eafee19c2`.
- Worker name is `mupot`; tenant is `mumega`; public origin is `https://mupot.mumega.com`.
- Digid and House configs, databases, Workers, routes, triggers, and secrets are out of scope.
- Digid and House upgrades remain blocked by GitHub issue #616.
- Issues #613 and #614 move from milestone 8 (`v0.25.0`) to milestone 9 (`v0.26.0`).
- Do not print, copy into receipts, commit, or pass raw credentials as command arguments.
- Load Cloudflare credentials only by sourcing `/home/mumega/.env.secrets`.
- Read Mupot credentials only from `/home/mumega/.fleet/agents/kasra-member.token` and `/home/mumega/.fleet/agents/kasra-agent.token`.
- Do not apply or repair D1 migrations during this publication flight. Remote migration state must be read-only and have no pending release migrations.
- Do not tag or publish while `/health` reports any version other than `0.25.0`, any commit other than the full release SHA, or `clean` other than `true`.

---

### Task 1: Record and close the production-drift diagnosis

**Files:**
- Reference: `/home/mumega/.wrangler/logs/wrangler-2026-07-28_18-40-34_204.log`
- Reference: `scripts/deploy.mjs`
- Reference: `scripts/lib/release-sha.mjs`
- External update: GitHub issue #582

**Interfaces:**
- Consumes: Cloudflare deployment/version history and public `/health`.
- Produces: A redacted root-cause receipt on #582 naming the bad version, source checkout, and recurrence boundary.

- [ ] **Step 1: Reproduce the drift**

Run:

```bash
curl -fsS -H 'Cache-Control: no-cache' \
  'https://mupot.mumega.com/health?probe=v025-drift-recovery' | jq .
```

Expected before recovery:

```json
{"ok":true,"service":"mupot","tenant":"mumega","version":"0.24.0","commit":null}
```

- [ ] **Step 2: Export safe deployment evidence**

Run from `/home/mumega/mupot`:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler deployments list --config wrangler.toml --json |
  jq 'map({id,created_on,source,annotations,versions})'
```

Verify version 210 was superseded by versions 211-213 and version 213 is active.

- [ ] **Step 3: Verify the exact root cause**

Run:

```bash
git -C /home/mumega/mupot-worktrees/kasra-operator rev-parse HEAD
git -C /home/mumega/mupot-worktrees/kasra-operator show HEAD:package.json | jq -r .version
rg -n 'Running autoconfig detection|sanitizedCommand|Current Version ID' \
  /home/mumega/.wrangler/logs/wrangler-2026-07-28_18-40-34_204.log
```

Expected:

- checkout commit `80f7d9e82ae1c657c6b307c433462000eea56bfc`;
- package version `0.24.0`;
- bare `wrangler deploy`;
- Cloudflare version `7c18a769-1519-4cb1-a00e-87812a03618f` (version 213);
- no `RELEASE_SHA` binding.

- [ ] **Step 4: Comment the redacted diagnosis on #582**

The comment must state that version 213 came from the stale `kasra-operator` checkout via bare Wrangler, superseded approved version 210, and omitted `RELEASE_SHA`. It must also state that recovery reactivates version 210 and that future production uploads must use `scripts/deploy.mjs` or an already-approved Cloudflare version.

### Task 2: Freeze the release scope and tenant boundary

**Files:**
- External update: GitHub issues #613, #614, and #616

**Interfaces:**
- Consumes: User-approved release objective.
- Produces: Milestone 8 contains only v0.25 release work; #616 explicitly blocks Digid/House upgrades.

- [ ] **Step 1: Move #613 to milestone 9**

Run:

```bash
gh api --method PATCH repos/Mumega-com/mupot/issues/613 -f milestone=9
```

- [ ] **Step 2: Move #614 to milestone 9**

Run:

```bash
gh api --method PATCH repos/Mumega-com/mupot/issues/614 -f milestone=9
```

- [ ] **Step 3: Record the #616 boundary**

Comment on #616:

```text
Release boundary: this issue blocks Digid and House tenant upgrades. The Mumega-only v0.25.0 publication flight will not read or mutate either tenant's config, D1, Worker, routes, triggers, or secrets. #616 remains open until disposable upgrade evidence resolves the duplicate migration-number risk.
```

- [ ] **Step 4: Verify milestone state**

Run:

```bash
gh issue list \
  --milestone 'v0.25.0 - Project Routines and Needs You' \
  --state all \
  --limit 100 \
  --json number,title,state,milestone,url
```

Expected: #613 and #614 are absent; #397 and #582 remain open until publication evidence is complete.

### Task 3: Verify the exact release candidate without rebuilding production

**Files:**
- Verify at commit: `package.json`
- Verify at commit: `src/version.ts`
- Verify at commit: `CHANGELOG.md`
- Temporary ignored config: `/home/mumega/mupot-worktrees/release-v025-exact/wrangler.toml`

**Interfaces:**
- Consumes: exact release commit and current Mumega production binding contract.
- Produces: clean tests, dry-run bundle, and read-only migration proof for the exact commit.

- [ ] **Step 1: Create a detached exact-release worktree**

Run:

```bash
git -C /home/mumega/mupot worktree add \
  --detach \
  /home/mumega/mupot-worktrees/release-v025-exact \
  7e8595b07200bd0aa98938c3fc16a597cc72acc8
```

- [ ] **Step 2: Install and verify exact source**

Run:

```bash
npm ci
npm test
npm run typecheck
git status --short
```

Run from `/home/mumega/mupot-worktrees/release-v025-exact`.

Expected: all tests and typecheck pass; tracked worktree is clean.

- [ ] **Step 3: Prepare only the Mumega ignored config**

Mechanically copy `/home/mumega/mupot/wrangler.toml` into the exact worktree. Change only the trigger line to:

```toml
crons = ["* * * * *", "0-9,15-24,30-39,45-54 * * * *"]
```

Verify:

```bash
rg -n 'name = "mupot"|TENANT_SLUG = "mumega"|PUBLIC_ORIGIN|crons' wrangler.toml
git status --short
```

Expected: exact Worker name, tenant, public origin, two-trigger contract, and no tracked changes.

- [ ] **Step 4: Verify version metadata**

Run:

```bash
git rev-parse HEAD
jq -r .version package.json
rg -n "MUPOT_PUBLIC_API_VERSION = '0.25.0'" src/version.ts
rg -n '^## \[0.25.0\]' CHANGELOG.md
```

- [ ] **Step 5: Run the exact dry-run and migration read**

Run:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler deploy --dry-run --config wrangler.toml
npx wrangler d1 migrations list mupot --remote --config wrangler.toml
```

Expected: dry run succeeds; no release migration is pending. Do not run `migrations apply`.

- [ ] **Step 6: Verify the approved Cloudflare version bindings**

Run from `/home/mumega/mupot`:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler versions view \
  d7c319f2-d575-4bba-b44b-6d8eafee19c2 \
  --config wrangler.toml \
  --json |
  jq '{id,number,vars:[.resources.bindings[]?|select(.name=="RELEASE_SHA" or .name=="TENANT_SLUG" or .name=="PUBLIC_ORIGIN")|{name,type,text}]}'
```

Expected: version 210, exact release SHA, tenant `mumega`, and canonical public origin.

### Task 4: Reactivate exact version 210 and restore triggers

**Files:**
- Runtime config: `/home/mumega/mupot-worktrees/release-v025-exact/wrangler.toml`
- External mutation: Cloudflare Worker `mupot`

**Interfaces:**
- Consumes: approved Worker version 210 and verified two-trigger config.
- Produces: exact version at 100 percent traffic, correct cron triggers, and live health identity.

- [ ] **Step 1: Snapshot the current rollback target**

Record current version 213:

```text
7c18a769-1519-4cb1-a00e-87812a03618f
```

- [ ] **Step 2: Reactivate version 210**

Run:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler versions deploy \
  d7c319f2-d575-4bba-b44b-6d8eafee19c2@100 \
  --config wrangler.toml \
  --message 'restore exact Mupot v0.25.0 release version after bare-deploy drift' \
  --yes
```

Run from `/home/mumega/mupot`; this selects an existing version and uploads no new code.

- [ ] **Step 3: Restore only Mumega cron triggers**

Run from `/home/mumega/mupot-worktrees/release-v025-exact`:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler triggers deploy --config wrangler.toml
```

- [ ] **Step 4: Verify Cloudflare deployment identity**

Run:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler deployments list --config /home/mumega/mupot/wrangler.toml --json |
  jq '.[-1] | {id,created_on,annotations,versions}'
```

Expected: version 210 at 100 percent.

- [ ] **Step 5: Verify public health**

Run:

```bash
curl -fsS -H 'Cache-Control: no-cache' \
  'https://mupot.mumega.com/health?probe=v025-restored' |
  jq -e '.ok == true and .tenant == "mumega" and .version == "0.25.0" and .commit == "7e8595b07200bd0aa98938c3fc16a597cc72acc8" and .clean == true'
```

If this fails, reactivate version 213 and stop:

```bash
set -a
. /home/mumega/.env.secrets
set +a
npx wrangler versions deploy \
  7c18a769-1519-4cb1-a00e-87812a03618f@100 \
  --config /home/mumega/mupot/wrangler.toml \
  --message 'rollback failed v0.25 restoration probe' \
  --yes
```

### Task 5: Prove scheduler routes and one governed Routine lifecycle

**Files:**
- Evidence output: `tmp/v025-publication/scheduler-tail.jsonl`
- Evidence output: `tmp/v025-publication/routine-proof.json`
- External mutation: one zero-budget manual Routine in `mupot-development`

**Interfaces:**
- Consumes: restored exact release, existing org-admin token, existing canonical Kasra agent token.
- Produces: all eleven route labels, one successful zero-cost governed Routine, and archived test policy.

- [ ] **Step 1: Capture scheduled route evidence**

Run `wrangler tail` for at least one complete fifteen-minute maintenance window and store redacted JSONL. Verify these labels are present with `outcome=ok`:

```text
membership
metabolism
loops
github-project
growth
cro
flight-outbox
concierge
project-loop
agent-connection-retention
project-routines
```

Also verify there is no `[scheduled:unmatched-cron]` and no exception.

- [ ] **Step 2: Verify the existing credentials without printing them**

Use `boot_context` with:

```text
/home/mumega/.fleet/agents/kasra-member.token
/home/mumega/.fleet/agents/kasra-agent.token
```

Expected:

- `kasra-member.token` has org `admin`;
- `kasra-agent.token` is bound to canonical agent `c855f82c-1eeb-409d-94d2-f11e9dd18968` and has `squad-core` member access.

- [ ] **Step 3: Create and enable the bounded Routine**

Call `routine_create` with:

```json
{
  "project_id": "eaf4fb0e-b4f6-4f28-aae6-c06c67ae7afa",
  "name": "v0.25 publication drift-recovery proof",
  "objective": "Prove exact v0.25 scheduler, canonical external-runtime dispatch, proposal, and terminal receipt after production drift recovery.",
  "trigger_kind": "manual",
  "responsible_squad_id": "squad-core",
  "preferred_agent_id": "c855f82c-1eeb-409d-94d2-f11e9dd18968",
  "execution_mode": "propose",
  "budget_micro_usd": 0,
  "max_attempts": 1,
  "retry_backoff_seconds": 30,
  "max_occurrences": 1,
  "timezone": "UTC",
  "overlap_policy": "skip"
}
```

Use the admin token, then call `routine_enable`.

- [ ] **Step 4: Run and settle the Routine**

Call `routine_run_now` with idempotency key:

```text
v025-publication-drift-recovery-20260730
```

Poll `routine_run_get` until the run is assigned to canonical Kasra and exposes its `situation_digest`. With `kasra-agent.token`, call `routine_proposal_submit` using one `no_action` action:

```json
{
  "version": "routine.proposal/v1",
  "summary": "Exact v0.25 live publication proof completed without an external action.",
  "action": {
    "key": "v025-publication-no-action",
    "kind": "no_action",
    "input": {
      "reason": "Publication proof only; no production side effect is required."
    }
  }
}
```

Populate `run_id`, `project_id`, and `situation_digest` from authoritative run state.

- [ ] **Step 5: Verify and archive**

Verify `routine_run_get` reports:

- status `succeeded`;
- attempt 1;
- cost `0`;
- exact release commit and version in lifecycle evidence;
- no approval or external action;
- correlated Task, Flight, message, proposal receipt, and terminal event chain.

Call `routine_archive` with the admin token. Save only redacted IDs, statuses, commit, version, timestamps, and receipt hashes.

### Task 6: Publish the exact GitHub release

**Files:**
- Release notes source: `CHANGELOG.md` at `7e8595b07200bd0aa98938c3fc16a597cc72acc8`
- External updates: tag `v0.25.0`, GitHub release, issues #397/#582, milestone 8

**Interfaces:**
- Consumes: exact live deployment, scheduler proof, Routine proof, and GitHub checks.
- Produces: immutable tag/release and closed release gates.

- [ ] **Step 1: Verify exact GitHub checks**

Run:

```bash
gh api \
  repos/Mumega-com/mupot/commits/7e8595b07200bd0aa98938c3fc16a597cc72acc8/check-runs \
  --jq '.check_runs[] | [.name,.status,.conclusion] | @tsv'
```

All required checks must be completed successfully.

- [ ] **Step 2: Create and push the exact annotated tag**

Run:

```bash
git tag -a v0.25.0 \
  7e8595b07200bd0aa98938c3fc16a597cc72acc8 \
  -m 'Mupot v0.25.0 - Project Routines and Needs You'
git push origin refs/tags/v0.25.0
```

- [ ] **Step 3: Publish the GitHub release**

Create `v0.25.0` against the existing tag with title:

```text
Mupot v0.25.0 - Project Routines and Needs You
```

Use only the `0.25.0` section of `CHANGELOG.md` as release notes, plus links to the redacted #582 deployment and Routine receipts.

- [ ] **Step 4: Close release gates with evidence**

Comment on and close:

- #397 with exact tag, release URL, deployment version, public health, scheduler proof, Routine proof, and #616 customer boundary;
- #582 with the same runtime evidence and the bare-deploy root cause.

- [ ] **Step 5: Close milestone 8**

Close milestone 8 only after its open issue count is zero.

### Task 7: Final completion audit

**Files:**
- No new files.

**Interfaces:**
- Consumes: every artifact produced above.
- Produces: requirement-by-requirement PASS/BLOCK verdict.

- [ ] **Step 1: Verify immutable release identity**

Run:

```bash
git ls-remote --tags origin refs/tags/v0.25.0
gh release view v0.25.0 \
  --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url
curl -fsS -H 'Cache-Control: no-cache' \
  'https://mupot.mumega.com/health?probe=v025-final-audit' | jq .
```

- [ ] **Step 2: Verify scope boundaries**

Confirm:

- #613 and #614 are in milestone 9;
- #616 remains open;
- no Digid/House deployment, config, D1, trigger, route, or secret mutation occurred;
- #397 and #582 are closed with current evidence.

- [ ] **Step 3: Verify live proof**

Confirm:

- all eleven scheduler labels are present and `ok`;
- no unmatched-cron warning or exception;
- the controlled Routine succeeded at zero cost and was archived;
- evidence names exact commit `7e8595b07200bd0aa98938c3fc16a597cc72acc8` and version `0.25.0`.

- [ ] **Step 4: Report PASS only if every requirement is proven**

Any missing, stale, indirect, or contradictory evidence is a BLOCK. Do not mark the goal complete until all checks above pass.

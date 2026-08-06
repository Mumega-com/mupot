# Viamar GEO Project Cell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a project-scoped, budget-capped Viamar GEO scanner that runs in Google-hosted Kubernetes, writes honest grounded-search events to Viamar's PostHog project, and leaves a redacted receipt in the Viamar Mupot project.

**Architecture:** A small dependency-injected Node runtime performs one bounded grounded Vertex call per configured prompt, claims a persistent UTC-day budget before each call, normalizes the response into `dme.geo-scan/v1`, captures it in PostHog, and sends one redacted project receipt to Mupot. Kubernetes packages the runtime as a dedicated Viamar CronJob with Workload Identity, Secret file mounts, persistent budget state, and no customer credential in source control.

**Tech Stack:** Node.js ESM, native `fetch`, Vitest, Kubernetes CronJob/ConfigMap/Secret references/PVC/NetworkPolicy, Vertex AI REST, PostHog Capture API, Mupot agent inbox HTTP API.

## Global Constraints

- Google hosts the Kubernetes runtime and provides Vertex grounded search; do not add Cloud Run, BigQuery, or GCS.
- The scanner model is exactly `gemini-2.5-flash` in Vertex location `global`.
- `MAX_DAILY_GROUNDED_QUERIES` is exactly 25 and configuration may only lower it.
- Persist no Google access token, PostHog token, or Mupot bearer token and never include one in logs/errors/receipts.
- No retry of an ambiguous billable Vertex request.
- Store detailed scan events in the customer PostHog project; store only a redacted run receipt in Mupot.
- No deploy, merge, migration, identity mint/revoke, secret access/creation/rotation, or live customer-data access in this branch.
- Cursor is the independent gate; the implementation author does not self-approve.

---

### Task 1: Scanner Contract and Viamar Configuration

**Files:**
- Create: `fleet-runtime/geo-scanner/contract.mjs`
- Create: `deploy/kubernetes/geo-scanner/viamar-profile.json`
- Test: `fleet-runtime/geo-scanner/contract.test.mjs`

**Interfaces:**
- Consumes: JSON parsed from `GEO_SCANNER_CONFIG_FILE`.
- Produces: `validateScannerConfig(raw)` returning a deeply normalized config, `MAX_DAILY_GROUNDED_QUERIES`, and stable validation errors.

- [ ] **Step 1: Write failing contract tests**

Cover a literal valid Viamar config and mutations that exceed 25 queries, change
`project_id`, add an unsafe HTTP PostHog host, duplicate prompt IDs, exceed array/string
bounds, or select another model/location. Assert behavior, not source text.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test fleet-runtime/geo-scanner/contract.test.mjs`

Expected: FAIL because `contract.mjs` does not exist.

- [ ] **Step 3: Implement the minimal validated contract**

Export:

```js
export const MAX_DAILY_GROUNDED_QUERIES = 25
export const GEO_EVENT_SCHEMA = 'dme.geo-scan/v1'
export const GEO_RECEIPT_SCHEMA = 'mupot.geo-scan-receipt/v1'
export function validateScannerConfig(raw) {}
```

The normalized configuration must contain:

```js
{
  schema: 'dme.geo-scanner-config/v1',
  projectId: '00000000-0000-4000-8000-000000000000',
  googleProjectId: 'mumegaproject',
  location: 'global',
  model: 'gemini-2.5-flash',
  posthogHost: 'https://us.i.posthog.com',
  dailyQueryCap: 3,
  stateFile: '/var/lib/mupot/geo-budget/state.json',
  mupot: {
    baseUrl: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
    receiptTo: 'viamar-geo-receipts'
  },
  profiles: [{
    id: 'viamar',
    targetDomain: 'viamar.ca',
    market: 'Canada',
    trackedCompetitors: [],
    prompts: [{ id: 'international-movers-toronto', text: '...' }]
  }]
}
```

Use `URL` parsing, require HTTPS, reject userinfo/query/fragment/non-root paths, cap the
config at five profiles, five prompts per profile, 600 characters per prompt, ten tracked
competitors, and 128 characters per identifier/name.

- [ ] **Step 4: Add the public Viamar profile**

Add exactly three prompts:

```json
[
  {
    "id": "international-movers-toronto",
    "text": "Which companies are best for international household-goods moving from Toronto, Canada?"
  },
  {
    "id": "overseas-car-shipping-canada",
    "text": "Which companies are best for shipping a car overseas from Canada?"
  },
  {
    "id": "canada-to-europe-moving",
    "text": "Who are the most trusted companies for moving household goods from Canada to Europe?"
  }
]
```

Commit no credential or customer-private payload.

- [ ] **Step 5: Run the contract test and verify GREEN**

Run: `node --test fleet-runtime/geo-scanner/contract.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fleet-runtime/geo-scanner/contract.mjs fleet-runtime/geo-scanner/contract.test.mjs deploy/kubernetes/geo-scanner/viamar-profile.json
git commit -m "feat: define Viamar GEO scanner contract"
```

### Task 2: Persistent UTC-Day Budget

**Files:**
- Create: `fleet-runtime/geo-scanner/budget.mjs`
- Test: `fleet-runtime/geo-scanner/budget.test.mjs`

**Interfaces:**
- Consumes: `{ stateFile, dailyQueryCap, now }`.
- Produces: `claimGroundedQuery(input)` returning `{ ok: true, day, used, remaining }` or `{ ok: false, reason: 'daily_query_cap_reached' }`; throws stable fail-closed state errors.

- [ ] **Step 1: Write failing behavioral tests**

Use a real temporary directory. Prove claims 1 through 25 persist, claim 26 is denied,
a second function instance observes the same state, a new UTC day resets the count,
malformed state fails closed, and a pre-existing lock fails closed. No test asserts an
implementation-specific JSON line.

- [ ] **Step 2: Run the budget test and verify RED**

Run: `node --test fleet-runtime/geo-scanner/budget.test.mjs`

Expected: FAIL because `budget.mjs` does not exist.

- [ ] **Step 3: Implement minimal atomic budget claims**

Use `mkdir`, `open(lockPath, 'wx', 0o600)`, `readFile`, `writeFile` to a mode-0600
temporary file, and `rename`. Claim before returning success. Always close and remove the
lock on the handled path; leave an unexpected stale lock fail-closed for operator
inspection. Reject a configured cap outside `1..25`.

- [ ] **Step 4: Run the budget test and verify GREEN**

Run: `node --test fleet-runtime/geo-scanner/budget.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet-runtime/geo-scanner/budget.mjs fleet-runtime/geo-scanner/budget.test.mjs
git commit -m "feat: enforce persistent GEO query budget"
```

### Task 3: Grounded Vertex Boundary

**Files:**
- Create: `fleet-runtime/geo-scanner/vertex.mjs`
- Test: `fleet-runtime/geo-scanner/vertex.test.mjs`

**Interfaces:**
- Consumes: explicit Google project/location/model/prompt and injected `fetch`.
- Produces: `readWorkloadIdentityToken(options)` and `runGroundedQuery(input, options)`, returning normalized answer, search queries, citations, token usage, and stable status.

- [ ] **Step 1: Write failing Vertex boundary tests**

Inject a fake fetch only at the external HTTP boundary. Mirror complete metadata-token and
Vertex response shapes. Prove:

- metadata token is requested with `Metadata-Flavor: Google`;
- the Vertex URL contains encoded explicit project, `global`, and
  `gemini-2.5-flash:generateContent`;
- the body contains `tools: [{ googleSearch: {} }]`;
- redirect, non-2xx, timeout, malformed/oversized JSON, missing candidate, and empty answer
  become stable states without upstream body text;
- answer, query, citation, and usage bounds are applied;
- no returned result contains either supplied token.

- [ ] **Step 2: Run the Vertex test and verify RED**

Run: `node --test fleet-runtime/geo-scanner/vertex.test.mjs`

Expected: FAIL because `vertex.mjs` does not exist.

- [ ] **Step 3: Implement Workload Identity token retrieval**

Call:

```text
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
```

with a bounded timeout and `Metadata-Flavor: Google`. Accept only a non-empty
`access_token` with a positive `expires_in`; never return it from the public scan result.

- [ ] **Step 4: Implement one-shot grounded query**

Send one POST with `redirect: 'manual'`, JSON content, and `Authorization: Bearer`.
Do not retry. Read response text through a byte cap before `JSON.parse`. Normalize
`candidates[0].content.parts[0].text`,
`groundingMetadata.webSearchQueries`,
`groundingMetadata.groundingChunks[].web`, and `usageMetadata`.

- [ ] **Step 5: Run the Vertex test and verify GREEN**

Run: `node --test fleet-runtime/geo-scanner/vertex.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fleet-runtime/geo-scanner/vertex.mjs fleet-runtime/geo-scanner/vertex.test.mjs
git commit -m "feat: add bounded grounded Vertex client"
```

### Task 4: PostHog Event and Mupot Receipt Boundaries

**Files:**
- Create: `fleet-runtime/geo-scanner/sinks.mjs`
- Test: `fleet-runtime/geo-scanner/sinks.test.mjs`

**Interfaces:**
- Consumes: normalized scan events, run receipts, and tokens read at immediate call time.
- Produces: `captureGeoEvent(input, options)` and `sendMupotReceipt(input, options)`.

- [ ] **Step 1: Write failing sink tests**

Prove PostHog receives `$geo_scan`, a stable distinct ID derived from project/profile, and
the complete bounded event properties; redirects and non-2xx are rejected without body
echo. Prove Mupot receives an `ack` at `/api/inbox/send` with `project_id`, a stable
request ID, and only receipt-summary fields. Assert serialized requests contain their
necessary token only in the protocol-required location and returned errors/results never
contain it.

- [ ] **Step 2: Run the sink test and verify RED**

Run: `node --test fleet-runtime/geo-scanner/sinks.test.mjs`

Expected: FAIL because `sinks.mjs` does not exist.

- [ ] **Step 3: Implement PostHog capture**

POST to `${posthogHost}/i/v0/e/` with `redirect: 'manual'`, a bounded timeout, and:

```js
{
  api_key: token,
  event: '$geo_scan',
  distinct_id: `project:${projectId}:profile:${profileId}`,
  timestamp: observedAt,
  properties: event
}
```

The project token is read from its mounted file immediately before this call. Do not log
or return it.

- [ ] **Step 4: Implement the redacted Mupot receipt**

POST to `${baseUrl}/api/inbox/send` with bearer authorization. The JSON body contains
`to`, `kind: "ack"`, `project_id`, `request_id`, and a bounded JSON receipt string. Reject
a receipt object containing detailed evidence fields such as `answer_text`,
`web_search_queries`, `citations`, or token-like keys.

- [ ] **Step 5: Run the sink test and verify GREEN**

Run: `node --test fleet-runtime/geo-scanner/sinks.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fleet-runtime/geo-scanner/sinks.mjs fleet-runtime/geo-scanner/sinks.test.mjs
git commit -m "feat: add GEO event and receipt sinks"
```

### Task 5: Scanner Orchestration and Honest Outcomes

**Files:**
- Create: `fleet-runtime/geo-scanner/scanner.mjs`
- Create: `fleet-runtime/geo-scanner/cli.mjs`
- Test: `fleet-runtime/geo-scanner/scanner.test.mjs`

**Interfaces:**
- Consumes: validated config and injected budget/Vertex/sink functions.
- Produces: `runGeoScan(config, options)` and a CLI exit status with one redacted JSON log line.

- [ ] **Step 1: Write failing orchestration tests**

Prove:

- budget is claimed before every Vertex call;
- cap denial makes no Vertex call and records `budget_denied`;
- success computes target-domain citation and tracked-competitor name matches;
- empty and failed Vertex outcomes remain empty/failed rather than zero-citation success;
- one PostHog failure does not cause the Vertex call to repeat;
- every attempted prompt has a deterministic event UUID/request key;
- estimated token cost is separate from null grounding cost and
  `billing_unreconciled`;
- one final redacted receipt summarizes all outcomes;
- a Mupot receipt failure yields incomplete exit status without repeating scans.

- [ ] **Step 2: Run the scanner test and verify RED**

Run: `node --test fleet-runtime/geo-scanner/scanner.test.mjs`

Expected: FAIL because `scanner.mjs` does not exist.

- [ ] **Step 3: Implement event normalization and cost estimate**

Use dated model-only rates:

```js
const INPUT_USD_PER_MILLION_TOKENS = 0.30
const OUTPUT_USD_PER_MILLION_TOKENS = 2.50
```

Compute integer micro-USD from actual returned prompt/candidate counts. Set
`grounding_cost_micro_usd: null` and `cost_status: 'billing_unreconciled'`.

- [ ] **Step 4: Implement orchestration**

Iterate the validated, bounded profile/prompt arrays once. Claim budget, request one token
for the run, make exactly one Vertex call per allowed prompt, capture exactly one honest
event per attempt, and send exactly one final receipt. Never retry a Vertex call.

- [ ] **Step 5: Implement the CLI**

Read configuration and token files from:

```text
GEO_SCANNER_CONFIG_FILE
POSTHOG_PROJECT_TOKEN_FILE
MUPOT_AGENT_TOKEN_FILE
```

Return exit code `0` only when all allowed events and the receipt land, `2` for a partial
honest run, and `1` for invalid configuration/credential/runtime setup. Log only schema,
scan ID, project ID, counts, cost status, and stable reason.

- [ ] **Step 6: Run the scanner test and verify GREEN**

Run: `node --test fleet-runtime/geo-scanner/scanner.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add fleet-runtime/geo-scanner/scanner.mjs fleet-runtime/geo-scanner/cli.mjs fleet-runtime/geo-scanner/scanner.test.mjs
git commit -m "feat: orchestrate honest Viamar GEO scans"
```

### Task 6: Portable Kubernetes Project Cell

**Files:**
- Modify: `deploy/kubernetes/agent-host/Dockerfile.hermes`
- Create: `deploy/kubernetes/geo-scanner/viamar-cronjob.yaml`
- Create: `deploy/kubernetes/geo-scanner/network-policy.yaml`
- Create: `scripts/kubernetes-geo-scanner-receipt.mjs`
- Modify: `package.json`
- Test: `tests/kubernetes-geo-scanner.test.ts`

**Interfaces:**
- Consumes: scanner runtime files and public Viamar configuration.
- Produces: a credential-free Kubernetes manifest and
  `mupot-kubernetes-geo-scanner-receipt/v1` artifact proof.

- [ ] **Step 1: Write a failing artifact behavior test**

Run the receipt generator against the manifests and assert parsed Kubernetes behavior:
CronJob schedule, `Forbid`, deadline/history, dedicated ServiceAccount, explicit image
digest resolution in proof mode, non-root/read-only container, dropped capabilities,
resources, ConfigMap, two read-only Secret file mounts plus Workload Identity, PVC budget
state, no inline secret/token, and network-policy selection. Run the image file-list verifier and
prove all scanner modules are included.

- [ ] **Step 2: Run the artifact test and verify RED**

Run: `npx vitest run tests/kubernetes-geo-scanner.test.ts`

Expected: FAIL because the manifests and generator do not exist.

- [ ] **Step 3: Package scanner files in the Hermes image**

Extend the existing `COPY --chown=10000:10000` list with the six
`fleet-runtime/geo-scanner/*.mjs` runtime files, excluding tests.

- [ ] **Step 4: Add the Viamar CronJob and isolation artifacts**

Use:

```yaml
schedule: "0 10 * * *"
concurrencyPolicy: Forbid
restartPolicy: Never
serviceAccountName: viamar-geo-scanner
automountServiceAccountToken: true
```

Mount the public config, PostHog token, Mupot token, and budget PVC at the exact paths
consumed by the CLI. Use `runAsUser: 10000`, `readOnlyRootFilesystem: true`,
`allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`, and drop `ALL`
capabilities.

- [ ] **Step 5: Implement executable manifest receipt validation**

Parse YAML using the repository dependency already available to tests, hash relevant
files, reject secret-like literal values and unresolved unsafe image tags, and emit only
redacted file digests/invariant results.

- [ ] **Step 6: Run the artifact test and verify GREEN**

Run: `npx vitest run tests/kubernetes-geo-scanner.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/kubernetes/agent-host/Dockerfile.hermes deploy/kubernetes/geo-scanner scripts/kubernetes-geo-scanner-receipt.mjs tests/kubernetes-geo-scanner.test.ts package.json
git commit -m "feat: package portable Viamar GEO scanner cell"
```

### Task 7: Documentation, Verification, and Independent Gate

**Files:**
- Modify: `docs/dme-geo-gcp-foundation.md` only if PR #572 has merged; otherwise add a
  non-conflicting follow-up document under `docs/`.
- Create: `docs/viamar-geo-scanner-runbook.md`
- Modify: `docs/roadmap.md` if present; otherwise update the repository's canonical roadmap.

**Interfaces:**
- Consumes: completed scanner, manifests, and test commands.
- Produces: an operator runbook that distinguishes branch proof from live activation.

- [ ] **Step 1: Write the runbook**

Document:

- one project cell per customer;
- Workload Identity and PostHog/Mupot Secret prerequisites without secret values;
- dry validation and receipt commands;
- exact live activation gates owned by Hadi;
- how to inspect PostHog `$geo_scan` events;
- how to confirm the redacted project receipt;
- how to reconcile actual Google billing later;
- how to stop the CronJob and preserve/export the budget ledger;
- why current connector/addon bindings are not yet project-scoped.

- [ ] **Step 2: Run focused verification**

```bash
node --test fleet-runtime/geo-scanner/*.test.mjs
npx vitest run tests/kubernetes-geo-scanner.test.ts
npm run typecheck
npm run receipt:kubernetes-geo-scanner
```

Expected: all tests PASS. The checked-in receipt status is `plan` with only
`project_id_unresolved` and `image_digest_unresolved`; a temporary manifest with an
authorized project UUID and pinned image digest proves the same receipt becomes `pass`.
No secret output.

- [ ] **Step 3: Run full verification**

```bash
npm test
npm run typecheck
npm run receipt:kubernetes-geo-scanner
node scripts/no-secrets.mjs
git diff --check
```

Expected: tests, typecheck, secret scan, and diff check PASS. The scanner receipt
remains `plan` until its separately authorized project UUID and immutable image digest
are supplied; do not run the unrelated fleet receipt-bundle checker without a real
exported bundle manifest.

- [ ] **Step 4: Review the complete branch**

Inspect:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status --short
```

Confirm no credential, customer-private payload, deployment, migration, or unrelated
change exists.

- [ ] **Step 5: Commit documentation**

```bash
git add docs
git commit -m "docs: add Viamar GEO scanner runbook"
```

- [ ] **Step 6: Send exact-head gate to Cursor**

Use `/home/mumega/.local/bin/sos-mcp-send cursor "<message>"`. Include branch, exact commit,
design/plan paths, focused/full test results, untested live paths, and the no-deploy/no-
credential boundary. Ask Cursor for `GREEN` or `BLOCK` on the exact commit.

- [ ] **Step 7: Open a PR only after local verification**

Push the feature branch and open a PR closing #574. Mark real baseline and measured actual
grounding cost as `NOT YET TESTED — requires Hadi activation` unless the separate live
authority has been granted and evidenced.

## Self-Review

- Spec coverage: runtime placement, Viamar first profile, hard budget, honest empty state,
  token discipline, PostHog events, Mupot evidence, Kubernetes isolation, live-activation
  boundary, and Cursor gate each map to a task.
- Placeholder scan: manifests contain Kubernetes Secret references and an intentionally
  suspended example image reference whose executable receipt is `plan`; implementation
  steps contain exact behavior and no unfinished code placeholders.
- Type consistency: `projectId`, `profileId`, `scanId`, `dailyQueryCap`,
  `billing_unreconciled`, `dme.geo-scan/v1`, and
  `mupot.geo-scan-receipt/v1` are consistent across tasks.

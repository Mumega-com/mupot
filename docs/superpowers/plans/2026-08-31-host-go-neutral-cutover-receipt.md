# Host-Go Neutral Cutover Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canonical SOS-specific Host-Go cutover receipt with a fail-closed Mupot/Herdr-neutral receipt while preserving strict historical receipt verification.

**Architecture:** The producer emits `mupot-host-go-cutover/v1` and computes a redacted no-live-SOS finding set from the host/runtime/control evidence chain. Bundle consumers dispatch to separate strict neutral and legacy parsers, then enforce a mode-specific exact next-step policy. The v0.30 contract requires the neutral type; v0.23 historical defaults keep the legacy type.

**Tech Stack:** Node.js ESM, Node test runner, Vitest, JSON receipt contracts, Git/GitHub CLI, code-review-graph, Mupot agent MCP.

**Spec:** `docs/superpowers/specs/2026-08-31-host-go-neutral-cutover-receipt-design.md`

## Global Constraints

- Start from main commit `ccfdb4b3247b46108618d5b1c58a5d0f63ed8147`.
- Canonical new type: `mupot-host-go-cutover/v1`.
- Historical type: `mupot-sos-cutover-gate/v1`.
- Keep filename `cutover-gate.json` and artifact role `cutover_gate` unchanged.
- New production paths emit only the neutral type and neutral handoff language.
- Historical legacy receipts remain byte-for-byte untouched and strictly parseable.
- v0.30 requires the neutral type; v0.23 retains the legacy type.
- SOS findings expose JSON locations and marker classes only, never matched values.
- No merge, deployment, production migration, live host control, tag, release, credential, ACL, or branch-protection action is authorized.
- Every behavior change begins with a test that is observed failing for the intended reason.

---

### Task 1: Neutral Cutover Producer and SOS Scanner

**Files:**
- Modify: `fleet-runtime/cutover-receipt.mjs:1-252`
- Modify: `fleet-runtime/cutover-receipt.test.mjs:1-160`

**Interfaces:**
- Produces: `HOST_GO_CUTOVER_RECEIPT_TYPE = 'mupot-host-go-cutover/v1'`
- Produces: `LEGACY_SOS_CUTOVER_RECEIPT_TYPE = 'mupot-sos-cutover-gate/v1'`
- Produces: `collectLiveSosFindings({ host, runtimes, controls }): Array<{ location: string; marker: string }>`
- Changes: `buildReceipt(opts)` emits only the neutral receipt type.
- Preserves: existing host/runtime/control receipt checks and control-verb semantics.

- [ ] **Step 1: Add neutral receipt and clean-chain RED assertions**

Extend the passing test in `fleet-runtime/cutover-receipt.test.mjs`:

```js
import {
  HOST_GO_CUTOVER_RECEIPT_TYPE,
  LEGACY_SOS_CUTOVER_RECEIPT_TYPE,
  buildReceipt,
  collectLiveSosFindings,
  controlRuns,
  parseArgs,
} from './cutover-receipt.mjs'

assert.equal(HOST_GO_CUTOVER_RECEIPT_TYPE, 'mupot-host-go-cutover/v1')
assert.equal(LEGACY_SOS_CUTOVER_RECEIPT_TYPE, 'mupot-sos-cutover-gate/v1')
assert.equal(receipt.receipt_type, HOST_GO_CUTOVER_RECEIPT_TYPE)
assert.equal(receipt.inputs.substrate, 'mupot-herdr')
assert.equal(receipt.inputs.live_sos_wiring, false)
assert.deepEqual(receipt.checks.at(-1), {
  ok: true,
  component: 'host-go-cutover',
  check: 'no_live_sos_wiring',
  substrate: 'mupot-herdr',
  finding_count: 0,
  findings: [],
})
```

- [ ] **Step 2: Run the producer test and verify RED**

Run:

```bash
node --test fleet-runtime/cutover-receipt.test.mjs
```

Expected: FAIL because the constants/export, neutral receipt type, policy inputs, and no-SOS check do not exist.

- [ ] **Step 3: Add table-driven SOS marker RED tests**

Add this matrix and a test that writes the mutated receipt into the appropriate host/runtime/control fixture before calling `buildReceipt`:

```js
const SOS_MARKER_CASES = [
  ['sos_binding', 'host', (receipt) => { receipt.inputs.token_binding = 'SOS_TOKEN_FILE' }],
  ['sos_path', 'host', (receipt) => { receipt.inputs.daemon_config = '/home/operator/.sos/daemon.json' }],
  ['sos_service', 'host', (receipt) => { receipt.checks.push({ ok: true, component: 'host-services', check: 'service_observed', service: 'sos-agent.service' }) }],
  ['sos_command', 'runtime', (receipt) => { receipt.checks.push({ ok: true, component: 'fleet-daemon', check: 'probe_configured', probe: '/opt/sos/bin/agent-probe' }) }],
  ['sos_endpoint', 'control', (receipt) => { receipt.target.sos_endpoint = 'https://sos.internal.example' }],
]

for (const [marker, target, mutate] of SOS_MARKER_CASES) {
  test(`cutover receipt fails closed for ${marker}`, async () => {
    const fixture = passingCutoverFiles('agent-one')
    const value = JSON.parse(readFileSync(fixture[target], 'utf8'))
    mutate(value)
    writeFileSync(fixture[target], JSON.stringify(value, null, 2))

    const receipt = await buildReceipt(fixture.opts)

    assert.equal(receipt.status, 'fail')
    assert.equal(receipt.inputs.live_sos_wiring, true)
    assert.ok(receipt.checks.some((check) =>
      check.check === 'no_live_sos_wiring' &&
      check.ok === false &&
      check.findings.some((finding) => finding.marker === marker)
    ))
    assert.doesNotMatch(JSON.stringify(receipt), /SOS_TOKEN_FILE|\.sos\/daemon|sos-agent|\/opt\/sos|sos\.internal/)
  })
}
```

The helper `passingCutoverFiles(agentId)` must create the existing passing host/runtime/start/stop files and return both named paths and the existing `buildReceipt` options.

- [ ] **Step 4: Run marker tests and verify RED**

Run the same Node test command. Expected: each marker test FAILS because the current producer neither scans nor fails.

- [ ] **Step 5: Implement closed, deterministic marker collection**

Add these exported constants and internal policy definitions:

```js
export const HOST_GO_CUTOVER_RECEIPT_TYPE = 'mupot-host-go-cutover/v1'
export const LEGACY_SOS_CUTOVER_RECEIPT_TYPE = 'mupot-sos-cutover-gate/v1'

const SCANNED_FIELD_RE = /(?:^|_)(?:path|config|file|dir|probe|command|argv|script|service|name|unit|label|binding|env|endpoint|adapter|runtime|base_url)(?:$|_)/i
const SOS_MARKERS = Object.freeze([
  ['sos_binding', /(?:^|[^A-Za-z0-9])SOS(?:_[A-Z0-9_]+)?(?:$|[^A-Za-z0-9])/],
  ['sos_path', /(?:^|[/\\])\.sos(?:[/\\]|$)|(?:^|[/\\])sos(?:[/\\]|$)/i],
  ['sos_service', /(?:^|[./_-])sos(?:[./_-].*)?(?:\.service|\.plist)?$/i],
  ['sos_command', /(?:^|[/\\._-])sos(?:[/\\._-]|$)/i],
  ['sos_endpoint', /^https?:\/\/[^/]*\bsos\b|^https?:\/\/[^/]+\/sos(?:\/|$)/i],
])
```

Implement `collectLiveSosFindings` as a recursive walker with these rules:

```js
export function collectLiveSosFindings({ host, runtimes = [], controls = [] } = {}) {
  const findings = []
  const seen = new Set()
  const visit = (value, location, field = '') => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`, field))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (/^SOS(?:_|$)/i.test(key)) add(location ? `${location}.${key}` : key, 'sos_binding')
        visit(entry, location ? `${location}.${key}` : key, key)
      }
      return
    }
    if (typeof value !== 'string' || !SCANNED_FIELD_RE.test(field)) return
    for (const [marker, pattern] of SOS_MARKERS) if (pattern.test(value)) add(location, marker)
  }
  const add = (location, marker) => {
    const key = `${location}\0${marker}`
    if (!seen.has(key)) {
      seen.add(key)
      findings.push({ location, marker })
    }
  }
  visit(host, 'host')
  runtimes.forEach((receipt, index) => visit(receipt, `runtimes[${index}]`))
  controls.forEach((receipt, index) => visit(receipt, `controls[${index}]`))
  return findings.sort((a, b) => a.location.localeCompare(b.location) || a.marker.localeCompare(b.marker))
}
```

Ensure the implementation defines `add` before the first `visit` invocation so JavaScript initialization order is valid.

- [ ] **Step 6: Emit the neutral exact schema**

In `buildReceipt`, retain the parsed host/runtime/control objects, compute findings after the existing per-agent checks, append the no-SOS check, recompute summary, and return:

```js
const sosFindings = collectLiveSosFindings({
  host,
  runtimes: runtimeReceipts.map(({ receipt }) => receipt),
  controls: controlReceipts.map(({ receipt }) => receipt),
})
checks.push({
  ok: sosFindings.length === 0,
  component: 'host-go-cutover',
  check: 'no_live_sos_wiring',
  substrate: 'mupot-herdr',
  finding_count: sosFindings.length,
  findings: sosFindings,
})

return {
  receipt_type: HOST_GO_CUTOVER_RECEIPT_TYPE,
  generated_at: new Date().toISOString(),
  status: summary.status,
  summary,
  inputs: {
    substrate: 'mupot-herdr',
    live_sos_wiring: sosFindings.length > 0,
    agents: requestedAgents,
    host_receipt: opts.hostPath || null,
    runtime_receipts: opts.runtimePaths ?? [],
    control_receipts: opts.controlPaths ?? [],
    required_control_verbs: opts.requiredControlVerbs ?? ['start', 'stop'],
  },
  checks,
}
```

- [ ] **Step 7: Run producer tests GREEN**

Run:

```bash
node --test fleet-runtime/cutover-receipt.test.mjs
```

Expected: PASS, including every marker and redaction assertion.

- [ ] **Step 8: Commit Task 1**

```bash
git add fleet-runtime/cutover-receipt.mjs fleet-runtime/cutover-receipt.test.mjs
git commit -m "feat(host-go): emit neutral cutover receipt"
```

---

### Task 2: Strict Dual-Mode Parsing and Bundle Generation

**Files:**
- Modify: `fleet-runtime/receipt-bundle.mjs:32-63,784-860,1280-1380,1560-1645,3560-3650,4230-4480`
- Modify: `fleet-runtime/receipt-bundle.test.mjs:1-820,1470-1725,2110-2320,2800-3060`

**Interfaces:**
- Consumes: `HOST_GO_CUTOVER_RECEIPT_TYPE`, `LEGACY_SOS_CUTOVER_RECEIPT_TYPE`
- Produces: internal mode enum values `neutral` and `legacy`
- Produces: strict `normalizePassingNeutralCutoverReceipt(receipt)`
- Preserves: strict `normalizePassingLegacyCutoverReceipt(receipt)` with the old schema
- Changes: all newly built bundles use the neutral type/policy
- Preserves: historical legacy manifests and copied bundles remain verifiable

- [ ] **Step 1: Add RED constants and new-bundle expectations**

Replace test-only policy constants with explicit mode policies:

```js
const NEUTRAL_ATTACH = 'attach manifest.json and cutover-gate.json to the Host-Go handoff record; handoff is permitted only for the proven agent(s)'
const NEUTRAL_HOLD = 'do not complete the Host-Go handoff yet; rerun until manifest.json and cutover-gate.json are status pass'
const LEGACY_ATTACH = 'attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)'
const LEGACY_HOLD = 'do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass'
```

Update the ordinary `buildBundle` passing/failing tests to expect the neutral receipt type and neutral policy. Add an assertion that `formatHostGoPlan()` contains neither `SOS removal` nor `SOS wiring`.

- [ ] **Step 2: Add a strict historical fixture**

Create `legacyCutoverReceipt({ agentId = 'agent-one', hostPath, runtimePath, startPath, stopPath })` by taking the exact old passing fixture shape from the baseline and keeping:

```js
{
  receipt_type: 'mupot-sos-cutover-gate/v1',
  generated_at: '2026-07-08T00:03:00.000Z',
  status: 'pass',
  summary: summarizeFixture(checks),
  inputs: {
    agents: [agentId],
    host_receipt: hostPath,
    runtime_receipts: [runtimePath],
    control_receipts: [startPath, stopPath],
    required_control_verbs: ['start', 'stop'],
  },
  checks,
}
```

The helper receives real fixture paths as arguments; do not leave angle-bracket strings in the implementation.

Add a `seedLegacyCutoverEvidence(outDir)` helper that writes the legacy gate and a manifest with legacy artifact metadata and `[LEGACY_ATTACH]`.

- [ ] **Step 3: Add RED legacy and mixed-mode tests**

Add these test cases:

```js
test('manifest checker preserves a strict historical SOS cutover bundle', () => {
  const outDir = seedLegacyCutoverEvidence(tmpDir())
  const check = checkBundleManifest({ outDir })
  assert.equal(check.status, 'pass')
})

for (const [gateType, nextSteps] of [
  ['mupot-host-go-cutover/v1', [LEGACY_ATTACH]],
  ['mupot-sos-cutover-gate/v1', [NEUTRAL_ATTACH]],
]) {
  test(`manifest rejects mixed cutover mode ${gateType}`, () => {
    const outDir = seedBundleForMode(gateType)
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    manifest.next_steps = nextSteps
    writeJson(join(outDir, 'manifest.json'), manifest)
    assert.equal(checkBundleManifest({ outDir }).status, 'fail')
  })
}
```

Add forged neutral-pass cases that delete/change each of:

- `inputs.substrate`;
- `inputs.live_sos_wiring`;
- the final `no_live_sos_wiring` check;
- `finding_count`;
- `findings`;
- the check component/name;
- an unknown top-level/input/check field.

Each case must make `checkBundleManifest` fail without throwing.

- [ ] **Step 4: Run bundle tests and verify RED**

```bash
node --test fleet-runtime/receipt-bundle.test.mjs
```

Expected: existing producer tests fail on the old type/policy; new legacy and mixed-mode tests fail because one global expected type/policy is still used.

- [ ] **Step 5: Implement type and policy helpers**

Import the two producer constants and replace the global gate type/policy with:

```js
const CUTOVER_MODE = Object.freeze({
  neutral: Object.freeze({
    receiptType: HOST_GO_CUTOVER_RECEIPT_TYPE,
    attach: 'attach manifest.json and cutover-gate.json to the Host-Go handoff record; handoff is permitted only for the proven agent(s)',
    hold: 'do not complete the Host-Go handoff yet; rerun until manifest.json and cutover-gate.json are status pass',
  }),
  legacy: Object.freeze({
    receiptType: LEGACY_SOS_CUTOVER_RECEIPT_TYPE,
    attach: 'attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)',
    hold: 'do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass',
  }),
})

function cutoverModeForType(receiptType) {
  if (receiptType === CUTOVER_MODE.neutral.receiptType) return 'neutral'
  if (receiptType === CUTOVER_MODE.legacy.receiptType) return 'legacy'
  return null
}
```

Set `EXPECTED.cutover_gate` to the neutral type for new production.

- [ ] **Step 6: Split strict normalizers**

Move the unchanged baseline logic into
`normalizePassingLegacyCutoverReceipt(receipt)`. Implement
`normalizePassingNeutralCutoverReceipt(receipt)` with the same existing checks plus:

```js
hasExactKeys(receipt.inputs, [
  'substrate',
  'live_sos_wiring',
  'agents',
  'host_receipt',
  'runtime_receipts',
  'control_receipts',
  'required_control_verbs',
])
receipt.inputs.substrate === 'mupot-herdr'
receipt.inputs.live_sos_wiring === false
```

After consuming the existing checks, require exactly one final check:

```js
hasExactKeys(check, [
  'ok', 'component', 'check', 'substrate', 'finding_count', 'findings',
]) &&
check.ok === true &&
check.component === 'host-go-cutover' &&
check.check === 'no_live_sos_wiring' &&
check.substrate === 'mupot-herdr' &&
check.finding_count === 0 &&
Array.isArray(check.findings) &&
check.findings.length === 0
```

Dispatch without coercion:

```js
function normalizePassingCutoverReceipt(receipt) {
  const mode = cutoverModeForType(receipt?.receipt_type)
  const normalized = mode === 'neutral'
    ? normalizePassingNeutralCutoverReceipt(receipt)
    : mode === 'legacy'
      ? normalizePassingLegacyCutoverReceipt(receipt)
      : null
  return normalized ? { mode, receipt: normalized } : null
}
```

- [ ] **Step 7: Make bundle generation neutral**

Update `buildNextSteps`, `buildStatusNextSteps`, Host-Go plan headings/comments,
status checklist text, and new artifact expectations to use
`CUTOVER_MODE.neutral`. The cutover builder already emits the neutral type after
Task 1; reject any injected builder that returns the legacy type in a new bundle.

- [ ] **Step 8: Run bundle tests GREEN**

```bash
node --test fleet-runtime/cutover-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs
```

Expected: PASS for new neutral production, strict legacy parsing, and mixed-mode rejection.

- [ ] **Step 9: Commit Task 2**

```bash
git add fleet-runtime/receipt-bundle.mjs fleet-runtime/receipt-bundle.test.mjs
git commit -m "feat(host-go): verify neutral and legacy gates"
```

---

### Task 3: Mode-Aware Export, Portable Manifest, and Status Verification

**Files:**
- Modify: `fleet-runtime/receipt-bundle.mjs:1280-1380,1560-1645,2170-2240,2494-2843,3200-3900`
- Modify: `fleet-runtime/receipt-bundle.test.mjs:820-1200,1640-1830,2080-2320,2800-3060`

**Interfaces:**
- Consumes: `normalizePassingCutoverReceipt(receipt)` returning `{ mode, receipt }`
- Produces: exact mode-aware artifact metadata and next-step verification
- Preserves: SHA-256 and portable provenance chains for both receipt generations

- [ ] **Step 1: Add RED copied-bundle and export tests**

Add one passing copied-bundle/export test for each mode. For each, assert:

```js
assert.equal(check.status, 'pass')
assert.ok(check.checks.some((entry) =>
  entry.check === 'artifact_receipt_type_expected' &&
  entry.artifact === 'cutover_gate' &&
  entry.expected === expectedReceiptType &&
  entry.ok === true
))
assert.deepEqual(exportReceipt.next_steps, [expectedAttachPolicy])
```

Add negative tests for:

- manifest type and gate-file type disagreement;
- export receipt policy disagreement;
- copied bundle whose neutral gate contains a forged no-SOS pass;
- copied bundle whose legacy gate is interpreted with neutral schema;
- provenance mapping that changes only the cutover type.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
node --test fleet-runtime/receipt-bundle.test.mjs
```

Expected: the new mode-aware export assertions fail while the verifier still consults one global type/policy.

- [ ] **Step 3: Implement mode-aware artifact metadata**

Add:

```js
function exactCutoverArtifactMeta(meta) {
  const mode = cutoverModeForType(meta?.receipt_type)
  return mode && exactArtifactMeta(meta, CUTOVER_MODE[mode].receiptType)
    ? mode
    : null
}
```

Use it wherever `artifacts.cutover_gate` is validated. Never accept a near-miss type or infer a mode from next-step text.

- [ ] **Step 4: Implement mode-aware next-step checks**

Resolve the mode from the strict cutover receipt/artifact before calling
`addNextStepChecks`. Pass the selected policy explicitly:

```js
function addNextStepChecks(checks, manifestPath, manifest, hardGateSummary, mode) {
  const policy = mode ? CUTOVER_MODE[mode] : null
  const expectedSteps = hardGateSummary?.status === 'pass'
    ? [policy?.attach]
    : [policy?.hold]
  // Preserve the existing closed ordered-policy assertions.
}
```

If mode resolution fails, add a failing `cutover_gate_mode_valid` check and do
not select a fallback policy.

- [ ] **Step 5: Preserve mode through export and portable provenance**

Update `expectedArtifactType`, `starterArtifactSchemaExact`,
`expectedExportReceiptChecks`, copied manifest checks, and status rendering to
use the exact source mode. Exported metadata must retain the source receipt type;
no conversion from legacy to neutral or neutral to legacy is allowed.

- [ ] **Step 6: Run focused Fleet verification GREEN**

```bash
node --test fleet-runtime/cutover-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs
```

Expected: all producer, bundle, export, copied-manifest, portable provenance,
status, and mixed-mode tests PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add fleet-runtime/receipt-bundle.mjs fleet-runtime/receipt-bundle.test.mjs
git commit -m "fix(host-go): preserve cutover receipt mode"
```

---

### Task 4: v0.30 Neutral Contract and v0.23 Historical Preservation

**Files:**
- Modify: `docs/releases/v0.30.0-contract.json:19-28`
- Modify: `tests/release-v030-contract.test.ts:1-100`
- Modify: `tests/release-v023-readiness.test.ts:1-130`
- Verify unchanged semantics: `scripts/release-readiness-receipt.mjs:1-50`

**Interfaces:**
- v0.30 consumes: `mupot-host-go-cutover/v1`
- v0.23 consumes: `mupot-sos-cutover-gate/v1`
- Preserves: exact release SHA/version binding logic

- [ ] **Step 1: Add RED v0.30 contract assertions**

In `tests/release-v030-contract.test.ts`, load the contract and add:

```ts
const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
  receipts: Array<{ file: string; receipt_type: string }>
}

it('requires the neutral Host-Go cutover receipt', () => {
  expect(contract.receipts).toContainEqual(expect.objectContaining({
    file: 'host-go/cutover-gate.json',
    receipt_type: 'mupot-host-go-cutover/v1',
  }))
  expect(JSON.stringify(contract)).not.toContain('mupot-sos-cutover-gate/v1')
  const plan = readinessPlan({
    version: VERSION,
    contractPath: CONTRACT_RELATIVE,
    outDir: 'tmp/release-readiness/v0.30.0',
    repo: 'Mumega-com/mupot',
    checksPr: '1250',
    releaseSha: 'a'.repeat(40),
    phase: 'prepublication',
  })
  expect(plan).toContain('mupot-host-go-cutover/v1')
  expect(plan).not.toContain('mupot-sos-cutover-gate/v1')
})
```

- [ ] **Step 2: Add RED v0.23 preservation assertion**

Import `REQUIRED_RECEIPTS` from the readiness checker and add:

```ts
expect(REQUIRED_RECEIPTS).toContainEqual(expect.objectContaining({
  file: 'host-go/cutover-gate.json',
  receipt_type: 'mupot-sos-cutover-gate/v1',
}))
```

This should already pass; it is a kill witness against accidentally migrating the historical default.

- [ ] **Step 3: Run the contract tests and verify v0.30 RED**

```bash
npx vitest run tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts
```

Expected: v0.30 neutral assertion FAILS; v0.23 legacy assertion PASSES.

- [ ] **Step 4: Change only the v0.30 contract type**

In `docs/releases/v0.30.0-contract.json`, replace the cutover receipt type with:

```json
"receipt_type": "mupot-host-go-cutover/v1"
```

Do not change `REQUIRED_RECEIPTS` in `scripts/release-readiness-receipt.mjs`.

- [ ] **Step 5: Run contract and readiness tests GREEN**

```bash
npx vitest run tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts tests/release-readiness-receipt.test.ts
```

- [ ] **Step 6: Commit Task 4**

```bash
git add docs/releases/v0.30.0-contract.json tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts
git commit -m "fix(release): require neutral Host-Go gate"
```

---

### Task 5: Current Documentation and Runbook Migration

**Files:**
- Modify: `fleet-runtime/README.md`
- Modify: `docs/runtime-starter.md`
- Modify: `docs/agent-running-on-mupot.md`
- Modify: `docs/squad-mupot-cutover.md`
- Modify: `docs/releases/v0.30.0.md`
- Modify: `tests/cutover-runbook.test.ts`
- Preserve: `docs/releases/v0.23.0-trusted-runtime.md`

**Interfaces:**
- Current docs name `mupot-host-go-cutover/v1` and neutral handoff policy.
- Historical sections label `mupot-sos-cutover-gate/v1` as legacy.
- Generated plans/status contain no operational SOS retention/removal language.

- [ ] **Step 1: Add RED current-document assertions**

Replace the SOS-removal test in `tests/cutover-runbook.test.ts` with:

```ts
it('keeps Mupot Herdr handoff gated by the complete Host-Go bundle', () => {
  expect(runbook).toContain('mupot-host-go-cutover/v1')
  expect(runbook).toContain('Mupot/Herdr')
  expect(runbook).toContain('no_live_sos_wiring')
  expect(runbook).not.toContain('do not remove SOS wiring yet')
  expect(runbook).not.toContain('SOS removal is permitted')
  // Retain all existing manifest, control, export, hash, and secret checks.
})
```

Add a Fleet test:

```js
test('current Host-Go plans contain no SOS operating instructions', () => {
  const plan = formatHostGoPlan({ outDir: '/tmp/host-go', agents: ['agent-one'] })
  assert.doesNotMatch(plan, /SOS removal|SOS wiring|mupot-sos-cutover-gate/)
  assert.match(plan, /Host-Go handoff/)
})
```

- [ ] **Step 2: Run documentation tests and verify RED**

```bash
npx vitest run tests/cutover-runbook.test.ts tests/release-v030-contract.test.ts
node --test fleet-runtime/receipt-bundle.test.mjs
```

- [ ] **Step 3: Update current documentation**

Apply these wording rules consistently:

- “SOS cutover/removal” → “Host-Go Mupot/Herdr handoff” in current instructions;
- `mupot-sos-cutover-gate/v1` → `mupot-host-go-cutover/v1` in current examples;
- explain that the neutral gate proves the selected evidence chain has no live
  SOS dependency;
- add a historical compatibility paragraph stating that legacy receipts remain
  verifiable but cannot satisfy v0.30;
- retain filenames, bundle mechanics, exact hashes, lifecycle control, and
  secret-safety instructions.

Do not rewrite the v0.23 historical release document.

- [ ] **Step 4: Run a scoped SOS wording audit**

```bash
rg -n "SOS removal|do not remove SOS wiring|mupot-sos-cutover-gate/v1" \
  fleet-runtime/README.md \
  docs/runtime-starter.md \
  docs/agent-running-on-mupot.md \
  docs/squad-mupot-cutover.md \
  docs/releases/v0.30.0.md
```

Expected: only an explicitly labeled historical compatibility paragraph may
contain `mupot-sos-cutover-gate/v1`; no current operational SOS instruction may remain.

- [ ] **Step 5: Run documentation and focused release tests GREEN**

```bash
npx vitest run tests/cutover-runbook.test.ts tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts
node --test fleet-runtime/cutover-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs
```

- [ ] **Step 6: Commit Task 5**

```bash
git add fleet-runtime/README.md docs/runtime-starter.md docs/agent-running-on-mupot.md docs/squad-mupot-cutover.md docs/releases/v0.30.0.md tests/cutover-runbook.test.ts
git commit -m "docs(host-go): replace SOS cutover guidance"
```

---

### Task 6: Completion Audit, Full Gates, PR, and Athena

**Files:**
- Verify all changed files
- Create: `/mnt/HC_Volume_104325311/mumega.com/agents/kasra/briefs/host-go-neutral-cutover-exact-head-20260831.md`

**Interfaces:**
- Produces: pushed branch and GitHub PR targeting `main`
- Produces: exact head/tree/diff hashes and immutable review receipt
- Produces: Athena exact-head verdict
- Does not produce: merge, tag, deployment, migration, host control, or credential changes

- [ ] **Step 1: Run focused receipt and release gates**

```bash
node --test fleet-runtime/cutover-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs
npx vitest run tests/cutover-runbook.test.ts tests/release-v030-contract.test.ts tests/release-v023-readiness.test.ts tests/release-readiness-receipt.test.ts
```

- [ ] **Step 2: Run the full local gate stack**

```bash
npm run typecheck
npm test
npx vitest run --config vitest.composition.config.ts
node --test 'fleet-runtime/**/*.test.mjs'
node --test tests/router.test.mjs
npm audit --omit=dev --audit-level=moderate
node --test tests/audit-gate.test.mjs
git diff --check origin/main...HEAD
```

- [ ] **Step 3: Rebuild and inspect the exact code graph**

Run a full code-review-graph build at the current branch head, then run
`detect_changes` and `get_affected_flows` against `origin/main`. Record node,
edge, flow, community, parser-error, and `head_matches_build` values.

- [ ] **Step 4: Perform the requirement-by-requirement completion audit**

Verify and record:

- neutral producer and exact schema;
- each SOS marker turns RED and leaks no matched value;
- forged/malformed no-SOS assertions fail;
- historical legacy receipt/parser/export remains green;
- mixed modes fail;
- v0.30 requires neutral;
- v0.23 remains legacy;
- current plans/docs are neutral;
- historical v0.23 evidence is unchanged;
- no live/protected action occurred.

- [ ] **Step 5: Push the branch and create a PR without merging**

```bash
git push -u origin fix/v030-host-go-neutral
gh pr create \
  --repo Mumega-com/mupot \
  --base main \
  --head fix/v030-host-go-neutral \
  --title "fix(host-go): neutralize cutover receipt" \
  --body-file /mnt/HC_Volume_104325311/mumega.com/agents/kasra/briefs/host-go-neutral-cutover-pr-body-20260831.md
```

Keep the PR unmerged. If GitHub reports main drift, stop and restack/re-run exact-head gates.

- [ ] **Step 6: Wait for exact-head CI and CodeQL**

Record the PR head with:

```bash
HOST_GO_HEAD=$(git rev-parse HEAD)
HOST_GO_TREE=$(git rev-parse HEAD^{tree})
HOST_GO_DIFF_SHA=$(git diff --binary origin/main...HEAD | sha256sum | awk '{print $1}')
gh pr checks --repo Mumega-com/mupot --watch --interval 10
```

Do not use an earlier head's checks.

- [ ] **Step 7: Request Athena exact-head review**

Send Athena the exact head, tree, diff SHA, local/full/remote gate counts,
requirement audit, and immutable receipt path/hash using the authenticated Kasra
Mupot agent token. Ask Athena to review:

- neutral/legacy mode separation;
- no-live-SOS scanner coverage and redaction;
- historical artifact verification;
- v0.23/v0.30 contract separation;
- misleading or mixed-mode scenarios;
- protected-action boundary.

Consume only handled Athena mail and send correlated ACKs.

- [ ] **Step 8: Seal the exact-head receipt and stop**

Create and hash
`briefs/host-go-neutral-cutover-exact-head-20260831.md` with the exact subject,
all gates, Athena envelope/checksum, remaining risks, and explicit statement
that the PR is unmerged and no live operation occurred.

Stop after Athena's verdict. Do not merge the PR.

/**
 * ECC verification-loop gate for scripts/review-worker.py:
 * every verdict must cite one concrete factual claim @ path:line from the real
 * diff. A GREEN with empty p0/p1 but a false/unverifiable stated mechanism
 * (the #488 resolveAgentRef/TENANT_SLUG failure mode) must be downgraded to WARN
 * — not presented as a clean pass.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workerPath = fileURLToPath(new URL('../scripts/review-worker.py', import.meta.url))
const workerSource = readFileSync(workerPath, 'utf8')

/** #488-shaped fixture: resolveAgentRef gains a null check; NO TENANT_SLUG filter. */
const RESOLVE_DIFF = `diff --git a/src/org/resolve.ts b/src/org/resolve.ts
index 111..222 100644
--- a/src/org/resolve.ts
+++ b/src/org/resolve.ts
@@ -10,6 +10,7 @@ export function resolveAgentRef(db: D1, ref: string) {
   const row = await db
     .prepare('SELECT * FROM agents WHERE id = ?')
     .bind(ref)
     .first()
+  if (!row) return null
   return row
 }
`

function runWorkerProbe(pythonSnippet: string): string {
  const script = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("review_worker", Path(${JSON.stringify(workerPath)}))
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)
DIFF = ${JSON.stringify(RESOLVE_DIFF)}
${pythonSnippet}
`
  return execFileSync('python3', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
}

describe('review-worker supporting_claim citation gate', () => {
  it('prompt requires a concrete supporting_claim with path:line evidence', () => {
    expect(workerSource).toContain('SUPPORTING CLAIM (required on EVERY verdict')
    expect(workerSource).toContain('supporting_claim')
    expect(workerSource).toContain('enforce_supporting_claim')
    expect(workerSource).toContain('DOWNGRADED GREEN→WARN')

    const prompt = runWorkerProbe(`
prompt = rw.build_review_prompt(
    {"number": 488, "title": "t", "body": "b", "headRefOid": "abc"},
    DIFF, False, "ok", "deadbeefcafebabe",
)
print(prompt)
`)
    expect(prompt).toContain('SUPPORTING CLAIM (required on EVERY verdict')
    expect(prompt).toContain('"supporting_claim"')
    expect(prompt).toContain('"evidence": "path/to/file.ext:LINE"')
    expect(prompt).toContain('the driver will downgrade such a GREEN')
    expect(prompt).toContain('to WARN for kasra-core to independently check')
  })

  it('downgrades GREEN with a false TENANT_SLUG mechanism cite to WARN (#488 shape)', () => {
    // Before this gate: empty p0/p1 alone looked like a clean GREEN.
    // After: the false stated mechanism (env.TENANT_SLUG filter) forces WARN.
    const out = runWorkerProbe(`
legacy_green = {
    "verdict": "GREEN",
    "p0": [],
    "p1": [],
    "warn": [],
    "summary": "Cross-tenant reach is impossible because resolveAgentRef filters by env.TENANT_SLUG.",
    "supporting_claim": {
        "claim": "resolveAgentRef filters by env.TENANT_SLUG so cross-tenant reach is impossible",
        "evidence": "src/org/resolve.ts:14",
    },
}
assert legacy_green["verdict"] == "GREEN" and not legacy_green["p0"] and not legacy_green["p1"]
enforced = rw.enforce_supporting_claim(legacy_green, DIFF)
receipt = rw.build_receipt("deadbeef", enforced, False, "ok", "REVIEW-ONLY")
print(json.dumps({"verdict": enforced["verdict"], "receipt": receipt, "warn0": enforced["warn"][0]}))
`)
    const parsed = JSON.parse(out) as { verdict: string; receipt: string; warn0: string }
    expect(parsed.verdict).toBe('WARN')
    expect(parsed.warn0).toContain('supporting_claim_unverified')
    expect(parsed.warn0).toContain('env.TENANT_SLUG')
    expect(parsed.receipt.split('\n')[0]).toMatch(/^review-worker -> deadbeef: WARN /)
    expect(parsed.receipt).toContain('supporting_claim:')
    expect(parsed.receipt).toContain('DOWNGRADED GREEN→WARN')
  })

  it('keeps GREEN when the supporting_claim cite matches the real diff', () => {
    const out = runWorkerProbe(`
honest_green = {
    "verdict": "GREEN",
    "p0": [],
    "p1": [],
    "warn": [],
    "summary": "resolveAgentRef now returns null when the row is missing.",
    "supporting_claim": {
        "claim": "resolveAgentRef returns null when the row is missing",
        "evidence": "src/org/resolve.ts:14",
    },
}
enforced = rw.enforce_supporting_claim(honest_green, DIFF)
receipt = rw.build_receipt("deadbeef", enforced, False, "ok", "REVIEW-ONLY")
print(json.dumps({"verdict": enforced["verdict"], "receipt": receipt}))
`)
    const parsed = JSON.parse(out) as { verdict: string; receipt: string }
    expect(parsed.verdict).toBe('GREEN')
    expect(parsed.receipt.split('\n')[0]).toMatch(/^review-worker -> deadbeef: GREEN /)
    expect(parsed.receipt).toContain(
      'supporting_claim: resolveAgentRef returns null when the row is missing @ src/org/resolve.ts:14',
    )
  })

  it('downgrades GREEN with no supporting_claim (p0/p1 count alone is not enough)', () => {
    const out = runWorkerProbe(`
bare_green = {
    "verdict": "GREEN",
    "p0": [],
    "p1": [],
    "warn": [],
    "summary": "Looks fine — zero p0 and zero p1.",
    "supporting_claim": None,
}
enforced = rw.enforce_supporting_claim(bare_green, DIFF)
print(enforced["verdict"])
`)
    expect(out).toBe('WARN')
  })
})

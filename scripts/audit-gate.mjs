#!/usr/bin/env node
// audit-gate — the dev/build-toolchain half of the dependency gate.
//
// WHY THIS EXISTS INSTEAD OF `npm audit ... || true`
//
// The first version of this split ran the dev audit with `|| true`. Adversarial review
// blocked it, correctly: `|| true` does not accept "the known unfixable undici chain",
// it accepts EVERY future high and critical dev advisory, plus every audit-tool failure.
// A gate that cannot go red is not a gate — and worse, it made the close condition in
// issue #670 undetectable, because the step passes identically whether the known
// advisory is still there or a dozen new ones have joined it.
//
// So the accepted set is enumerated explicitly in .github/audit-allowlist.json and
// this script fails on anything outside it. Two directions, both of which must fail:
//
//   NEW      a high/critical advisory that is not in the allowlist  -> exit 1
//   STALE    an allowlist entry that no longer appears in the audit -> exit 1
//
// The STALE direction is the part `|| true` could never do, and it is what makes #670
// self-closing: the day wrangler ships a fixed miniflare, undici drops out of the audit,
// these entries become stale, and CI tells us to delete them instead of waiting for
// someone to remember to check.
//
// An audit that cannot be run or parsed is also a failure. A gate that treats "I could
// not tell" as "nothing wrong" is the exact fail-open shape this codebase has been
// pulling defects out of all week.
//
// Production dependencies are NOT handled here — they get a plain blocking
// `npm audit --omit=dev --audit-level=moderate` in ci.yml, with no allowlist and no
// exceptions. Nothing that ships is tolerated at any severity.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST = join(repoRoot, '.github/audit-allowlist.json')
const BLOCKING = new Set(['high', 'critical'])

function fail(msg) {
  console.error(`\n✗ audit-gate: ${msg}\n`)
  process.exit(1)
}

let allowed
try {
  allowed = JSON.parse(readFileSync(ALLOWLIST, 'utf8')).allowed ?? []
} catch (err) {
  // A missing or malformed allowlist must not read as "nothing is allowed, but also
  // nothing to check". Fail loudly — the file is part of the gate, not decoration.
  fail(`cannot read ${ALLOWLIST}: ${err.message}`)
}

let report
try {
  // npm audit exits non-zero when it finds anything, so capture rather than check status.
  const raw = execFileSync('npm', ['audit', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  report = JSON.parse(raw)
} catch (err) {
  // npm audit exits 1 WITH valid JSON when vulnerabilities exist — that is the normal
  // path, not an error. Only treat it as a failure if the payload is unusable.
  const out = err.stdout?.toString() ?? ''
  try {
    report = JSON.parse(out)
  } catch {
    fail(`could not run or parse \`npm audit --json\`: ${err.message}`)
  }
}

if (!report || typeof report.vulnerabilities !== 'object') {
  fail('audit output has no `vulnerabilities` object — refusing to interpret silence as safety')
}

const allowedGhsa = new Set(allowed.map((a) => a.ghsa))
const seenGhsa = new Set()
const violations = []

for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object') continue
    const severity = (via.severity ?? vuln.severity ?? '').toLowerCase()
    if (!BLOCKING.has(severity)) continue
    const ghsa = (via.url ?? '').split('/').pop()
    if (!ghsa) {
      violations.push(`${name}: ${severity} advisory with no resolvable GHSA id (${via.title ?? 'untitled'})`)
      continue
    }
    seenGhsa.add(ghsa)
    if (!allowedGhsa.has(ghsa)) {
      violations.push(`${name}: ${severity} — ${ghsa} — ${via.title ?? ''}`)
    }
  }
}

const stale = allowed.filter((a) => !seenGhsa.has(a.ghsa))

if (violations.length > 0) {
  console.error('\n✗ audit-gate: high/critical dev advisories NOT in .github/audit-allowlist.json\n')
  for (const v of violations) console.error(`    ${v}`)
  console.error(
    '\n  Fix the advisory if a fixed version exists. Only add it to the allowlist if it is' +
    '\n  genuinely unfixable AND dev-only, with the reason written in the entry.\n',
  )
  process.exit(1)
}

if (stale.length > 0) {
  console.error('\n✗ audit-gate: allowlist entries that no longer appear in the audit\n')
  for (const s of stale) console.error(`    ${s.ghsa} (${s.package}) — accepted ${s.accepted_on}`)
  console.error(
    '\n  This is good news: the advisory is gone. Delete these entries from' +
    '\n  .github/audit-allowlist.json. If the list becomes empty, the carve-out has no' +
    '\n  reason to exist — close https://github.com/Mumega-com/mupot/issues/670 and fold' +
    '\n  this step back into the blocking production audit.\n',
  )
  process.exit(1)
}

console.log(
  `✓ audit-gate: no unlisted high/critical dev advisories ` +
  `(${allowed.length} accepted, all still present — see .github/audit-allowlist.json)`,
)

#!/usr/bin/env node
// scripts/check-bare-squad-id-authz.mjs — a squad-scope capability check must never be
// forced to accept a bare string id in place of a real SquadScope.
//
// WHY THIS EXISTS
//
// mupot#1452 round 2 (2026-09-21): a kind='home' exclusion was added as an OPTIONAL
// `squadKind?: OrgKind` parameter on hasCapability/canOnSquad/canOnSquadAuth. An optional
// parameter on an authz predicate is the opposite of a chokepoint — every one of the ~25
// existing call sites that did not know about it silently kept the OLD, kind-blind
// behaviour. See MEMORY feedback_optional_parameter_on_authz_predicate_is_not_a_chokepoint.md.
//
// The successor design (this PR, G-FP1b point 1) makes `hasCapability`/`canOnSquad`/
// `canOnSquadAuth` OVERLOADED so a 'squad' scope check REQUIRES a real `SquadScope`
// (id + department_id + kind, from `loadSquadScope` or a full `Squad` row) — passing a bare
// `string` there is a TYPE ERROR, not a silent under-check. The TYPECHECKER is the primary
// enforcement (`npm run typecheck`); this ratchet is the second belt: it catches the one way
// a caller could still force a bare id through — suppressing the typechecker itself
// (`@ts-ignore`, `@ts-expect-error`, or an `as any` / `as SquadScope` cast) on the same call.
// A `SquadScope` should only ever come from `loadSquadScope`/`resolveSquadRef`/a full `Squad`
// row — a raw `as SquadScope` cast conjures one out of nothing and is exactly the class this
// exists to catch.
//
// THE RULE
//
//   A call to hasCapability / canOnSquad / canOnSquadAuth / memberCanOnSquad /
//   memberCanOnSquadAuth / actorRankOnScopeFor must not be typechecker-suppressed
//   (`@ts-ignore`, `@ts-expect-error` on the line above or the call line itself) or use an
//   `as any` / `as SquadScope` / `as unknown as SquadScope` cast anywhere on the call line.
//
// SCANS RAW TEXT (same convention as this repo's other ratchets — see
// reference_mupot_ci_ratchets_scan_raw_text.md) rather than building a full type-flow
// analysis: the escape hatches this checks for are lexical and local to the call site, so a
// line-based scan is sufficient and does not need a second type checker.
//
// ON THE BASELINE — same contract as check-mcp-tool-seam.mjs / check-test-schema-source.mjs:
//   - it can only SHRINK. Removing a file is a normal PR; adding one fails the check.
//   - the count is PRINTED on every run, so it cannot quietly grow.
//   - a baselined file that has since stopped violating is ALSO an error, so the list cannot
//     rot into a permanent exemption for files that no longer need it.
//
// ESCAPE HATCH: a `// bare-squad-id-exempt: <reason>` comment on the same line as the flagged
// call, or on the line directly above it, exempts that one call — every exemption is printed
// on every run.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'bare-squad-id-authz-baseline.json')

const CLASSES = ['files']
const baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const baselines = Object.fromEntries(CLASSES.map((c) => [c, new Set(baselineFile[c] ?? [])]))

const GATE_FUNCTIONS = [
  'hasCapability',
  'canOnSquad',
  'canOnSquadAuth',
  'memberCanOnSquad',
  'memberCanOnSquadAuth',
  'actorRankOnScopeFor',
]
// Any call `<name>(` where <name> is one of the gate functions above (possibly qualified,
// e.g. `capability.hasCapability(` or preceded by `await `).
const GATE_CALL_RE = new RegExp(`(?:^|[^A-Za-z0-9_.])(?:${GATE_FUNCTIONS.join('|')})\\s*\\(`)

const TS_SUPPRESSION_RE = /@ts-ignore|@ts-expect-error/
const UNSAFE_CAST_RE = /\bas\s+any\b|\bas\s+SquadScope\b|\bas\s+unknown\s+as\s+SquadScope\b/

const EXEMPT_RE = /bare-squad-id-exempt:\s*(.+?)\s*$/

function baselineSizeOnTarget() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return { state: 'unreadable' }
  }
  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/bare-squad-id-authz-baseline.json`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    return {
      state: 'compared',
      sizes: Object.fromEntries(CLASSES.map((c) => [c, Array.isArray(parsed[c]) ? parsed[c].length : null])),
    }
  } catch {
    return { state: 'bootstrap' }
  }
}

function targetFileSet() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src/', 'tests/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(raw.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Scan one file's source for a gate-function call whose line (or the line directly above)
 * suppresses the typechecker or casts into SquadScope. Pure — no I/O — so tests can drive it
 * with synthetic source. Returns { violations: [{ line, snippet }], exemptions: [{ line, reason }] }.
 */
export function scanSource(source) {
  const lines = source.split('\n')
  const violations = []
  const exemptions = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!GATE_CALL_RE.test(line)) continue
    const above = i > 0 ? lines[i - 1] : ''
    const suppressed = TS_SUPPRESSION_RE.test(line) || TS_SUPPRESSION_RE.test(above) || UNSAFE_CAST_RE.test(line)
    if (!suppressed) continue

    const exemptMatch = line.match(EXEMPT_RE) || above.match(EXEMPT_RE)
    if (exemptMatch) {
      exemptions.push({ line: i + 1, reason: exemptMatch[1] })
    } else {
      violations.push({ line: i + 1, snippet: line.trim() })
    }
  }

  return { violations, exemptions }
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  const offenders = { files: [] }
  const violating = { files: new Set() }
  const allExemptions = []

  for (const dir of [SRC_DIR, TESTS_DIR]) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file)
      const { violations, exemptions } = scanSource(readFileSync(file, 'utf8'))
      for (const ex of exemptions) allExemptions.push({ file: rel, ...ex })
      if (violations.length === 0) continue
      violating.files.add(rel)
      if (!baselines.files.has(rel)) offenders.files.push({ file: rel, violations })
    }
  }

  const staleBaseline = Object.fromEntries(
    CLASSES.map((c) => [c, [...baselines[c]].filter((rel) => !violating[c].has(rel)).sort()]),
  )

  const target = baselineSizeOnTarget()
  for (const c of CLASSES) {
    const remaining = baselines[c].size - staleBaseline[c].length
    const note =
      target.state === 'compared' && target.sizes[c] !== null ? `, target ${target.sizes[c]}`
      : target.state === 'compared' ? ', target none (new class, seeding)'
      : target.state === 'bootstrap' ? ', target none (bootstrap)'
      : ''
    console.log(
      `bare-squad-id-authz [${c}]: ${remaining} file(s) with a typechecker-suppressed squad-scope ` +
      `capability check (baseline ${baselines[c].size}${note}).`,
    )
  }

  console.log(`bare-squad-id-authz: ${allExemptions.length} exempted call(s) in the tree.`)
  for (const ex of allExemptions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${ex.file}:${ex.line} — ${ex.reason}`)
  }

  let failed = false

  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.\n')
  } else if (target.state === 'compared') {
    for (const c of CLASSES) {
      if (target.sizes[c] !== null && baselines[c].size > target.sizes[c]) {
        failed = true
        console.error(`\nBASELINE [${c}] GREW: ${target.sizes[c]} -> ${baselines[c].size}. It may only shrink.`)
        console.error('Appending a file here is not a fix. Load a real SquadScope (loadSquadScope /')
        console.error('resolveSquadRef / a full Squad row) instead of suppressing the typechecker.\n')
      }
    }
  }

  for (const c of CLASSES) {
    if (offenders[c].length === 0) continue
    failed = true
    console.error(`\nNEW VIOLATION [${c}] — a squad-scope capability check must never be forced to`)
    console.error('accept a bare id via a typechecker suppression or an `as SquadScope`/`as any` cast:\n')
    for (const { file, violations } of offenders[c]) {
      for (const v of violations) console.error(`  ${file}:${v.line}  ${v.snippet}`)
    }
    console.error('')
    console.error('Load a real SquadScope with loadSquadScope(env, squadId), or pass a full Squad row —')
    console.error('never force a bare string past the compiler (mupot#1452 round 2 defect class).')
    console.error('If this genuinely cannot be avoided, add a same-line or line-above comment')
    console.error('`// bare-squad-id-exempt: <reason>` — it will be printed on every run, not hidden.')
    console.error('The baseline is a ratchet: it may shrink, never grow.\n')
  }

  const onTarget = targetFileSet()
  if (onTarget !== null) {
    for (const c of CLASSES) {
      const smuggled = [...baselines[c]].filter((rel) => !onTarget.has(rel)).sort()
      if (smuggled.length === 0) continue
      failed = true
      console.error(`\nBASELINED FILE IS NEW [${c}] — these are not on the merge target, so they`)
      console.error('are not pre-existing debt and cannot be baselined:\n')
      for (const f of smuggled) console.error(`  ${f}`)
      console.error('')
    }
  }

  for (const c of CLASSES) {
    if (staleBaseline[c].length === 0) continue
    failed = true
    console.error(`\nSTALE BASELINE [${c}] — these files no longer violate and must be removed from`)
    console.error('the baseline (a fixed file staying baselined would become a permanent exemption):\n')
    for (const f of staleBaseline[c]) console.error(`  ${f}`)
    console.error('')
  }

  if (failed) process.exit(1)
}
